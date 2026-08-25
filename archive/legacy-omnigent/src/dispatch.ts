import type { ConnectorCallResult, ConnectorManager } from "./connectors.js";
import { resolveSlmFromEnv, type SlmProvider } from "./slm.js";
import type { Goal } from "./types.js";

export interface AgentChoice {
  agent: string;
  rationale: string;
  degraded?: boolean;
}

export interface OmnigentAgentCandidate {
  name: string;
  harness?: string;
  description?: string;
}

export const LIST_AGENTS_TOOL = "list_builtin_agents_v1_agents_get";

const OFFLINE_DEFAULT_AGENT = "codex-native-ui";

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.trim();
  }
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArrayPayload(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ["data", "items", "agents", "result"]) {
    const item = value[key];
    if (Array.isArray(item)) return item;
  }
  return [];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requireOk(result: ConnectorCallResult, label: string): void {
  if (result.isError) {
    throw new Error(`${label} failed: ${result.text}`);
  }
}

function parseAgentCandidate(value: unknown): OmnigentAgentCandidate | undefined {
  if (!isRecord(value)) return undefined;
  const name = optionalString(value.name);
  if (!name) return undefined;
  const harness = optionalString(value.harness);
  const description = optionalString(value.description);
  return {
    name,
    ...(harness ? { harness } : {}),
    ...(description ? { description } : {}),
  };
}

function parseModelChoice(raw: string, agents: OmnigentAgentCandidate[]): AgentChoice {
  const parsed = JSON.parse(stripCodeFence(raw)) as unknown;
  if (!isRecord(parsed)) {
    throw new Error("dispatch model returned non-object JSON");
  }

  const agent = optionalString(parsed.agent);
  const rationale = optionalString(parsed.rationale);
  if (!agent) throw new Error("dispatch model returned no agent");
  if (!rationale) throw new Error("dispatch model returned no rationale");

  const validNames = new Set(agents.map((candidate) => candidate.name));
  if (!validNames.has(agent)) {
    throw new Error(`dispatch model chose unknown agent '${agent}'`);
  }
  return { agent, rationale };
}

function dispatchPrompt(goal: Goal, agents: OmnigentAgentCandidate[]): string {
  const constraints = goal.constraints.length > 0 ? goal.constraints.map((constraint, i) => `${i + 1}. ${constraint}`).join("\n") : "(none)";
  return `You are Keyoku's Omnigent dispatch reasoner.

Hard rules:
- A model must decide the best-fit agent every time.
- Do not use regex, keyword matching, or fixed defaults.
- Choose exactly one candidate by its name.
- Return raw JSON only.

Typical role hints:
- codex-native: mechanical implementation, code changes, refactors, tests, build fixes.
- polly: decomposition and orchestration of large multi-part tasks.
- debby: two-model design debate and architecture tradeoff exploration.
- claude-native: nuanced reasoning, ambiguous decisions, language-heavy analysis.

Goal objective:
${goal.objective}

Goal constraints:
${constraints}

Candidate agents:
${JSON.stringify(agents, null, 2)}

Return JSON with this shape:
{"agent":"<candidate name>","rationale":"<why this agent is the best fit>"}`;
}

export async function listOmnigentAgents(
  connectors: Pick<ConnectorManager, "callTool">,
): Promise<OmnigentAgentCandidate[]> {
  const result = await connectors.callTool("omnigent", LIST_AGENTS_TOOL, { limit: 1000 });
  requireOk(result, "listing Omnigent agents");
  return asArrayPayload(parseJson(result.text))
    .map(parseAgentCandidate)
    .filter((agent): agent is OmnigentAgentCandidate => agent !== undefined);
}

export async function chooseAgentForGoal(opts: {
  goal: Goal;
  agents: OmnigentAgentCandidate[];
  slm?: SlmProvider | null;
  log?: (message: string) => void;
}): Promise<AgentChoice> {
  const slm = opts.slm === undefined ? resolveSlmFromEnv() : opts.slm;
  const log = opts.log ?? ((message: string) => console.warn(message));

  if (!slm) {
    // Degraded (no model): prefer the built-in default, but honor the live
    // agent list we were handed — returning a hardcoded agent that the fleet
    // doesn't actually expose would dispatch into the void. Fall back to the
    // first real candidate when the default is absent. (Empty list keeps the
    // default: offline discovery may simply have returned nothing.)
    const hasDefault =
      opts.agents.length === 0 || opts.agents.some((a) => a.name === OFFLINE_DEFAULT_AGENT);
    const agent = hasDefault ? OFFLINE_DEFAULT_AGENT : opts.agents[0].name;
    const choice = {
      agent,
      rationale: hasDefault
        ? "no model available — default"
        : `no model available — '${OFFLINE_DEFAULT_AGENT}' not in the fleet; using first available agent '${agent}'`,
      degraded: true,
    };
    log(
      `Keyoku intelligent dispatch degraded: no model available; selected Omnigent agent '${choice.agent}'. Rationale: ${choice.rationale}`,
    );
    return choice;
  }

  if (opts.agents.length === 0) {
    throw new Error("Cannot dispatch Omnigent goal: no candidate agents were returned.");
  }

  const raw = await slm.complete(dispatchPrompt(opts.goal, opts.agents), { json: true, maxTokens: 800 });
  const choice = parseModelChoice(raw, opts.agents);
  log(`Keyoku intelligent dispatch selected Omnigent agent '${choice.agent}'. Rationale: ${choice.rationale}`);
  return choice;
}
