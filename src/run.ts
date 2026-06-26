import type { ConnectorCallResult, ConnectorManager } from "./connectors.js";
import type { Harness } from "./engine.js";
import {
  driveToConvergence,
  installPolicies,
  omnigentUserMessageEvent,
} from "./omnigent-guardrails.js";
import { compileConstraintsToPolicies } from "./policy-compiler.js";
import { CONNECTOR_PRESETS } from "./presets.js";
import {
  chooseAgentForGoal,
  listOmnigentAgents,
  LIST_AGENTS_TOOL,
  type AgentChoice,
} from "./dispatch.js";
import type { ConvergenceReport, Connector, Goal } from "./types.js";

type Connectors = Pick<ConnectorManager, "add" | "callTool" | "get">;

type Engine = Pick<Harness, "assess" | "getGoal"> & {
  slm?: Harness["slm"];
};

const CREATE_SESSION_TOOL = "create_session_v1_sessions_post";
const POST_EVENT_TOOL = "post_event_v1_sessions__session_id__events_post";

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text.trim();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function directString(value: unknown, keys: string[]): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const item = value[key];
    if (typeof item === "string" && item.trim()) return item.trim();
  }
  return undefined;
}

function findSessionId(value: unknown, allowBareString = false): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return allowBareString ? value.trim() : undefined;
  }

  const preferred = directString(value, ["conversation_id", "session_id", "id"]);
  if (preferred) return preferred;

  if (!isRecord(value)) return undefined;
  for (const key of ["conversation", "session", "data", "result"]) {
    const nested = findSessionId(value[key], key === "conversation" || key === "session");
    if (nested) return nested;
  }
  for (const nested of Object.values(value)) {
    const found = findSessionId(nested);
    if (found) return found;
  }
  return undefined;
}

function asArrayPayload(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return [];
  for (const key of ["data", "items", "agents"]) {
    const item = value[key];
    if (Array.isArray(item)) return item;
  }
  return [];
}

async function resolveAgentId(
  connectors: Pick<ConnectorManager, "callTool">,
  agentName: string,
): Promise<string> {
  const result = await connectors.callTool("omnigent", LIST_AGENTS_TOOL, { limit: 1000 });
  requireOk(result, "listing Omnigent agents");
  const agents = asArrayPayload(parseJson(result.text));
  const match = agents
    .filter(isRecord)
    .find((agent) => agent.id === agentName || agent.name === agentName || agent.harness === agentName);
  if (typeof match?.id === "string" && match.id.trim()) return match.id.trim();
  throw new Error(`No Omnigent agent named '${agentName}' was found.`);
}

function requireOk(result: ConnectorCallResult, label: string): void {
  if (result.isError) {
    throw new Error(`${label} failed: ${result.text}`);
  }
}

function unmetCriteria(report: ConvergenceReport): string[] {
  return report.criteria
    .filter((criterion) => !criterion.pass)
    .map((criterion) => {
      const detail = criterion.error ? ` — ${criterion.error}` : "";
      return `[${criterion.id}] ${criterion.description}${detail}`;
    });
}

function initialTask(goal: Goal, unmet: string[]): string {
  const criteria = unmet.length > 0 ? unmet.map((item) => `- ${item}`).join("\n") : "- (none)";
  return `Keyoku goal '${goal.slug}': ${goal.objective}

Current unmet criteria:
${criteria}

Drive this goal to convergence. Verify with Keyoku before claiming completion.`;
}

async function postUserMessage(
  connectors: Pick<ConnectorManager, "callTool">,
  sessionId: string,
  text: string,
): Promise<void> {
  const posted = await connectors.callTool("omnigent", POST_EVENT_TOOL, {
    session_id: sessionId,
    body: omnigentUserMessageEvent(text),
  });
  requireOk(posted, "posting Omnigent event");
}

async function createSession(
  connectors: Pick<ConnectorManager, "callTool">,
  goalSlug: string,
  agentName: string,
): Promise<string> {
  const title = `keyoku:${goalSlug}`;
  let created = await connectors.callTool("omnigent", CREATE_SESSION_TOOL, {
    body: { agent_name: agentName, title },
  });
  if (created.isError && /agent_id/i.test(created.text)) {
    const agentId = await resolveAgentId(connectors, agentName);
    created = await connectors.callTool("omnigent", CREATE_SESSION_TOOL, {
      body: { agent_id: agentId, title },
    });
  }
  requireOk(created, "creating Omnigent session");
  const sessionId = findSessionId(parseJson(created.text), true);
  if (!sessionId) {
    throw new Error(`creating Omnigent session returned no session id: ${created.text}`);
  }
  return sessionId;
}

export async function ensureOmnigentConnector(connectors: Connectors): Promise<void> {
  if (connectors.get("omnigent")) return;

  const preset = CONNECTOR_PRESETS.omnigent;
  await connectors.add({
    name: "omnigent",
    description: preset.description,
    transport: preset.buildTransport(),
    autonomy: preset.autonomy,
    addedAt: new Date().toISOString(),
  } satisfies Connector);
}

export async function runGoalOnOmnigent(opts: {
  engine: Engine;
  connectors: Connectors;
  goalSlug: string;
  agentName?: string;
  maxRounds?: number;
  log?: (message: string) => void;
}): Promise<{ converged: boolean; rounds: number; sessionId: string; dispatch?: AgentChoice }> {
  await ensureOmnigentConnector(opts.connectors);

  const goal = opts.engine.getGoal(opts.goalSlug);
  let dispatch: AgentChoice | undefined;
  let agentName = opts.agentName;
  if (!agentName) {
    const agents = await listOmnigentAgents(opts.connectors);
    dispatch = await chooseAgentForGoal({
      goal,
      agents,
      slm: opts.engine.slm,
      ...(opts.log ? { log: opts.log } : {}),
    });
    agentName = dispatch.agent;
  }

  const sessionId = await createSession(
    opts.connectors,
    opts.goalSlug,
    agentName,
  );

  const specs = await compileConstraintsToPolicies(goal.constraints ?? [], {
    slm: opts.engine.slm,
    log: () => {},
  });
  await installPolicies(opts.connectors, sessionId, specs);

  const baseline = await opts.engine.assess(goal.slug);
  await postUserMessage(opts.connectors, sessionId, initialTask(goal, unmetCriteria(baseline)));

  const result = await driveToConvergence({
    connectors: opts.connectors,
    sessionId,
    goalSlug: goal.slug,
    maxRounds: opts.maxRounds,
    assess: async () => {
      const report = await opts.engine.assess(goal.slug);
      return { converged: report.converged, unmet: unmetCriteria(report) };
    },
    postMessage: (text) => postUserMessage(opts.connectors, sessionId, text),
  });

  return { ...result, sessionId, ...(dispatch ? { dispatch } : {}) };
}
