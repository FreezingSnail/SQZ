/**
 * AFMProvider — Apple Foundation Models on-device provider via the
 * afm-bridge unix socket.
 *
 * Zero-install path (macOS 26+): the Swift helper in swift/afm-bridge/ maps
 * a JSON Schema onto Foundation Models' `GenerationSchema` (structured-output
 * constraint support — verified during the spike via the bridge `check-schema`
 * command) and exposes the on-device model over a local unix socket.
 *
 * This client implements the `Provider` contract from types.ts. It is a thin
 * newline-delimited-JSON client over `net.Socket`; the bridge runs one request
 * per connection.
 *
 * Wire protocol (one LF-terminated JSON line each way):
 *   request  {"id": 1, "messages": [...], "schema": {...}}
 *            {"id": 1, "cmd": "ping"}            → availability probe
 *            {"id": 1, "cmd": "check-schema", "schema": {...}}
 *   response {"ok": true, "content": "<model JSON>"}
 *            {"ok": false, "error": "<message>"}
 *            {"cmd": "ping", "ok": true, "available": bool, "reason": string|null}
 *            {"cmd": "check-schema", "ok": bool, "error": string|null}
 *
 * Failure contract: throws on connect error / timeout / bridge error, so the
 * translator ladder falls back to RuleProvider → passthrough when AFM is
 * unavailable (the degraded path).
 */

import * as net from "node:net";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, unlinkSync } from "node:fs";
import type { ChatMessage, Provider } from "../types.js";
import { parseContent } from "./ollama.js";

export interface AFMOptions {
  /** Unix socket path of the afm-bridge. Env AFM_SOCKET overrides. */
  socketPath?: string;
  /** Per-request timeout ms. Default 15000 (AFM cold start is slow). */
  timeoutMs?: number;
  /** Timeout ms for availability probes. Default 2000. */
  pingTimeoutMs?: number;
}

export interface AFMAvailability {
  available: boolean;
  reason?: string;
}

/** Default socket path: $AFM_SOCKET, else ~/.afm-bridge.sock. */
export function defaultSocketPath(): string {
  return (
    process.env.AFM_SOCKET ??
    join(process.env.HOME ?? "/tmp", ".afm-bridge.sock")
  );
}

/** Absolute path to the Swift bridge package (repo-relative swift/afm-bridge). */
export function bridgeDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "swift", "afm-bridge");
}

/** Compiled bridge binary path. */
export function bridgeBinary(): string {
  return join(bridgeDir(), ".build", "debug", "afm-bridge");
}

interface BridgeResponse {
  ok?: boolean;
  error?: string;
  content?: string;
  available?: boolean;
  reason?: string;
  cmd?: string;
}

/** One request/response round-trip over the unix socket. Resolves to the parsed response. */
export function request(
  socketPath: string,
  payload: unknown,
  timeoutMs: number,
): Promise<BridgeResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;

    const cleanup = (err?: Error) => {
      if (settled) return;
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      if (err) reject(err);
    };

    socket.setTimeout(timeoutMs);
    socket.on("timeout", () => {
      cleanup(new Error(`afm request timed out after ${timeoutMs}ms`));
    });
    socket.on("error", (err) => {
      cleanup(new Error(`afm socket error: ${err.message}`));
    });
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      const line = buffer.slice(0, newline);
      let parsed: BridgeResponse;
      try {
        parsed = JSON.parse(line) as BridgeResponse;
      } catch (err) {
        cleanup(new Error(`afm invalid response: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      cleanup();
      resolve(parsed);
    });

    socket.write(`${JSON.stringify(payload)}\n`, (err) => {
      if (err) cleanup(new Error(`afm write failed: ${err.message}`));
    });
  });
}

/** Availability probe. Never throws: connection failure ⇒ unavailable. */
export async function ping(
  socketPath: string = defaultSocketPath(),
  timeoutMs = 2000,
): Promise<AFMAvailability> {
  try {
    const res = await request(socketPath, { cmd: "ping" }, timeoutMs);
    if (res.ok && typeof res.available === "boolean") {
      return { available: res.available, reason: res.reason };
    }
    return { available: false, reason: res.error ?? "bridge ping failed" };
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

/** Verify the bridge can map a JSON Schema onto FoundationModels' GenerationSchema. */
export async function checkSchema(
  schema: object,
  socketPath: string = defaultSocketPath(),
  timeoutMs = 5000,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await request(socketPath, { cmd: "check-schema", schema }, timeoutMs);
    return { ok: res.ok === true, error: res.error };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface BridgeLaunch {
  socketPath: string;
  child: ChildProcess;
  /** Kill the bridge and remove the socket file. */
  stop(): void;
}

export interface BridgeLaunchOptions {
  socketPath?: string;
  /** Build the bridge first (default true). Uses swift build in bridgeDir(). */
  build?: boolean;
  /** How long to wait for the socket file to appear, ms. Default 15_000. */
  readyTimeoutMs?: number;
}

/**
 * Build (optionally) and spawn the afm-bridge. Resolves once the unix socket
 * is accepting connections. Throws when swift is missing or the build fails —
 * callers (tests, scripts) treat that as "AFM unavailable".
 */
export async function launchBridge(options: BridgeLaunchOptions = {}): Promise<BridgeLaunch> {
  const socketPath = options.socketPath ?? defaultSocketPath();
  const doBuild = options.build ?? true;
  const readyTimeoutMs = options.readyTimeoutMs ?? 15_000;

  if (doBuild) {
    execFileSync("swift", ["build"], { cwd: bridgeDir(), stdio: "ignore" });
  }
  const child = spawn(bridgeBinary(), [socketPath], { stdio: "ignore" });

  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(socketPath)) {
      return {
        socketPath,
        child,
        stop: () => {
          child.kill();
          try {
            unlinkSync(socketPath);
          } catch {
            /* socket already gone */
          }
        },
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  child.kill();
  throw new Error(`afm-bridge did not open ${socketPath} within ${readyTimeoutMs}ms`);
}

export class AFMProvider implements Provider {
  readonly name = "afm";
  private readonly socketPath: string;
  private readonly timeoutMs: number;

  constructor(options: AFMOptions = {}) {
    this.socketPath = options.socketPath ?? defaultSocketPath();
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  getSocketPath(): string {
    return this.socketPath;
  }

  /** True when the bridge answers on the socket (regardless of model availability). */
  async ping(): Promise<boolean> {
    return (await ping(this.socketPath)).available;
  }

  /** Bridge reachable AND the on-device model is available (Apple Intelligence on). */
  async available(): Promise<AFMAvailability> {
    return ping(this.socketPath);
  }

  /**
   * Send messages + schema to the bridge. Resolves to the parsed JSON object,
   * or the raw content string when unparseable (translator.normalize() decides).
   * Throws on transport error / timeout / bridge error → RuleProvider fallback.
   */
  async generate(messages: ChatMessage[], schema: object): Promise<unknown> {
    const res = await request(
      this.socketPath,
      { id: 1, messages, schema },
      this.timeoutMs,
    );
    if (res.ok !== true) {
      throw new Error(`afm error: ${res.error ?? "unknown bridge error"}`);
    }
    return parseContent(res.content ?? "");
  }
}