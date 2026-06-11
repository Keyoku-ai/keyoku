// Full product loop over real MCP stdio: record activity → detect a pattern →
// approve the draft → execute → pause for the agent → resume → done.
import { mkdtempSync, rmSync } from "node:fs";
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
  home = mkdtempSync(join(tmpdir(), "keyoku-wf-e2e-"));
  client = new Client({ name: "wf-e2e-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [ENTRY, "serve"],
      env: { ...process.env, KEYOKU_HOME: home, KEYOKU_SLM_PROVIDER: "none" } as Record<string, string>,
      stderr: "ignore",
    }),
  );
});

afterAll(async () => {
  await client.close();
  rmSync(home, { recursive: true, force: true });
});

describe("activity → suggestion pipeline", () => {
  it("records activity and surfaces a repeated sequence as a draft workflow", async () => {
    for (let round = 0; round < 3; round++) {
      await call("activity_record", { summary: "Bash: npm test", type: "shell", tool: "Bash", detail: "npm test" });
      await call("activity_record", { summary: "Bash: git push", type: "shell", tool: "Bash", detail: "git push" });
      await call("activity_record", { summary: `Read: /tmp/notes-${round}.md`, type: "tool_use", tool: "Read" });
    }
    const suggested = await call("workflow_suggest", {});
    expect(suggested.count).toBeGreaterThan(0);
    const top = suggested.suggestions[0];
    expect(top.count).toBeGreaterThanOrEqual(3);
    expect(top.draftSteps.some((s: any) => s.command === "npm test")).toBe(true);
  });
});

describe("on-demand capture", () => {
  it("turns the last N session actions into a reviewable draft", async () => {
    const captured = await call("workflow_capture", { last: 2, name: "Captured test" });
    expect(captured._isError).toBe(false);
    expect(captured.draft.steps).toHaveLength(2);
    expect(captured.draft.slug).toBeTruthy();
    expect(captured.guidance).toContain("workflow_approve");
  });
});

describe("workflow execution lifecycle", () => {
  let executionId: string;

  it("approves a mixed bash/agent template", async () => {
    const approved = await call("workflow_approve", {
      slug: "release-notes",
      name: "Release notes",
      description: "Run checks, draft notes, finish up",
      steps: [
        { type: "bash", summary: "run check", command: "echo check-ok" },
        { type: "agent_prompt", summary: "draft notes", prompt: "Draft the release notes" },
        { type: "bash", summary: "final echo", command: "echo done-ok" },
      ],
    });
    expect(approved._isError).toBe(false);
    expect(approved.template.slug).toBe("release-notes");
  });

  it("publishes approved workflows as MCP prompts (the ambient catalog)", async () => {
    const prompts = await client.listPrompts();
    const names = prompts.prompts.map((p) => p.name);
    expect(names).toContain("workflow-release-notes");
    const got = await client.getPrompt({ name: "workflow-release-notes" });
    const text = JSON.stringify(got.messages);
    expect(text).toContain("workflow_execute");
    expect(text).toContain("release-notes");
    expect(names).toContain("keyoku-catalog");
  });

  it("executes bash steps directly and pauses at the agent step", async () => {
    const run = await call("workflow_execute", { slug: "release-notes" });
    expect(run.waiting_for).toBe("agent");
    expect(run.step.index).toBe(1);
    expect(run.execution.steps[0].status).toBe("done");
    expect(run.execution.steps[0].result).toContain("check-ok");
    executionId = run.execution.id;
  });

  it("rejects out-of-order step completion", async () => {
    const bad = await call("execution_complete", { id: executionId, step_index: 0, result: "nope" });
    expect(bad._isError).toBe(true);
    expect(JSON.stringify(bad)).toContain("Expected step_index 1");
  });

  it("resumes after the agent step and runs to completion", async () => {
    const done = await call("execution_complete", { id: executionId, step_index: 1, result: "Notes drafted." });
    expect(done.completed).toBe(true);
    expect(done.execution.status).toBe("done");
    expect(done.execution.steps[2].result).toContain("done-ok");
  });

  it("marks the template as run and lists the execution", async () => {
    const templates = await call("workflow_template_list", {});
    const tmpl = templates.templates.find((t: any) => t.slug === "release-notes");
    expect(tmpl.timesRun).toBe(1);
    const executions = await call("execution_list", {});
    expect(executions.executions.some((e: any) => e.id === executionId && e.status === "done")).toBe(true);
  });

  it("fails the execution when a bash step exits non-zero", async () => {
    await call("workflow_approve", {
      slug: "doomed",
      name: "Doomed",
      description: "fails on purpose",
      steps: [{ type: "bash", summary: "boom", command: "exit 7" }],
    });
    const run = await call("workflow_execute", { slug: "doomed" });
    expect(run.failed_at).toBe(0);
    expect(run.execution.status).toBe("failed");
  });

  it("fails fast on a misconfigured mcp_call step instead of skipping it", async () => {
    await call("workflow_approve", {
      slug: "bad-mcp",
      name: "Bad MCP",
      description: "mcp_call with no connector",
      steps: [{ type: "mcp_call", summary: "call nothing" }],
    });
    const run = await call("workflow_execute", { slug: "bad-mcp" });
    expect(run.failed_at).toBe(0);
    expect(run.error).toContain("missing connector");
  });
});
