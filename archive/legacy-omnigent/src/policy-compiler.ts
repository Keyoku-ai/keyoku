import { resolveSlmFromEnv, type SlmProvider } from "./slm.js";

export type OmnigentPolicySpec = {
  name: string;
  handler: string;
  factory_params: Record<string, unknown>;
};

export interface CompileConstraintsOptions {
  slm?: SlmProvider | null;
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
}

const CEL_POLICY = "omnigent.policies.builtins.cel.cel_policy";
const BLAST_RADIUS_POLICY = "omnigent.inner.nessie.policies.blast_radius";

const HANDLERS = [
  {
    handler: CEL_POLICY,
    params:
      'factory_params {expression, reason?}; CEL receives event and returns {"result":"DENY"|"ASK"|"ALLOW","reason":...}; event.type is request|tool_call|tool_result|response|llm_request|llm_response; event.data for tool_call is {name, arguments}, for response is a string.',
  },
  { handler: BLAST_RADIUS_POLICY, params: "factory_params null/{}" },
  {
    handler: "omnigent.policies.builtins.working_dir.block_working_dir_changes",
    params: "factory_params {allowed_dirs, action}",
  },
  {
    handler: "omnigent.policies.builtins.github.github_policy",
    params: "factory_params {write_repos, write_branches}",
  },
  {
    handler: "omnigent.policies.builtins.cost.cost_budget",
    params: "factory_params {max_cost_usd}",
  },
] as const;

const KNOWN_HANDLERS: ReadonlySet<string> = new Set(HANDLERS.map((h) => h.handler));

function celString(value: string): string {
  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```[a-zA-Z0-9_-]*\s*/, "")
    .replace(/\s*```$/, "")
    .trim();
}

function parseModelPolicies(raw: string): OmnigentPolicySpec[] {
  const parsed = JSON.parse(stripCodeFence(raw)) as unknown;
  const policies = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.policies)
      ? parsed.policies
      : undefined;
  if (!policies) {
    throw new Error("constraint compiler model returned no policies array");
  }
  return policies.map((item, index): OmnigentPolicySpec => {
    const spec = isRecord(item) && isRecord(item.spec) ? item.spec : item;
    if (!isRecord(spec)) {
      throw new Error(`constraint compiler model returned non-object policy at index ${index}`);
    }
    const { name, handler, factory_params } = spec;
    if (typeof name !== "string" || name.trim() === "") {
      throw new Error(`constraint compiler model returned a policy without a name at index ${index}`);
    }
    if (typeof handler !== "string" || !KNOWN_HANDLERS.has(handler)) {
      throw new Error(`constraint compiler model returned unsupported handler at index ${index}: ${String(handler)}`);
    }
    if (!isRecord(factory_params)) {
      throw new Error(`constraint compiler model returned invalid factory_params at index ${index}`);
    }
    if (handler === CEL_POLICY && typeof factory_params.expression !== "string") {
      throw new Error(`constraint compiler model returned CEL policy without expression at index ${index}`);
    }
    return {
      name,
      handler,
      factory_params,
    };
  });
}

function offlineFallback(log: (message: string) => void): OmnigentPolicySpec[] {
  log(
    "Keyoku constraint policy compilation is using a degraded offline fallback: no model is configured, so constraints were not semantically mapped. Installing blast_radius only.",
  );
  return [
    {
      name: "keyoku-degraded-blast-radius",
      handler: BLAST_RADIUS_POLICY,
      factory_params: {},
    },
  ];
}

export function buildConvergenceGate(goalSlug: string): OmnigentPolicySpec {
  const reason = `Keyoku convergence gate [${goalSlug}]: success criteria not yet verified — keep working.`;
  return {
    name: `keyoku-convergence-gate-${goalSlug}`,
    handler: CEL_POLICY,
    factory_params: {
      expression: `event.type == "response" ? {"result": "DENY", "reason": ${celString(reason)}} : {"result": "ALLOW"}`,
      reason,
    },
  };
}

export async function compileConstraintsToPolicies(
  constraints: string[],
  opts: CompileConstraintsOptions = {},
): Promise<OmnigentPolicySpec[]> {
  if (constraints.length === 0) return [];

  const slm = opts.slm === undefined ? resolveSlmFromEnv(opts.env) : opts.slm;
  const log = opts.log ?? ((message: string) => console.warn(message));
  if (!slm) return offlineFallback(log);

  const prompt = `You compile Keyoku goal constraints into Omnigent runtime policies.

Hard rules:
- A model must decide the best-fit handler for every natural-language constraint.
- Do not use keyword matching. Reason about the operational intent.
- Return exactly one policy per input constraint, in the same order.
- Use built-in handlers when their params fit.
- For semantic, broad, or unknown constraints, use the CEL handler and generate a conservative CEL expression.
- Return raw JSON only.

Available handlers:
${HANDLERS.map((h) => `- ${h.handler}: ${h.params}`).join("\n")}

Input constraints:
${constraints.map((constraint, i) => `${i + 1}. ${constraint}`).join("\n")}

Return JSON with this shape:
{"policies":[{"name":"keyoku-constraint-1","handler":"<handler>","factory_params":{...}}]}`;

  const raw = await slm.complete(prompt, { json: true, maxTokens: 1800 });
  const policies = parseModelPolicies(raw);
  if (policies.length !== constraints.length) {
    throw new Error(
      `constraint compiler model returned ${policies.length} polic${policies.length === 1 ? "y" : "ies"} for ${constraints.length} constraint${constraints.length === 1 ? "" : "s"}`,
    );
  }
  return policies;
}
