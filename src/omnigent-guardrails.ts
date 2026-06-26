import type { ConnectorManager } from "./connectors.js";
import { buildConvergenceGate, type OmnigentPolicySpec } from "./policy-compiler.js";

const CREATE_POLICY_TOOL = "create_policy_v1_sessions__session_id__policies_post";
const DELETE_POLICY_TOOL = "delete_policy_v1_sessions__session_id__policies__policy_id__delete";

type Connectors = Pick<ConnectorManager, "callTool">;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function findPolicyId(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["id", "policy_id"]) {
    if (typeof record[key] === "string") return record[key];
  }
  for (const key of ["policy", "data"]) {
    const nested = findPolicyId(record[key]);
    if (nested) return nested;
  }
  return undefined;
}

export function continuationMessage(unmet: string[]): string {
  const list = unmet.length > 0 ? unmet.map((item) => `- ${item}`).join("\n") : "- (unspecified criteria)";
  return `Still not done — these criteria fail:\n${list}\n\nKeep working; you cannot finish until they pass.`;
}

export function omnigentUserMessageEvent(text: string): Record<string, unknown> {
  return {
    type: "message",
    data: {
      role: "user",
      content: [{ type: "input_text", text }],
    },
  };
}

export async function installPolicies(
  connectors: Connectors,
  sessionId: string,
  specs: OmnigentPolicySpec[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const spec of specs) {
    const result = await connectors.callTool("omnigent", CREATE_POLICY_TOOL, {
      session_id: sessionId,
      body: {
        type: "python",
        ...spec,
      },
    });
    if (result.isError) {
      throw new Error(`installing Omnigent policy '${spec.name}' failed: ${result.text}`);
    }
    const id = findPolicyId(parseJson(result.text));
    if (!id) {
      throw new Error(`installing Omnigent policy '${spec.name}' returned no policy id`);
    }
    ids.push(id);
  }
  return ids;
}

export async function removePolicy(
  connectors: Connectors,
  sessionId: string,
  policyId: string,
): Promise<void> {
  const result = await connectors.callTool("omnigent", DELETE_POLICY_TOOL, {
    session_id: sessionId,
    policy_id: policyId,
  });
  if (result.isError) {
    throw new Error(`removing Omnigent policy '${policyId}' failed: ${result.text}`);
  }
}

export async function driveToConvergence(opts: {
  connectors: Connectors;
  sessionId: string;
  goalSlug: string;
  assess: () => Promise<{ converged: boolean; unmet: string[] }>;
  maxRounds?: number;
  postMessage: (text: string) => Promise<void>;
}): Promise<{ converged: boolean; rounds: number }> {
  const maxRounds = opts.maxRounds ?? 20;
  const [gateId] = await installPolicies(opts.connectors, opts.sessionId, [
    buildConvergenceGate(opts.goalSlug),
  ]);

  for (let round = 1; round <= maxRounds; round++) {
    const assessment = await opts.assess();
    if (assessment.converged) {
      await removePolicy(opts.connectors, opts.sessionId, gateId);
      return { converged: true, rounds: round };
    }
    await opts.postMessage(continuationMessage(assessment.unmet));
  }

  return { converged: false, rounds: maxRounds };
}
