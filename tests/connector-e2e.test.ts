// Plug-and-play connector validation over real MCP stdio: register a fake
// external MCP server, call it, verify activity feeds the learning loop,
// verify the autonomy gate holds for direct calls AND workflow steps.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENTRY = join(__dirname, "..", "dist", "index.js");
const FIXTURE = join(__dirname, "fixtures", "fake-connector.mjs");

let home: string;
let client: Client;

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = Array.isArray(result.content) ? result.content : [];
  return content
    .filter((p): p is { type: "text"; text: string } => (p as { type?: string }).type === "text")
    .map((p) => p.text)
    .join("\n");
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const result = await client.callTool({ name, arguments: args });
  const text = textOf(result);
  try {
    return { ...JSON.parse(text), _raw: text, _isError: result.isError === true };
  } catch {
    return { _raw: text, _isError: result.isError === true };
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "keyoku-conn-e2e-"));
  client = new Client({ name: "conn-e2e-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY, "serve"],
      env: { ...process.env, KEYOKU_HOME: home, KEYOKU_SLM_PROVIDER: "none" } as Record<string, string>,
      stderr: "ignore",
    }),
  );
}, 20_000);

afterAll(async () => {
  await client.close();
  rmSync(home, { recursive: true, force: true });
});

describe("connector plug-and-play", () => {
  it("registers an external MCP server and discovers its tools", async () => {
    const added = await call("connector_add", {
      name: "fake-github",
      transport: { type: "stdio", command: process.execPath, args: [FIXTURE] },
    });
    expect(added._isError).toBe(false);
    expect(added.connected).toBe(true);
    expect(added.tools).toHaveLength(2);
    expect(added.autonomy).toBe("autonomous");
  });

  it("calls a connector tool and records it as activity", async () => {
    const res = await call("connector_call", { name: "fake-github", tool: "repo_list" });
    expect(res._isError).toBe(false);
    expect(res._raw).toContain("keyoku-engine");

    const activity = await call("activity_list", { limit: 10 });
    const recorded = activity.events.find(
      (e: any) => e.tool === "connector_call" && e.summary.includes("repo_list"),
    );
    expect(recorded).toBeTruthy();
    expect(JSON.parse(recorded.detail).connector).toBe("fake-github");
  });
});

describe("autonomy gate", () => {
  it("queues direct calls for approval when autonomy is 'approve'", async () => {
    await call("connector_set_autonomy", { name: "fake-github", autonomy: "approve" });
    const res = await call("connector_call", {
      name: "fake-github",
      tool: "issue_create",
      args: { title: "gated issue" },
    });
    expect(res.executed).toBe(false);
    expect(typeof res.queued).toBe("string");

    const approved = await call("approval_approve", { id: res.queued });
    expect(JSON.stringify(approved)).toContain("created issue #42");
  });

  it("pauses workflow mcp_call steps for approval instead of bypassing the gate", async () => {
    await call("workflow_approve", {
      slug: "file-issue",
      name: "File release issue",
      description: "Files the release tracking issue",
      steps: [
        { type: "mcp_call", summary: "file issue", connector: "fake-github", tool: "issue_create", args: { title: "Release" } },
      ],
    });

    const run = await call("workflow_execute", { slug: "file-issue" });
    expect(run.waiting_for).toBe("human");
    expect(typeof run.approval_id).toBe("string");
    expect(run.execution.status).toBe("waiting_human");

    const approved = await call("approval_approve", { id: run.approval_id });
    expect(JSON.stringify(approved)).toContain("created issue #42");

    const done = await call("execution_complete", {
      id: run.execution.id,
      step_index: 0,
      result: "approved and executed via approval queue",
    });
    expect(done.completed).toBe(true);
  });

  it("executes workflow mcp_call steps directly when autonomy is 'autonomous'", async () => {
    await call("connector_set_autonomy", { name: "fake-github", autonomy: "autonomous" });
    const run = await call("workflow_execute", { slug: "file-issue" });
    expect(run.completed).toBe(true);
    expect(run.execution.steps[0].result).toContain("created issue #42");
  });

  it("fails workflow steps cleanly when autonomy is 'observe'", async () => {
    await call("connector_set_autonomy", { name: "fake-github", autonomy: "observe" });
    const run = await call("workflow_execute", { slug: "file-issue" });
    expect(run.failed_at).toBe(0);
    expect(run.execution.status).toBe("failed");
  });
});
