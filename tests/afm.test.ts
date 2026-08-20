/**
 * AFMProvider tests.
 *
 * Unit tests mock the bridge with a local net.Socket server (no Swift, no
 * model). One integration test builds + launches the real afm-bridge and
 * probes availability + schema-constraint support — it skips gracefully when
 * swift/the bridge are unavailable so `npm test` stays green anywhere.
 */

import { createServer, type Server } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  AFMProvider,
  bridgeDir,
  checkSchema,
  launchBridge,
  ping,
  request,
} from "../src/providers/afm.js";
import sqzSchema from "../sqz-schema.json" with { type: "json" };
import type { ChatMessage } from "../src/types.js";

const MOCK_SOCKET = join(import.meta.dirname, ".afm-mock.sock");
const IT_SOCKET = join(import.meta.dirname, ".afm-bridge-it.sock");

const messages: ChatMessage[] = [
  { role: "system", content: JSON.stringify({ task: "compress-prose-to-sqz" }) },
  { role: "user", content: "Refactor src/a.ts, preserve behavior." },
];

const SCHEMA = { type: "object", required: ["v"] };

function removeSocket(path: string) {
  try {
    unlinkSync(path);
  } catch {
    /* not present */
  }
}

/** Serve a canned response for every request line. */
function mockBridge(
  socketPath: string,
  respond: (req: { cmd?: string; messages?: unknown; schema?: unknown }) => string,
): Promise<Server> {
  removeSocket(socketPath);
  const server = createServer((socket) => {
    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      const req = JSON.parse(buffer.slice(0, nl)) as { cmd?: string; messages?: unknown; schema?: unknown };
      socket.end(`${respond(req)}\n`);
    });
  });
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(socketPath, () => resolve(server));
  });
}

afterEach(() => {
  removeSocket(MOCK_SOCKET);
  removeSocket(IT_SOCKET);
});

describe("AFMProvider over a mocked bridge socket", () => {
  it("sends messages + schema and returns the parsed payload", async () => {
    const server = await mockBridge(MOCK_SOCKET, (req) => {
      expect(req.messages).toEqual(messages);
      expect(req.schema).toEqual(SCHEMA);
      return JSON.stringify({ ok: true, content: '{"v":1,"mode":"refactor"}' });
    });

    const provider = new AFMProvider({ socketPath: MOCK_SOCKET, timeoutMs: 2000 });
    const result = (await provider.generate(messages, SCHEMA)) as { v: number };
    expect(result.v).toBe(1);
    server.close();
  });

  it("parses fenced JSON content like the ollama provider", async () => {
    const server = await mockBridge(MOCK_SOCKET, () =>
      JSON.stringify({ ok: true, content: "```json\n{\"v\":1}\n```" }),
    );
    const provider = new AFMProvider({ socketPath: MOCK_SOCKET, timeoutMs: 2000 });
    const result = (await provider.generate(messages, SCHEMA)) as { v: number };
    expect(result.v).toBe(1);
    server.close();
  });

  it("returns the raw string when the model output is unparseable", async () => {
    const server = await mockBridge(MOCK_SOCKET, () =>
      JSON.stringify({ ok: true, content: "sorry, no json here" }),
    );
    const provider = new AFMProvider({ socketPath: MOCK_SOCKET, timeoutMs: 2000 });
    expect(await provider.generate(messages, SCHEMA)).toBe("sorry, no json here");
    server.close();
  });

  it("throws when the bridge reports an error (→ RuleProvider fallback)", async () => {
    const server = await mockBridge(MOCK_SOCKET, () =>
      JSON.stringify({ ok: false, error: "missing schema" }),
    );
    const provider = new AFMProvider({ socketPath: MOCK_SOCKET, timeoutMs: 2000 });
    await expect(provider.generate(messages, SCHEMA)).rejects.toThrow(/missing schema/);
    server.close();
  });

  it("throws on connect failure when no bridge is listening", async () => {
    removeSocket(MOCK_SOCKET);
    const provider = new AFMProvider({ socketPath: MOCK_SOCKET, timeoutMs: 1000 });
    await expect(provider.generate(messages, SCHEMA)).rejects.toThrow(/socket error/);
  });

  it("throws on timeout when the bridge never answers", async () => {
    removeSocket(MOCK_SOCKET);
    const server = createServer((socket) => {
      socket.on("data", () => {
        /* never respond */
      });
    });
    await new Promise<void>((resolve) => server.listen(MOCK_SOCKET, () => resolve()));
    const provider = new AFMProvider({ socketPath: MOCK_SOCKET, timeoutMs: 300 });
    await expect(provider.generate(messages, SCHEMA)).rejects.toThrow(/timed out/);
    server.close();
  });
});

describe("AFM availability probes", () => {
  it("ping() reports available when the bridge says so", async () => {
    const server = await mockBridge(MOCK_SOCKET, (req) => {
      expect(req.cmd).toBe("ping");
      return JSON.stringify({ cmd: "ping", ok: true, available: true, reason: null });
    });
    expect(await ping(MOCK_SOCKET)).toEqual({ available: true, reason: null });
    server.close();
  });

  it("ping() reports unavailable without throwing when nothing is listening", async () => {
    removeSocket(MOCK_SOCKET);
    const result = await ping(MOCK_SOCKET, 500);
    expect(result.available).toBe(false);
    expect(result.reason).toBeTruthy();
  });

  it("checkSchema() verifies the JSON-Schema constraint mapping", async () => {
    const server = await mockBridge(MOCK_SOCKET, (req) => {
      expect(req.cmd).toBe("check-schema");
      return JSON.stringify({ cmd: "check-schema", ok: true });
    });
    expect(await checkSchema(SCHEMA, MOCK_SOCKET)).toEqual({ ok: true, error: undefined });
    server.close();
  });
});

describe("afm-bridge integration (skips when unavailable)", () => {
  it("builds the bridge, probes availability, and verifies structured-output support", async (ctx) => {
    // Feature-detect: no swift / no bridge source ⇒ skip, not fail.
    let launched: Awaited<ReturnType<typeof launchBridge>>;
    try {
      launched = await launchBridge({ socketPath: IT_SOCKET, readyTimeoutMs: 30_000 });
    } catch (err) {
      ctx.skip(`afm-bridge unavailable: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    try {
      // Never invokes the model: ping is an availability probe.
      const availability = await ping(IT_SOCKET, 5000);
      expect(typeof availability.available).toBe("boolean");
      if (!availability.available) {
        // Apple Intelligence disabled or model not eligible — documented, still a pass.
        expect(availability.reason).toBeTruthy();
      }

      // Structured-output constraint verification against the real sqz-schema.json.
      const schemaCheck = await checkSchema(sqzSchema as object, IT_SOCKET, 10_000);
      expect(schemaCheck.ok).toBe(true);
    } finally {
      launched.stop();
    }
  });
});