import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  audit,
  type CallExecutor,
  connectorAutonomy,
  decideApproval,
  enqueueApproval,
  gateCall,
} from "../src/approvals.js";
import { Store } from "../src/store.js";
import type { Autonomy, Connector } from "../src/types.js";

let dir: string;
let store: Store;

const connector = (overrides: Partial<Connector> = {}): Connector => ({
  name: "gh",
  transport: { type: "stdio", command: "gh-mcp" },
  addedAt: new Date().toISOString(),
  ...overrides,
});

const okExecutor: CallExecutor = async () => ({ text: "done", isError: false });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "keyoku-approvals-"));
  store = new Store(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("connectorAutonomy", () => {
  it("honors an explicit autonomy over any transport default", () => {
    for (const autonomy of ["observe", "suggest", "approve", "autonomous"] as Autonomy[]) {
      expect(connectorAutonomy(connector({ autonomy }))).toBe(autonomy);
      expect(
        connectorAutonomy(
          connector({
            autonomy,
            transport: { type: "openapi", specUrl: "https://api.example.com/openapi.json" },
          }),
        ),
      ).toBe(autonomy);
    }
  });

  it("defaults openapi connectors to 'approve'", () => {
    expect(
      connectorAutonomy(
        connector({
          transport: { type: "openapi", specUrl: "https://api.example.com/openapi.json" },
        }),
      ),
    ).toBe("approve");
  });

  it("defaults MCP-native connectors (stdio/http) to 'autonomous' — preserves M1 behavior", () => {
    expect(connectorAutonomy(connector())).toBe("autonomous");
    expect(
      connectorAutonomy(
        connector({ transport: { type: "http", url: "https://example.com/mcp" } }),
      ),
    ).toBe("autonomous");
  });
});

describe("gateCall", () => {
  it("observe → refuse, pointing at probes and connector_set_autonomy", () => {
    const decision = gateCall(connector({ autonomy: "observe" }), "merge_pr");
    expect(decision.action).toBe("refuse");
    if (decision.action !== "refuse") throw new Error("unreachable");
    expect(decision.guidance).toContain("observe-only");
    expect(decision.guidance).toContain("connector_set_autonomy");
    expect(decision.guidance.toLowerCase()).toContain("probe");
  });

  it("suggest → refuse, describing the exact call to propose to the user", () => {
    const decision = gateCall(connector({ autonomy: "suggest" }), "merge_pr");
    expect(decision.action).toBe("refuse");
    if (decision.action !== "refuse") throw new Error("unreachable");
    expect(decision.guidance).toContain("'merge_pr'");
    expect(decision.guidance).toContain("'gh'");
    expect(decision.guidance.toLowerCase()).toContain("propose");
    expect(decision.guidance).toContain("connector_set_autonomy");
  });

  it("approve → enqueue, naming approval_approve/approval_deny and the self-approval rule", () => {
    const decision = gateCall(connector({ autonomy: "approve" }), "merge_pr");
    expect(decision.action).toBe("enqueue");
    if (decision.action !== "enqueue") throw new Error("unreachable");
    expect(decision.guidance).toContain("approval_approve");
    expect(decision.guidance).toContain("approval_deny");
    expect(decision.guidance.toLowerCase()).toContain("must not approve their own");
  });

  it("autonomous → execute", () => {
    expect(gateCall(connector({ autonomy: "autonomous" }), "merge_pr")).toEqual({
      action: "execute",
    });
  });

  it("uses the transport default when autonomy is unset (openapi enqueues)", () => {
    const decision = gateCall(
      connector({
        transport: { type: "openapi", specUrl: "https://api.example.com/openapi.json" },
      }),
      "deleteWidget",
    );
    expect(decision.action).toBe("enqueue");
  });
});

describe("enqueueApproval", () => {
  it("creates a pending request, persisted and listed", () => {
    const request = enqueueApproval(store, {
      connector: "gh",
      tool: "merge_pr",
      args: { pr: 42 },
      reason: "connector 'gh' autonomy is 'approve'",
    });
    expect(request.id).toMatch(/^apr_/);
    expect(request.status).toBe("pending");
    expect(Date.parse(request.requestedAt)).not.toBeNaN();

    const pending = store.listApprovals("pending");
    expect(pending.map((a) => a.id)).toEqual([request.id]);
    expect(store.getApproval(request.id)?.args).toEqual({ pr: 42 });
  });
});

describe("decideApproval", () => {
  it("deny → denied with decidedAt and the deny reason", async () => {
    const request = enqueueApproval(store, {
      connector: "gh",
      tool: "merge_pr",
      args: {},
      reason: "needs approval",
    });
    const decided = await decideApproval(store, request.id, "deny", okExecutor, "too risky");
    expect(decided.status).toBe("denied");
    expect(decided.result).toBe("too risky");
    expect(decided.decidedAt).toBeDefined();
    expect(store.getApproval(request.id)?.status).toBe("denied");
  });

  it("deny without a reason records 'denied'", async () => {
    const request = enqueueApproval(store, {
      connector: "gh",
      tool: "merge_pr",
      args: {},
      reason: "needs approval",
    });
    const decided = await decideApproval(store, request.id, "deny", okExecutor);
    expect(decided.result).toBe("denied");
  });

  it("approve with a succeeding executor → executed, with the result text persisted", async () => {
    const request = enqueueApproval(store, {
      connector: "gh",
      tool: "merge_pr",
      args: { pr: 42 },
      reason: "needs approval",
    });
    const execute = vi.fn(
      async (): Promise<{ text: string; isError: boolean }> => ({
        text: "merged #42",
        isError: false,
      }),
    );
    const decided = await decideApproval(store, request.id, "approve", execute);
    expect(execute).toHaveBeenCalledWith("gh", "merge_pr", { pr: 42 });
    expect(decided.status).toBe("executed");
    expect(decided.result).toBe("merged #42");
    expect(decided.decidedAt).toBeDefined();
    expect(store.getApproval(request.id)?.status).toBe("executed");
  });

  it("executor reporting isError → failed", async () => {
    const request = enqueueApproval(store, {
      connector: "gh",
      tool: "merge_pr",
      args: {},
      reason: "needs approval",
    });
    const decided = await decideApproval(store, request.id, "approve", async () => ({
      text: "merge conflict",
      isError: true,
    }));
    expect(decided.status).toBe("failed");
    expect(decided.result).toBe("merge conflict");
  });

  it("throwing executor → failed, capturing the message", async () => {
    const request = enqueueApproval(store, {
      connector: "gh",
      tool: "merge_pr",
      args: {},
      reason: "needs approval",
    });
    const decided = await decideApproval(store, request.id, "approve", async () => {
      throw new Error("connection refused");
    });
    expect(decided.status).toBe("failed");
    expect(decided.result).toBe("connection refused");
    expect(store.getApproval(request.id)?.status).toBe("failed");
  });

  it("caps the stored result at 2000 chars with a truncation marker", async () => {
    const request = enqueueApproval(store, {
      connector: "gh",
      tool: "merge_pr",
      args: {},
      reason: "needs approval",
    });
    const decided = await decideApproval(store, request.id, "approve", async () => ({
      text: "x".repeat(5000),
      isError: false,
    }));
    // 2000 kept chars + the "…" marker so a capped result is distinguishable.
    expect(decided.result).toBe(`${"x".repeat(2000)}…`);
    expect(store.getApproval(request.id)?.result).toBe(`${"x".repeat(2000)}…`);
  });

  it("deciding twice throws, stating the current status", async () => {
    const request = enqueueApproval(store, {
      connector: "gh",
      tool: "merge_pr",
      args: {},
      reason: "needs approval",
    });
    await decideApproval(store, request.id, "deny", okExecutor);
    await expect(decideApproval(store, request.id, "approve", okExecutor)).rejects.toThrow(
      /denied/,
    );
  });

  it("unknown id throws, naming the pending ids", async () => {
    const a = enqueueApproval(store, {
      connector: "gh",
      tool: "merge_pr",
      args: {},
      reason: "needs approval",
    });
    const b = enqueueApproval(store, {
      connector: "gh",
      tool: "close_pr",
      args: {},
      reason: "needs approval",
    });
    await decideApproval(store, b.id, "deny", okExecutor); // decided requests are not listed
    const failure = await decideApproval(store, "apr_nope", "approve", okExecutor).catch(
      (err: unknown) => err as Error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("apr_nope");
    expect((failure as Error).message).toContain(a.id);
    expect((failure as Error).message).not.toContain(b.id);
  });
});

describe("audit", () => {
  it("appends an entry with generated id and timestamp", () => {
    audit(store, {
      actor: "agent",
      op: "connector_call",
      target: "gh",
      summary: "queued merge_pr for approval",
      ok: true,
    });
    const entries = store.listAudit();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toMatch(/^aud_/);
    expect(Date.parse(entries[0].at)).not.toBeNaN();
    expect(entries[0].op).toBe("connector_call");
    expect(entries[0].ok).toBe(true);
  });

  it("never throws, even when the underlying append throws", () => {
    vi.spyOn(store, "appendAudit").mockImplementation(() => {
      throw new Error("disk full");
    });
    expect(() =>
      audit(store, { actor: "cli", op: "goal_create", summary: "x", ok: false }),
    ).not.toThrow();
  });
});
