import Dispatch
import Foundation
import FoundationModels

/// Timeout applied to a single model generation inside the bridge so a
/// stuck request never pins the process. The TS client enforces its own
/// (shorter) budget and treats a dropped connection as provider-down.
private let generationTimeout: TimeInterval = 120

/// Newline-delimited JSON request/response over a local unix socket.
///
/// Request  (one line):    {"id": 1, "messages": [{"role": "...", "content": "..."}], "schema": {...}}
///                          {"id": 1, "cmd": "ping"}
/// Response (one line):    {"id": 1, "ok": true, "content": "<model output>"}
///                          {"id": 1, "ok": false, "error": "<message>"}
///                          {"cmd": "ping", "ok": true, "available": true, "reason": null}
///
/// One request per connection; the bridge closes the connection after
/// answering. Framing is a single LF-terminated JSON line.
///
/// Implemented with raw POSIX sockets (not Network.framework, which has no
/// unix-domain listener on macOS) — zero extra dependencies, SDK-only.
final class BridgeServer {
    private let socketPath: String
    private var serverFD: Int32 = -1
    private var running = false

    init(socketPath: String) {
        self.socketPath = socketPath
    }

    func start() throws {
        unlink(socketPath) // remove stale socket from a previous crashed run

        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw BridgeError.startup("socket() failed: errno \(errno)") }

        let pathBytes = Array(socketPath.utf8)
        let pathCapacity = MemoryLayout.size(ofValue: sockaddr_un().sun_path)
        guard pathBytes.count < pathCapacity else {
            close(fd)
            throw BridgeError.startup("socket path too long: \(socketPath)")
        }

        var addr = sockaddr_un()
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        addr.sun_family = sa_family_t(AF_UNIX)
        // sun_path offset is 2 on Darwin (sun_len + sun_family, both 1 byte).
        // NOTE: writing the path via memcpy into the struct pointer — the
        // CLT toolchain crashes IRGen (signal 11) on `&addr.sun_path.0`.
        let pathOffset = 2
        let bindResult: Int32 = Data(pathBytes).withUnsafeBytes { (raw: UnsafeRawBufferPointer) -> Int32 in
            _ = withUnsafeMutablePointer(to: &addr) { addrPtr in
                // NOTE: advance in BYTES via UnsafeMutableRawPointer — a typed
                // pointer's advanced(by:) steps whole structs, not bytes.
                let target = UnsafeMutableRawPointer(addrPtr).advanced(by: pathOffset)
                target.copyMemory(from: raw.baseAddress!, byteCount: pathBytes.count)
            }
            return withUnsafePointer(to: &addr) { ptr in
                ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                    bind(fd, sa, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
        }
        guard bindResult == 0 else {
            close(fd)
            throw BridgeError.startup("bind() failed: errno \(errno)")
        }
        guard listen(fd, 16) == 0 else {
            close(fd)
            throw BridgeError.startup("listen() failed: errno \(errno)")
        }

        serverFD = fd
        running = true
        DispatchQueue.global().async { [weak self] in self?.acceptLoop() }
        FileHandle.standardError.write(Data("afm-bridge listening on \(socketPath)\n".utf8))
    }

    func stop() {
        running = false
        if serverFD >= 0 {
            close(serverFD)
            serverFD = -1
        }
        unlink(socketPath)
    }

    // MARK: - Accept / connection handling

    private func acceptLoop() {
        while running {
            let client = accept(serverFD, nil, nil)
            guard client >= 0 else {
                if !running { break }
                continue
            }
            DispatchQueue.global().async { [weak self] in self?.handle(client) }
        }
    }

    private func handle(_ client: Int32) {
        defer { close(client) }

        guard let line = readLine(client) else {
            writeResponse(client, ["ok": false, "error": "empty request"])
            return
        }
        guard
            let payload = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any]
        else {
            writeResponse(client, ["ok": false, "error": "invalid JSON request"])
            return
        }

        let semaphore = DispatchSemaphore(value: 0)
        let box = ResultBox()
        Task {
            box.result = await self.process(payload)
            semaphore.signal()
        }
        if semaphore.wait(timeout: .now() + .seconds(Int(generationTimeout) + 5)) != .success {
            writeResponse(client, ["ok": false, "error": "bridge timeout"])
            return
        }
        writeResponse(client, box.result)
    }

    private func readLine(_ fd: Int32) -> Data? {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 65536)
        while data.count < 262_144 {
            let n = read(fd, &buffer, buffer.count)
            if n <= 0 { break }
            data.append(contentsOf: buffer[0..<n])
            if data.firstIndex(of: 0x0A) != nil { break }
        }
        guard let newline = data.firstIndex(of: 0x0A) else { return nil }
        return data[..<newline]
    }

    private func writeResponse(_ fd: Int32, _ response: [String: Any]) {
        guard let json = try? JSONSerialization.data(withJSONObject: response) else { return }
        var payload = Data(json)
        payload.append(0x0A)
        payload.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
            var written = 0
            while written < payload.count {
                let n = write(fd, raw.baseAddress!.advanced(by: written), payload.count - written)
                if n <= 0 { break }
                written += n
            }
        }
    }

    // MARK: - Request processing

    private func process(_ payload: [String: Any]) async -> [String: Any] {
        // Availability probe — never loads or runs the model.
        if let cmd = payload["cmd"] as? String, cmd == "ping" {
            let model = SystemLanguageModel.default
            var response: [String: Any] = ["cmd": "ping", "ok": true]
            if model.isAvailable {
                response["available"] = true
            } else {
                response["available"] = false
                response["reason"] = String(describing: model.availability)
            }
            return response
        }

        // Schema constraint check — verifies the JSON-Schema converter against
        // the Foundation Models GenerationSchema API without invoking a model.
        if let cmd = payload["cmd"] as? String, cmd == "check-schema" {
            guard let schema = payload["schema"] as? [String: Any] else {
                return ["cmd": "check-schema", "ok": false, "error": "missing schema"]
            }
            do {
                let root = try convertSchema(schema)
                _ = try GenerationSchema(root: root, dependencies: [])
                return ["cmd": "check-schema", "ok": true]
            } catch {
                return ["cmd": "check-schema", "ok": false, "error": String(describing: error)]
            }
        }

        guard let schema = payload["schema"] as? [String: Any] else {
            return ["ok": false, "error": "missing schema"]
        }
        guard let messages = payload["messages"] as? [[String: Any]] else {
            return ["ok": false, "error": "missing messages"]
        }

        do {
            let root = try convertSchema(schema)
            let generationSchema = try GenerationSchema(root: root, dependencies: [])

            let prompt = messages.compactMap { m -> String? in
                guard let role = m["role"] as? String, let content = m["content"] as? String else { return nil }
                return "[\(role)]\n\(content)"
            }.joined(separator: "\n\n")
            guard !prompt.isEmpty else { return ["ok": false, "error": "empty prompt"] }

            let session = LanguageModelSession()
            let response = try await withTimeout(UInt64(generationTimeout) * 1_000_000_000) {
                try await session.respond(to: prompt, schema: generationSchema)
            }
            return ["ok": true, "content": response.content.jsonString]
        } catch {
            return ["ok": false, "error": String(describing: error)]
        }
    }
}

private enum BridgeError: Error, CustomStringConvertible {
    case startup(String)
    var description: String {
        switch self {
        case .startup(let message): return message
        }
    }
}

private final class ResultBox {
    var result: [String: Any] = ["ok": false, "error": "internal error"]
}

private func withTimeout<T>(_ nanoseconds: UInt64, _ body: @escaping () async throws -> T) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await body() }
        group.addTask {
            try await Task.sleep(nanoseconds: nanoseconds)
            throw BridgeError.startup("generation timed out")
        }
        guard let result = try await group.next() else {
            throw BridgeError.startup("empty result")
        }
        group.cancelAll()
        return result
    }
}