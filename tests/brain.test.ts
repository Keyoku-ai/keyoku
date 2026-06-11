// keyoku-engine bridge: knowledge mirroring + semantic search upgrade,
// driven through a fake engine speaking the real /api/v1 contract.
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { Brain } from "../src/brain.js";

const ENTRY = join(__dirname, "..", "dist", "index.js");

let engine: Server;
let engineUrl: string;
const seeded: Array<{ memories: Array<{ entity_id: string; content: string; type: string; tags: string[] }> }> = [];

let home: string;
let client: Client;

beforeAll(async () => {
  engine = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/v1/seed") {
        seeded.push(JSON.parse(body));
        res.end(JSON.stringify({ created: 1, ids: ["mem_1"] }));
      } else if (req.url === "/api/v1/search") {
        res.end(
          JSON.stringify({
            results: [
              {
                memory: { content: "[practice:demoapp] hook.mjs and hud.mjs change together" },
                score: 0.91,
              },
              { memory: { content: "no-subject-prefix entry" }, similarity: 0.42 },
            ],
          }),
        );
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  await new Promise<void>((resolve) => engine.listen(0, "127.0.0.1", resolve));
  const addr = engine.address();
  engineUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

  home = mkdtempSync(join(tmpdir(), "keyoku-brain-"));
  client = new Client({ name: "brain-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY, "serve"],
      env: {
        ...process.env,
        KEYOKU_HOME: home,
        KEYOKU_ENGINE_URL: engineUrl,
        KEYOKU_SLM_PROVIDER: "none",
      } as Record<string, string>,
      stderr: "ignore",
    }),
  );
});

afterAll(async () => {
  await client.close();
  await new Promise((resolve) => engine.close(resolve));
  rmSync(home, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text?: string }>)
    .filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  return JSON.parse(text);
}

describe("Brain client", () => {
  it("is disabled without KEYOKU_ENGINE_URL", () => {
    expect(Brain.fromEnv({})).toBeNull();
    expect(Brain.fromEnv({ KEYOKU_ENGINE_URL: "  " })).toBeNull();
  });

  it("parses subjects out of mirrored content and tolerates flat entries", async () => {
    const brain = Brain.fromEnv({ KEYOKU_ENGINE_URL: engineUrl })!;
    const hits = await brain.search("files that change together");
    expect(hits).not.toBeNull();
    expect(hits![0]).toEqual({
      subject: "practice:demoapp",
      fact: "hook.mjs and hud.mjs change together",
      score: 0.91,
    });
    expect(hits![1].subject).toBe("");
    expect(hits![1].score).toBe(0.42);
  });

  it("returns null on connection failure (callers fall back to local)", async () => {
    const dead = Brain.fromEnv({ KEYOKU_ENGINE_URL: "http://127.0.0.1:1" })!;
    expect(await dead.search("anything")).toBeNull();
  });
});

describe("engine integration through the MCP server", () => {
  it("mirrors knowledge_submit into the engine", async () => {
    const res = await call("knowledge_submit", {
      subject: "connector:github",
      kind: "connector",
      fact: "Rate limited at 5000 req/h",
    });
    expect(res.stored).toBe(true);
    // mirroring is fire-and-forget; give it a beat
    await new Promise((r) => setTimeout(r, 200));
    expect(seeded.length).toBeGreaterThan(0);
    const mem = seeded[0].memories[0];
    expect(mem.entity_id).toBe("keyoku-harness");
    expect(mem.content).toBe("[connector:github] Rate limited at 5000 req/h");
    expect(mem.type).toBe("CONTEXT");
    expect(mem.tags).toContain("agent-research");
  });

  it("upgrades knowledge_query text searches to engine semantics", async () => {
    const res = await call("knowledge_query", { query: "what changes together in demoapp?" });
    expect(res.method).toBe("engine-semantic");
    expect(res.entries[0].subject).toBe("practice:demoapp");
    expect(res.entries[0].score).toBeGreaterThan(0.9);
  });

  it("keeps subject-prefix queries local", async () => {
    const res = await call("knowledge_query", { subject: "connector:github" });
    expect(res.method).toBe("local");
    expect(res.entries[0].fact).toContain("Rate limited");
  });
});
