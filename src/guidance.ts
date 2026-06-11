import type {
  Autonomy,
  CriterionEvaluation,
  Goal,
  WorkflowSuggestion,
} from "./types.js";

/**
 * The convergence protocol, served as the MCP server's instructions so any
 * connected agent knows how to drive the loop.
 */
export const PROTOCOL = `Keyoku is a convergence harness: it turns goals with machine-checkable
success criteria into a loop you (the agent) drive until the goal is reached.

The protocol:
1. goal_create — declare a goal. Success criteria are probes (shell command,
   HTTP request, or MCP connector tool call) plus assertions over their
   output. Criteria must be machine-checkable; if the user's goal is vague,
   ask them to pin down how success would be verified, then encode it.
2. goal_assess — the harness runs every probe and evaluates every assertion
   deterministically. The response tells you which criteria are unmet and
   what to do next. Assessing is read-only and free; do it often.
3. Act — take ONE corrective action toward the unmet criteria, respecting the
   goal's autonomy level and constraints.
4. goal_record — record the action you took (this is how the harness learns;
   converged goals become reusable workflows suggested for similar goals).
5. Repeat from step 2 until the report says converged.

Autonomy levels (set per goal): observe = never act, only report findings;
suggest = propose actions and let the user run them; approve = ask the user
before each action; autonomous = act without asking, within the constraints.

Connectors extend the harness's reach: connector_add registers an external
MCP server (stdio or HTTP) OR synthesizes one from an OpenAPI/Swagger spec
(transport type 'openapi' — read-only by default). connector_call invokes
their tools and is gated by the CONNECTOR's autonomy level: observe/suggest
refuse, approve queues an approval request a human decides via
approval_approve/approval_deny, autonomous executes. Never approve your own
queued requests unless the user explicitly tells you to. 'mcp' probes use
connector tools as success criteria and are not gated (read-only by
convention).

The harness learns: every assessment is recorded as an observation, and
harness_learn mines traces + observations into reusable patterns (SLM-powered
when GEMINI_API_KEY / ANTHROPIC_API_KEY is configured, heuristic otherwise).
Relevant patterns and previously learned workflows appear in goal_assess
guidance — prefer them; they encode how this user does things. Everything
consequential lands in the audit trail (audit_list).`;

function describeExpected(evaluation: CriterionEvaluation): string {
  const { op, value, path } = evaluation.expected;
  const valuePart = value === undefined ? "" : ` ${JSON.stringify(value)}`;
  return `${path} ${op}${valuePart}`;
}

function autonomyInstruction(autonomy: Autonomy): string {
  switch (autonomy) {
    case "observe":
      return "Autonomy is 'observe': do NOT take any corrective action. Report the unmet criteria to the user and stop.";
    case "suggest":
      return "Autonomy is 'suggest': propose the next corrective action to the user and let THEM run it. Do not execute it yourself.";
    case "approve":
      return "Autonomy is 'approve': describe the next corrective action and ask the user for explicit approval before executing it.";
    case "autonomous":
      return "Autonomy is 'autonomous': take the next corrective action now, without asking, staying within the goal's constraints.";
  }
}

export function buildGuidance(
  goal: Goal,
  evaluations: CriterionEvaluation[],
  suggestions: WorkflowSuggestion[],
  opts: {
    driftDetected: boolean;
    patterns?: { name: string; description: string; steps: string[]; stability: number }[];
  },
): string {
  const unmet = evaluations.filter((e) => !e.pass);
  const remaining = Math.max(0, goal.maxIterations - goal.usedIterations);
  const lines: string[] = [];

  if (unmet.length === 0) {
    lines.push(
      `CONVERGED ✓ — all ${evaluations.length} criteria for '${goal.slug}' pass.`,
    );
    lines.push(
      "The action trace has been promoted to a reusable workflow (see workflow_list).",
    );
    lines.push(
      "Report the outcome to the user. Re-run goal_assess any time to verify the state still holds; if it drifts, the loop resumes.",
    );
    return lines.join("\n");
  }

  if (opts.driftDetected) {
    lines.push(
      `DRIFT DETECTED — '${goal.slug}' was converged but ${unmet.length} criteria regressed. The goal is active again.`,
    );
  } else {
    lines.push(
      `NOT CONVERGED — ${unmet.length} of ${evaluations.length} criteria unmet for '${goal.slug}'.`,
    );
  }

  for (const e of unmet) {
    const reason = e.error
      ? `probe/eval error: ${e.error}`
      : `expected ${describeExpected(e)}, got ${JSON.stringify(e.actual)?.slice(0, 200)}`;
    lines.push(`  ✗ [${e.id}] ${e.description} — ${reason}`);
  }

  if (goal.constraints.length > 0) {
    lines.push(`Constraints: ${goal.constraints.join("; ")}`);
  }

  if (suggestions.length > 0) {
    lines.push("Learned workflows from similar converged goals:");
    for (const s of suggestions) {
      const steps = s.steps.map((st) => st.summary).join(" → ") || "(no recorded steps)";
      lines.push(
        `  • '${s.slug}' (converged ${s.convergences}x, similarity ${s.similarity.toFixed(2)}): ${steps}`,
      );
    }
  }

  if (opts.patterns && opts.patterns.length > 0) {
    lines.push("Mined patterns that may apply (from the learning loop):");
    for (const p of opts.patterns) {
      lines.push(`  • ${p.name} (stability ${p.stability.toFixed(1)}): ${p.steps.join(" → ")}`);
    }
  }

  if (goal.status === "blocked") {
    lines.push(
      `BLOCKED — the iteration budget (${goal.maxIterations}) is exhausted. Do not act further. Ask the user whether to raise the budget (goal_update) or abandon the goal.`,
    );
    return lines.join("\n");
  }

  lines.push(autonomyInstruction(goal.autonomy));
  if (goal.autonomy === "approve" || goal.autonomy === "autonomous") {
    lines.push(
      `Next: take ONE corrective action toward the first unmet criterion, then call goal_record to log it, then goal_assess to re-check. Budget: ${remaining} iteration(s) left.`,
    );
  }
  return lines.join("\n");
}

export function buildCreateGuidance(goal: Goal): string {
  return [
    `Goal '${goal.slug}' created with ${goal.criteria.length} machine-checkable criteria (autonomy: ${goal.autonomy}, budget: ${goal.maxIterations} iterations).`,
    "Next: call goal_assess to baseline the current state and get the convergence plan.",
  ].join("\n");
}

export function buildRecordGuidance(goal: Goal): string {
  if (goal.status === "blocked") {
    return `Recorded — but the iteration budget (${goal.maxIterations}) is now exhausted and the goal is BLOCKED. Ask the user whether to raise the budget via goal_update or stop.`;
  }
  const remaining = goal.maxIterations - goal.usedIterations;
  return `Recorded (iteration ${goal.usedIterations}/${goal.maxIterations}, ${remaining} left). Next: call goal_assess to check whether the goal has converged.`;
}
