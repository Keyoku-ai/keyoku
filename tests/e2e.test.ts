import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENTRY = join(__dirname, "..", "dist", "index.js");

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
    return { ...JSON.parse(text), _isError: result.isError === true };
  } catch {
    return { _raw: text, _isError: result.isError === true };
  }
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "keyoku-e2e-"));
  client = new Client({ name: "e2e-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY, "serve"],
      env: { ...process.env, KEYOKU_HOME: home } as Record<string, string>,
      stderr: "ignore",
    }),
  );
});

afterAll(async () => {
  await client.close();
  rmSync(home, { recursive: true, force: true });
});

describe("keyoku-harness over MCP stdio", () => {
  it("exposes the full tool surface and the convergence protocol", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "activity_list",
        "activity_record",
        "approval_approve",
        "approval_deny",
        "approval_list",
        "audit_list",
        "connector_add",
        "connector_call",
        "connector_list",
        "connector_remove",
        "connector_set_autonomy",
        "connector_tools",
        "execution_complete",
        "execution_list",
        "goal_assess",
        "goal_create",
        "goal_delete",
        "goal_get",
        "goal_list",
        "goal_record",
        "goal_update",
        "harness_learn",
        "harness_status",
        "knowledge_query",
        "knowledge_submit",
        "observation_list",
        "pattern_list",
        "workflow_approve",
        "workflow_execute",
        "workflow_list",
        "workflow_suggest",
        "workflow_template_delete",
        "workflow_template_list",
      ].sort(),
    );
    expect(client.getInstructions()).toContain("convergence harness");
    expect(client.getInstructions()).toContain("approval_approve");
  });

  it("walks a full convergence loop: create → assess → act → record → assess", async () => {
    const state = join(home, "demo-state.txt");
    writeFileSync(state, "pending");

    const created = await call("goal_create", {
      objective: "demo state file reports ready",
      slug: "e2e-demo",
      autonomy: "autonomous",
      maxIterations: 5,
      criteria: [
        {
          description: "state file says ready",
          probe: { kind: "command", run: `cat ${state}`, parse: "text" },
          assert: { op: "eq", value: "ready" },
        },
        {
          description: "state file exists (exit 0)",
          probe: { kind: "command", run: `cat ${state}`, parse: "text" },
          assert: { path: "exitCode", op: "eq", value: 0 },
        },
      ],
    });
    expect(created._isError).toBe(false);
    expect(created.goal.slug).toBe("e2e-demo");
    expect(created.guidance).toContain("goal_assess");

    const baseline = await call("goal_assess", { goal: "e2e-demo" });
    expect(baseline.converged).toBe(false);
    expect(baseline.unmetCount).toBe(1);
    expect(baseline.guidance).toContain("autonomous");

    // Act as the agent would, then record.
    writeFileSync(state, "ready");
    const recorded = await call("goal_record", {
      goal: "e2e-demo",
      summary: "Wrote 'ready' into the demo state file",
      tool: "Bash",
    });
    expect(recorded._isError).toBe(false);
    expect(recorded.guidance).toContain("goal_assess");

    const final = await call("goal_assess", { goal: "e2e-demo" });
    expect(final.converged).toBe(true);
    expect(final.goal.status).toBe("converged");
    expect(final.guidance).toContain("CONVERGED");

    const workflows = await call("workflow_list", {});
    expect(workflows.count).toBe(1);
    expect(workflows.workflows[0].slug).toBe("e2e-demo");
    expect(workflows.workflows[0].stats.convergences).toBe(1);
  });

  it("supports the connector fabric — the harness as its own connector", async () => {
    const added = await call("connector_add", {
      name: "keyoku-self",
      transport: {
        type: "stdio",
        command: process.execPath,
        args: [ENTRY, "serve"],
        env: { KEYOKU_HOME: home },
      },
      description: "the harness pointed at itself",
    });
    expect(added._isError).toBe(false);
    expect(added.connected).toBe(true);
    expect(added.tools.map((t: { name: string }) => t.name)).toContain("harness_status");

    const proxied = await call("connector_call", {
      name: "keyoku-self",
      tool: "harness_status",
      args: {},
    });
    expect(proxied._isError).toBe(false);
    expect(proxied.home).toBe(home);

    // An mcp probe as a success criterion, straight through the fabric.
    const created = await call("goal_create", {
      objective: "harness reports at least one learned workflow",
      slug: "meta-goal",
      criteria: [
        {
          description: "workflow count >= 1",
          probe: {
            kind: "mcp",
            connector: "keyoku-self",
            tool: "workflow_list",
            args: {},
          },
          assert: { path: "output.count", op: "gte", value: 1 },
        },
      ],
    });
    expect(created._isError).toBe(false);

    const report = await call("goal_assess", { goal: "meta-goal" });
    expect(report.converged).toBe(true);

    const removed = await call("connector_remove", { name: "keyoku-self" });
    expect(removed.removed).toBe("keyoku-self");
  });

  it("reports clean errors for unknown goals and bad input", async () => {
    const missing = await call("goal_assess", { goal: "does-not-exist" });
    expect(missing._isError).toBe(true);
    expect(missing.error).toContain("does-not-exist");

    const empty = await call("goal_create", {
      objective: "vague vibes",
      criteria: [],
    });
    expect(empty._isError).toBe(true);
    // The engine's curated message must reach the agent, not a raw zod dump.
    expect(empty.error).toContain("machine-checkable");
  });

  it("redacts connector credentials in connector_list", async () => {
    const added = await call("connector_add", {
      name: "secretive",
      transport: {
        type: "stdio",
        command: process.execPath,
        args: [ENTRY, "serve"],
        env: { KEYOKU_HOME: home, API_TOKEN: "super-secret-value" },
      },
    });
    expect(added._isError).toBe(false);

    const listed = await call("connector_list", {});
    const conn = listed.connectors.find((c: { name: string }) => c.name === "secretive");
    expect(conn.transport.env.API_TOKEN).not.toContain("super-secret-value");
    expect(JSON.stringify(listed)).not.toContain("super-secret-value");

    await call("connector_remove", { name: "secretive" });
  });

  it("rejects a connector_add that cannot connect, without registering it", async () => {
    const bad = await call("connector_add", {
      name: "broken",
      transport: { type: "stdio", command: "/no/such/binary-xyz" },
    });
    expect(bad._isError).toBe(true);

    const listed = await call("connector_list", {});
    expect(listed.connectors.map((c: { name: string }) => c.name)).not.toContain("broken");
  });

  it("harness_status summarizes the session", async () => {
    const status = await call("harness_status", {});
    expect(status.home).toBe(home);
    expect(status.goals.total).toBeGreaterThanOrEqual(2);
    expect(status.workflows.map((w: { slug: string }) => w.slug)).toContain("e2e-demo");
  });

  it("M2: harness_learn mines patterns and surfaces them via pattern_list and observations", async () => {
    const learned = await call("harness_learn", {});
    expect(learned._isError).toBe(false);
    expect(learned.method).toBe("heuristic"); // no SLM keys in test env

    const patterns = await call("pattern_list", {});
    expect(patterns._isError).toBe(false);

    const observations = await call("observation_list", { goal: "e2e-demo" });
    expect(observations._isError).toBe(false);
    expect(observations.transitions.convergences).toBeGreaterThanOrEqual(1);
    expect(observations.digest).toContain("convergence");
  });

  it("M4: autonomy gating queues calls for approval, and approval executes them", async () => {
    const added = await call("connector_add", {
      name: "gated-self",
      transport: {
        type: "stdio",
        command: process.execPath,
        args: [ENTRY, "serve"],
        env: { KEYOKU_HOME: home },
      },
      autonomy: "approve",
    });
    expect(added._isError).toBe(false);
    expect(added.autonomy).toBe("approve");

    // The call must queue, not execute.
    const gated = await call("connector_call", {
      name: "gated-self",
      tool: "harness_status",
      args: {},
    });
    expect(gated.executed).toBe(false);
    expect(gated.queued).toMatch(/^apr_/);

    const pending = await call("approval_list", { status: "pending" });
    expect(pending.approvals.map((a: { id: string }) => a.id)).toContain(gated.queued);

    // Human approves → the queued call executes.
    const decided = await call("approval_approve", { id: gated.queued });
    expect(decided._isError).toBe(false);
    expect(decided.approval.status).toBe("executed");
    expect(decided.approval.result).toContain(home);

    // Observe-level connectors refuse outright.
    await call("connector_set_autonomy", { name: "gated-self", autonomy: "observe" });
    const refused = await call("connector_call", {
      name: "gated-self",
      tool: "harness_status",
      args: {},
    });
    expect(refused.executed).toBe(false);
    expect(refused.queued).toBeUndefined();
    expect(refused.guidance).toContain("observe");

    // Everything above is in the audit trail.
    const audit = await call("audit_list", {});
    const ops = audit.entries.map((e: { op: string }) => e.op);
    expect(ops).toContain("connector_add");
    expect(ops).toContain("connector_call");
    expect(ops).toContain("approval_approve");
    expect(ops).toContain("connector_set_autonomy");

    await call("connector_remove", { name: "gated-self" });
  });

  it("M3: openapi connectors synthesize read-only tools from a spec", async () => {
    const { createServer } = await import("node:http");
    const spec = {
      openapi: "3.0.0",
      info: { title: "Demo API", version: "1.0.0" },
      servers: [{ url: "http://127.0.0.1:0" }], // overridden via baseUrl
      paths: {
        "/items": {
          get: { operationId: "listItems", summary: "List items" },
          post: { operationId: "createItem", summary: "Create item" },
        },
        "/items/{id}": {
          get: {
            operationId: "getItem",
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
          },
        },
      },
    };
    const server = createServer((req, res) => {
      if (req.url === "/spec.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(spec));
      } else if (req.url?.startsWith("/items/")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: req.url.split("/")[2], ok: true }));
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify([{ id: "a" }]));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;

    try {
      const added = await call("connector_add", {
        name: "demo-api",
        transport: { type: "openapi", specUrl: `${base}/spec.json`, baseUrl: base },
      });
      expect(added._isError).toBe(false);
      expect(added.autonomy).toBe("approve"); // openapi default
      const toolNames = added.tools.map((t: { name: string }) => t.name);
      expect(toolNames).toContain("listItems");
      expect(toolNames).toContain("getItem");
      expect(toolNames).not.toContain("createItem"); // mutating filtered (read-only default)

      // mcp probes through the synthesized connector are not gated.
      const created = await call("goal_create", {
        objective: "demo api returns the requested item",
        slug: "openapi-probe",
        criteria: [
          {
            description: "item a is ok",
            probe: { kind: "mcp", connector: "demo-api", tool: "getItem", args: { id: "a" } },
            assert: { path: "output.ok", op: "eq", value: true },
          },
        ],
      });
      expect(created._isError).toBe(false);
      const report = await call("goal_assess", { goal: "openapi-probe" });
      expect(report.converged).toBe(true);

      await call("connector_remove", { name: "demo-api" });
    } finally {
      server.closeAllConnections?.();
      server.close();
    }
  });
});
