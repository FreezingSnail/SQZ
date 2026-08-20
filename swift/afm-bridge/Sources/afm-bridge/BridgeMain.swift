import Foundation

/// Entry point. Socket path: first CLI argument, else $AFM_SOCKET, else
/// ~/.afm-bridge.sock.
@main
struct BridgeMain {
    static func main() {
        let args = CommandLine.arguments
        let socketPath: String
        if args.count > 1 {
            socketPath = args[1]
        } else if let env = ProcessInfo.processInfo.environment["AFM_SOCKET"], !env.isEmpty {
            socketPath = env
        } else {
            socketPath = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".afm-bridge.sock").path
        }

        let server = BridgeServer(socketPath: socketPath)
        do {
            try server.start()
        } catch {
            FileHandle.standardError.write(Data("afm-bridge failed to start: \(error)\n".utf8))
            exit(1)
        }

        // Keep the process alive; NWListener callbacks run on their own queue.
        dispatchMain()
    }
}