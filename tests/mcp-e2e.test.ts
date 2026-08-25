import { execSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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

  it("redacts secrets in activity_record and goal_record before they hit the store", async () => {
    await client.tool("activity_record", {
      summary: "export GITHUB_TOKEN=ghp_supersecretvalue123 && deploy",
      detail: "curl -H 'Authorization: Bearer eyJsecretjwtpayload.aaa.bbb' https://api",
      type: "manual",
    });
    const list = await client.tool("activity_list", { limit: 5 });
    const dump = JSON.stringify(list);
    expect(dump).not.toContain("ghp_supersecretvalue123");
    expect(dump).not.toContain("eyJsecretjwtpayload");
    expect(dump).toContain("«redacted»");

    await client.tool("goal_create", {
      objective: "secret redaction in traces",
      slug: "e2e-redact",
      criteria: crit("ready", "ready"),
    });
    await client.tool("goal_record", {
      goal: "e2e-redact",
      summary: "set api_key=sk-live-shouldnotleak in config",
      result: "success",
    });
    const g = await client.tool("goal_get", { goal: "e2e-redact" });
    expect(JSON.stringify(g)).not.toContain("sk-live-shouldnotleak");
  });

  it("exposes the harness-neutral Pulse primitives without a delivery side effect", async () => {
    const listed = await client.rpc("tools/list", {});
    const names = listed.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "pulse_event_ingest",
      "pulse_checkpoint_publish",
      "pulse_status",
      "pulse_dispatch_plan",
      "pulse_projection_render",
    ]));
    expect(names).not.toContain("pulse_send");
  });

  it("exposes the provider-neutral iteration protocol without an agent runner or human auto-approval", async () => {
    const listed = await client.rpc("tools/list", {});
    const names = listed.result.tools.map((tool: { name: string }) => tool.name);
    expect(names).toEqual(expect.arrayContaining([
      "iteration_start",
      "iteration_status",
      "iteration_next",
      "iteration_checkpoint",
    ]));
    expect(names).not.toContain("iteration_accept");
    expect(names).not.toContain("iteration_run_agent");
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
    const created = await client.tool("goal_create", {
      objective: "ensure the changelog is dated",
      slug: "e2e-bv",
      criteria: crit("ready", "ready"),
    });
    // Audit fix 3: the learning contract is surfaced at create time — record
    // before the final assess, retroactive records accepted after convergence.
    expect(created.guidance).toMatch(/BEFORE the final assess/);
    expect(created.guidance).toMatch(/accepted after convergence/);
    const conv = await client.tool("goal_assess", { goal: "e2e-bv" });
    expect(conv.converged).toBe(true);
    expect(conv.goal.iterationsUsed).toBe(0); // the audit repro shape
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

  it("goal_update edits criteria in place over the wire — no need to fork a new goal (B2)", async () => {
    await client.tool("goal_create", {
      objective: "criteria can be refined in place",
      slug: "e2e-criteria-edit",
      criteria: crit("nope", "ready"),
    });

    const preConverge = await client.tool("goal_assess", { goal: "e2e-criteria-edit" });
    expect(preConverge.converged).toBe(false);

    // Fix the wrong criterion in place via editCriteria — the whole point of B2.
    const edited = await client.tool("goal_update", {
      goal: "e2e-criteria-edit",
      editCriteria: [
        {
          id: "c1",
          probe: { kind: "command", run: "echo nope", parse: "text" },
          assert: { op: "contains", value: "nope" },
        },
      ],
    });
    expect(edited.goal.criteria).toBe(1);
    expect(edited.criteria[0].id).toBe("c1");
    expect(edited.criteria[0].assert).toEqual({ op: "contains", value: "nope" });

    const converged = await client.tool("goal_assess", { goal: "e2e-criteria-edit" });
    expect(converged.converged).toBe(true);

    // Add a criterion post-convergence: must reopen the goal, not silently stay converged.
    const reopened = await client.tool("goal_update", {
      goal: "e2e-criteria-edit",
      addCriteria: [
        {
          description: "a second thing",
          probe: { kind: "command", run: "echo ready", parse: "text" },
          assert: { op: "contains", value: "ready" },
        },
      ],
    });
    expect(reopened.goal.status).toBe("active");
    expect(reopened.goal.criteria).toBe(2);

    const got = await client.tool("goal_get", { goal: "e2e-criteria-edit" });
    expect(got.goal.criteria.map((c: any) => c.id)).toEqual(["c1", "c2"]);
    // The edit landed in the trace/history so the learning loop sees it.
    expect(got.trace.some((r: any) => r.source === "system" && r.tool === "goal_update")).toBe(
      true,
    );

    // Plain goal_update calls with no criteria args are unaffected (backward compat).
    const plain = await client.tool("goal_update", {
      goal: "e2e-criteria-edit",
      objective: "criteria can be refined in place (renamed)",
    });
    expect(plain.criteria).toBeUndefined();
    expect(plain.goal.objective).toBe("criteria can be refined in place (renamed)");
  });

  it("stamps `project` at goal_create from the server's own cwd (belay ADR-35 cross-project scoping), surfaced in goal_get and goal_list", async () => {
    // The child server was spawned with no explicit `cwd` override, so it
    // inherits this test process's cwd — the package root, a real git repo.
    const expectedRoot = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

    await client.tool("goal_create", {
      objective: "cross-project scoping stamp",
      slug: "e2e-project-stamp",
      criteria: crit("ready", "ready"),
    });

    const got = await client.tool("goal_get", { goal: "e2e-project-stamp" });
    expect(got.goal.project).toBe(expectedRoot);
    expect(typeof got.goal.cwd).toBe("string");

    const listed = await client.tool("goal_list", { status: "active" });
    const summary = listed.goals.find((g: any) => g.slug === "e2e-project-stamp");
    expect(summary.project).toBe(expectedRoot);

    // An explicit cwd wins over the server's own — the escape hatch for a
    // caller that knows better than the server process's cwd.
    await client.tool("goal_create", {
      objective: "cross-project scoping explicit cwd",
      slug: "e2e-project-stamp-explicit",
      criteria: crit("ready", "ready"),
      cwd: "/tmp/not-this-repo",
    });
    const got2 = await client.tool("goal_get", { goal: "e2e-project-stamp-explicit" });
    expect(got2.goal.project).not.toBe(expectedRoot);
  });
});
