import { createServer, type Server } from "node:http";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { parseOutput, runProbe } from "../src/probes.js";
import type { ConnectorManager } from "../src/connectors.js";

// Probe tests never touch connectors except the mcp kind, which gets a stub.
const noConnectors = {} as ConnectorManager;

describe("parseOutput", () => {
  it("auto parses JSON and falls back to text", () => {
    expect(parseOutput('{"a":1}').value).toEqual({ a: 1 });
    expect(parseOutput("plain text").value).toBe("plain text");
    expect(parseOutput("plain text").parseError).toBeUndefined();
  });

  it("strict json reports parse errors", () => {
    expect(parseOutput("not json", "json").parseError).toContain("invalid JSON");
  });

  it("number parses and rejects", () => {
    expect(parseOutput("  42\n", "number").value).toBe(42);
    expect(parseOutput("abc", "number").parseError).toContain("not a number");
  });

  it("number rejects empty output (Number('') === 0 must not pass eq 0)", () => {
    expect(parseOutput("", "number").parseError).toContain("not a number");
    expect(parseOutput("   \n", "number").parseError).toContain("not a number");
  });

  it("text keeps raw trimmed output", () => {
    expect(parseOutput('  {"a":1}  ', "text").value).toBe('{"a":1}');
  });
});

describe("command probes", () => {
  it("captures stdout, parses JSON, exit code 0", async () => {
    const envelope = await runProbe(
      { kind: "command", run: `echo '{"ok":true,"n":3}'` },
      noConnectors,
    );
    expect(envelope.exitCode).toBe(0);
    expect(envelope.output).toEqual({ ok: true, n: 3 });
    expect(envelope.error).toBeUndefined();
  });

  it("captures non-zero exit codes without throwing", async () => {
    const envelope = await runProbe(
      { kind: "command", run: "echo partial && exit 3" },
      noConnectors,
    );
    expect(envelope.exitCode).toBe(3);
    expect(envelope.output).toBe("partial");
    expect(envelope.error).toContain("exit");
  });

  it("times out runaway commands", async () => {
    const envelope = await runProbe(
      { kind: "command", run: "sleep 5", timeoutMs: 200 },
      noConnectors,
    );
    expect(envelope.error).toContain("timed out");
  });

  it("times out even commands that trap SIGTERM", async () => {
    const started = Date.now();
    const envelope = await runProbe(
      { kind: "command", run: "trap '' TERM; sleep 5", timeoutMs: 300 },
      noConnectors,
    );
    expect(envelope.error).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it("respects cwd and number parsing", async () => {
    const envelope = await runProbe(
      { kind: "command", run: "ls | wc -l", cwd: "/", parse: "number" },
      noConnectors,
    );
    expect(typeof envelope.output).toBe("number");
  });
});

describe("http probes", () => {
  let server: Server;
  let base: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === "/json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ healthy: true, replicas: 2 }));
      } else if (req.url === "/slow") {
        // Never responds; lets the probe timeout fire.
      } else {
        res.writeHead(404);
        res.end("nope");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });

  afterAll(() => {
    server.closeAllConnections?.();
    server.close();
  });

  it("returns parsed body and status", async () => {
    const envelope = await runProbe({ kind: "http", url: `${base}/json` }, noConnectors);
    expect(envelope.status).toBe(200);
    expect(envelope.output).toEqual({ healthy: true, replicas: 2 });
  });

  it("non-2xx is still observable (status + body) AND flagged as a probe failure", async () => {
    const envelope = await runProbe({ kind: "http", url: `${base}/missing` }, noConnectors);
    expect(envelope.status).toBe(404);
    expect(envelope.output).toBe("nope");
    // A 4xx/5xx must set the transport error so the engine can't silently
    // converge on a matching body while the service returned an error status.
    expect(envelope.error).toContain("HTTP 404");
  });

  it("times out and reports the failure in the envelope", async () => {
    const envelope = await runProbe(
      { kind: "http", url: `${base}/slow`, timeoutMs: 200 },
      noConnectors,
    );
    expect(envelope.output).toBeNull();
    expect(envelope.error).toContain("timed out");
  });

  it("connection refused surfaces as an envelope error", async () => {
    const envelope = await runProbe(
      { kind: "http", url: "http://127.0.0.1:1/none", timeoutMs: 2000 },
      noConnectors,
    );
    expect(envelope.error).toContain("failed");
  });
});

describe("mcp probes", () => {
  it("routes through the connector manager and parses output", async () => {
    const stub = {
      callTool: async () => ({ text: '{"items":[1,2]}', isError: false }),
    } as unknown as ConnectorManager;
    const envelope = await runProbe(
      { kind: "mcp", connector: "stub", tool: "list", args: {} },
      stub,
    );
    expect(envelope.output).toEqual({ items: [1, 2] });
  });

  it("connector failures surface in the envelope", async () => {
    const stub = {
      callTool: async () => {
        throw new Error("boom");
      },
    } as unknown as ConnectorManager;
    const envelope = await runProbe(
      { kind: "mcp", connector: "stub", tool: "list" },
      stub,
    );
    expect(envelope.output).toBeNull();
    expect(envelope.error).toContain("boom");
  });
});
