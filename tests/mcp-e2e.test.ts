import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Protocol-level regression lock: drives the BUILT server (dist/index.js) over real
// stdio JSON-RPC, exercising the build-then-verify → reuse → pitfalls loop end to end.
// `npm test` runs `tsup` first, so dist is fresh. Unit tests cover the engine; this
// covers the wire protocol an actual MCP client (Claude Code / Cursor / Codex) speaks.

const dist = fileURLToPath(new URL("../dist/index.js", import.meta.url));

function makeClient(home: string) {
  const child = spawn(process.execPath, [dist], {
    env: { ...process.env, KEYOKU_HOME: home },
  }) as ChildProcessWithoutNullStreams;
  const rl = createInterface({ input: child.stdout });
  const waiters = new Map<number, (v: any) => void>();
  rl.on("line", (l) => {
    let o: any;
    try {
      o = JSON.parse(l);
    } catch {
      return;
    }
    if (o.id != null && waiters.has(o.id)) {
      waiters.get(o.id)!(o);
      waiters.delete(o.id);
    }
  });
  let id = 0;
  const rpc = (method: string, params?: unknown): Promise<any> =>
    new Promise((res, rej) => {
      const myId = ++id;
      const t = setTimeout(() => rej(new Error(`rpc timeout: ${method}`)), 15000);
      waiters.set(myId, (v) => {
        clearTimeout(t);
        res(v);
      });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: myId, method, params }) + "\n");
    });
  const tool = async (name: string, args: unknown): Promise<any> => {
    const r = await rpc("tools/call", { name, arguments: args });
    const text = r.result?.content?.[0]?.text;
    try {
      return JSON.parse(text);
    } catch {
      return r.result ?? r.error;
    }
  };
  const notify = (method: string) =>
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n");
  return { child, rpc, tool, notify };
}

// echo <out> | contains <val>: "ready"/"ready" converges, "nope"/"ready" stays unmet.
const crit = (out: string, val: string) => [
  {
    description: "echo probe",
    probe: { kind: "command", run: `echo ${out}`, parse: "text" },
    assert: { op: "contains", value: val },
  },
];

describe("MCP protocol e2e — muscle memory", () => {
  let home: string;
  let client: ReturnType<typeof makeClient>;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), "keyoku-e2e-"));
    client = makeClient(home);
    await client.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e", version: "1" },
    });
    client.notify("notifications/initialized");
  });

  afterAll(() => {
    client.child.kill();
    rmSync(home, { recursive: true, force: true });
  });

  it("iterative run: captures step + pitfall, then reuses both on a similar goal", async () => {
    await client.tool("goal_create", {
      objective: "fix the flaky auth test",
      slug: "e2e-auth",
      criteria: crit("ready", "ready"),
    });
    await client.tool("goal_record", {
      goal: "e2e-auth",
      summary: "Tried bumping the timeout",
      result: "failure",
    });
    await client.tool("goal_record", {
      goal: "e2e-auth",
      summary: "Pinned the system clock",
      result: "success",
      tool: "Edit",
    });
    const conv = await client.tool("goal_assess", { goal: "e2e-auth" });
    expect(conv.converged).toBe(true);

    const wfs = await client.tool("workflow_list", {});
    const wf = wfs.workflows.find((w: any) => w.slug === "e2e-auth");
    expect(wf.steps.map((s: any) => s.summary)).toEqual(["Pinned the system clock"]);
    expect(wf.pitfalls).toEqual(["Tried bumping the timeout"]);

    await client.tool("goal_create", {
      objective: "fix the flaky auth integration test",
      slug: "e2e-auth-2",
      criteria: crit("nope", "ready"),
    });
    const rep = await client.tool("goal_assess", { goal: "e2e-auth-2" });
    expect(rep.converged).toBe(false);
    expect(rep.suggestedWorkflows.map((s: any) => s.slug)).toContain("e2e-auth");
    expect(rep.guidance).toContain("Pinned the system clock");
    expect(rep.guidance).toContain("avoid (failed before): Tried bumping the timeout");
  });

  it("build-then-verify: zero-action convergence promotes no hollow workflow, then a retroactive record does", async () => {
    await client.tool("goal_create", {
      objective: "ensure the changelog is dated",
      slug: "e2e-bv",
      criteria: crit("ready", "ready"),
    });
    const conv = await client.tool("goal_assess", { goal: "e2e-bv" });
    expect(conv.converged).toBe(true);
    expect(conv.guidance).toMatch(/goal_record/); // honest nudge, not a false "promoted" claim

    const before = await client.tool("workflow_list", {});
    expect(before.workflows.find((w: any) => w.slug === "e2e-bv")).toBeUndefined();

    const rec = await client.tool("goal_record", {
      goal: "e2e-bv",
      summary: "Dated the changelog section",
      tool: "Edit",
    });
    expect(rec.error).toBeFalsy(); // accepted retroactively, not rejected

    const after = await client.tool("workflow_list", {});
    const wf = after.workflows.find((w: any) => w.slug === "e2e-bv");
    expect(wf?.steps.map((s: any) => s.summary)).toEqual(["Dated the changelog section"]);
  });
});
