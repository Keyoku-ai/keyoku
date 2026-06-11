import { newId, type Store } from "./store.js";
import type { ApprovalRequest, AuditEntry, Autonomy, Connector } from "./types.js";

/** Approval results are stored verbatim up to this many characters. */
const RESULT_CAP = 2000;

function cap(text: string): string {
  return text.length > RESULT_CAP ? `${text.slice(0, RESULT_CAP)}…` : text;
}

/**
 * Effective autonomy for a connector. An explicit setting always wins; the
 * default depends on provenance: MCP-native transports (stdio/http) keep the
 * M1 behavior of executing directly, while synthesized openapi connectors
 * default to requiring per-call approval.
 */
export function connectorAutonomy(connector: Connector): Autonomy {
  if (connector.autonomy) return connector.autonomy;
  return connector.transport.type === "openapi" ? "approve" : "autonomous";
}

export type GateDecision =
  | { action: "execute" }
  | { action: "refuse"; guidance: string }
  | { action: "enqueue"; guidance: string };

/**
 * Decide what connector_call may do for this connector + tool, per the trust
 * ladder. Guidance on non-execute decisions tells the driving agent what to
 * do instead — refusals are protocol, not dead ends.
 */
export function gateCall(connector: Connector, tool: string): GateDecision {
  const autonomy = connectorAutonomy(connector);
  switch (autonomy) {
    case "observe":
      return {
        action: "refuse",
        guidance:
          `Connector '${connector.name}' is observe-only: calls are refused. ` +
          `Probes and goal_assess against it still work. If '${tool}' truly must run, ` +
          `ask the user to raise autonomy via connector_set_autonomy.`,
      };
    case "suggest":
      return {
        action: "refuse",
        guidance:
          `Connector '${connector.name}' is suggest-only: this call was NOT executed. ` +
          `It WOULD run tool '${tool}' on connector '${connector.name}' with the given args. ` +
          `Propose that exact call to the user — they can run it themselves, or raise ` +
          `autonomy via connector_set_autonomy to let the harness act.`,
      };
    case "approve":
      return {
        action: "enqueue",
        guidance:
          `Connector '${connector.name}' requires approval: an approval request will be ` +
          `created for tool '${tool}' instead of executing it. A human decides via ` +
          `approval_approve / approval_deny — agents must not approve their own requests ` +
          `unless the user explicitly says so.`,
      };
    case "autonomous":
      return { action: "execute" };
    default: {
      const exhausted: never = autonomy;
      throw new Error(`unknown autonomy ${String(exhausted)}`);
    }
  }
}

/** Runs an approved connector call. Provided by the integration layer. */
export type CallExecutor = (
  connector: string,
  tool: string,
  args: Record<string, unknown>,
) => Promise<{ text: string; isError: boolean }>;

/** Queue a connector call for a human decision. */
export function enqueueApproval(
  store: Store,
  input: { connector: string; tool: string; args: Record<string, unknown>; reason: string },
): ApprovalRequest {
  const request: ApprovalRequest = {
    id: newId("apr"),
    connector: input.connector,
    tool: input.tool,
    args: input.args,
    reason: input.reason,
    requestedAt: new Date().toISOString(),
    status: "pending",
  };
  store.saveApproval(request);
  return request;
}

/**
 * Resolve a pending approval. Denials record the reason; approvals run the
 * queued call through `execute` and record the outcome: 'executed' on a clean
 * result, 'failed' when the executor reports an error or throws. The decision
 * is persisted before returning.
 */
export async function decideApproval(
  store: Store,
  id: string,
  decision: "approve" | "deny",
  execute: CallExecutor,
  denyReason?: string,
): Promise<ApprovalRequest> {
  const request = store.getApproval(id);
  if (!request) {
    const pending = store.listApprovals("pending").map((a) => a.id);
    throw new Error(
      `No approval request '${id}'. Pending requests: ${pending.length > 0 ? pending.join(", ") : "(none)"}.`,
    );
  }
  if (request.status !== "pending") {
    throw new Error(
      `Approval '${id}' was already decided: status is '${request.status}'.`,
    );
  }

  const updated: ApprovalRequest = { ...request, decidedAt: new Date().toISOString() };
  if (decision === "deny") {
    updated.status = "denied";
    updated.result = denyReason ?? "denied";
  } else {
    try {
      const { text, isError } = await execute(request.connector, request.tool, request.args);
      updated.status = isError ? "failed" : "executed";
      updated.result = cap(text);
    } catch (err) {
      updated.status = "failed";
      updated.result = cap(err instanceof Error ? err.message : String(err));
    }
  }
  store.saveApproval(updated);
  return updated;
}

/**
 * Append an audit entry, filling in id + timestamp. Never throws — an audit
 * failure must not break the operation it records.
 */
export function audit(store: Store, entry: Omit<AuditEntry, "id" | "at">): void {
  try {
    store.appendAudit({ ...entry, id: newId("aud"), at: new Date().toISOString() });
  } catch {
    // Auditing is best-effort by design.
  }
}
