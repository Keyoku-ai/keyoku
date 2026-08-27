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
export const PROTOCOL = `Keyoku is the provider-neutral proof and attention layer
for software contributions made by people and coding agents. It turns a
repository-owned outcome into bounded evidence for the exact Git revision under
review, then shows which decisions still belong to a human. Claude Code, Codex,
Copilot, Cursor, OpenHands, custom agents, CI, and human-only development remain
replaceable execution layers.

When a repository contains .keyoku/project.yaml, call project_inspect before
substantial work and outcome_list to select the relevant versioned definition of
done. Use architecture_scan when a code tour or current system projection helps
explain the change; architecture_propose records a semantic proposal without
silently rewriting declared project truth.

Use contribution_start to record who or what is working (agents include harness,
model, and ownerId). During long work, use contribution_report_work for concise
task status. Activity is coordination, never proof. If—and only if—safe progress
requires accountable human judgment, use contribution_request_decision with the
agent intent, concrete blocker, reason it belongs to the human, bounded options,
recommendation, and consequence of no response. Continue independent work.
Poll contribution_next_instruction at natural task boundaries and acknowledge
received direction with contribution_ack_instruction.

Before the final contribution_gate, use contribution_propose_directions to give
the human 1-4 genuinely useful next moves. Reason across the whole outcome,
changed-source scope, work history, architecture, evidence, limits, and pending
human judgments. For each move provide the expected outcome effect, concise
evidence-grounded basis, inspectable references, deep context, tradeoffs, and an
executable instruction. Do not expose private chain-of-thought; summarize the
rationale and assumptions a reviewer needs. When the outcome is supported,
include what should happen next (acceptance, shipping, deeper validation, or a
deliberate follow-on) rather than inventing more unfinished work.

Use contribution_gate after meaningful iterations. The gate executes the repository's declared probes, emits JSON,
Markdown, and HTML evidence, and fails closed. Passing means READY FOR HUMAN
REVIEW for that exact snapshot—not universally correct, secure, or accepted.
Use contribution_review to append a named human's note or acceptance. It rejects
agent reviewers and stale Factfiles whose Git head or worktree digest changed.

Not every outcome is machine-checkable. Outcomes keep deterministic criteria
and named human criteria separate: tests establish observed behavior; people
judge product quality, usability, risk, and acceptance. The lower-level goal
loop uses machine-verifiable probes for the portion it can repeatedly assess.

REACH FOR KEYOKU whenever a task is a multi-step goal with a verifiable end
state — a migration, "make X production-ready", "get CI green", a deploy, a
refactor with a clear done-condition — especially work that spans many actions
or survives context resets, or that you want to become a reusable, learned
workflow. Not for one-shot edits or pure Q&A. The signal: you could write a
command/HTTP/probe that checks "is it done yet?". Before starting one, query
existing knowledge + goals + workflows so you reuse what was already learned.

The protocol:
1. goal_create — declare a goal. Success criteria are probes (shell command,
   HTTP request, or MCP connector tool call) plus assertions over their
   output. These goal-loop criteria must be machine-verifiable. Put irreducible
   product, UX, maintainability, or risk judgment in outcome humanCriteria
   rather than fabricating a proxy check.
2. goal_assess — the harness runs every probe and evaluates every assertion
   deterministically. The response tells you which criteria are unmet and
   what to do next. Assessing is read-only and free; do it often.
3. Act — take ONE corrective action toward the unmet criteria, respecting the
   goal's autonomy level and constraints.
4. goal_record — record the action you took (this is how the harness learns;
   converged goals become reusable workflows suggested for similar goals).
5. Repeat from step 2 until the report says converged.

Build-then-verify is fully supported: if you did the work BEFORE the first
assess and the goal converges immediately, goal_record is still accepted on
the converged goal — retroactive records spend no iteration budget and fold
into the promoted workflow. Record what you actually did, one record per real
step; otherwise the harness can only infer steps from the activity log (or
learns nothing at all).

Autonomy levels (set per goal): observe = never act, only report findings;
suggest = propose actions and let the user run them; approve = ask the user
before each action; autonomous = act without asking, within the constraints.

Human attention is an interrupt budget. Request it only when a consequence is
material, approved policy cannot resolve it, the work is blocked or time-bound,
the options differ meaningfully, and a named person can decide. Otherwise use
the safest reversible path, gather evidence, or include it in the next
checkpoint. Never turn routine agent uncertainty into approval fatigue.

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
consequential lands in the audit trail (audit_list).

Discipline that makes the loop work: make criteria BEHAVIORAL ("does the thing
actually work?") not mere file-presence; if a criterion turns out wrong or
incomplete, REFINE it in place with goal_update (addCriteria/
removeCriteriaIds/editCriteria) rather than creating a duplicate goal — a new
goal per refinement just fragments the loop's history and its learned
workflow. Editing criteria on a converged goal reopens it (its old
convergence no longer holds against the new definition of done). Call
goal_record for EVERY action honestly, including failures (failures teach the
harness what to avoid and become pitfalls in future suggestions); never fudge a
criterion that's blocked by the environment — report it honestly and leave the
goal unconverged; and always honor the goal's autonomy level.`;

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
    // When converged: true if a reusable workflow actually exists, false if the
    // goal converged with nothing recorded (so there's nothing to learn yet).
    workflowPromoted?: boolean;
  },
): string {
  const unmet = evaluations.filter((e) => !e.pass);
  const remaining = Math.max(0, goal.maxIterations - goal.usedIterations);
  const lines: string[] = [];

  if (unmet.length === 0) {
    lines.push(
      `CONVERGED ✓ — all ${evaluations.length} criteria for '${goal.slug}' pass.`,
    );
    if (opts.workflowPromoted === false) {
      lines.push(
        "No actions were recorded, so there is no workflow to learn yet. If you did real work to get here, call goal_record for each step NOW — records are accepted after convergence and do not spend the budget — so this run becomes a reusable workflow (muscle memory).",
      );
    } else {
      lines.push(
        "The action trace has been promoted to a reusable workflow (see workflow_list).",
      );
    }
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
      if (s.pitfalls && s.pitfalls.length > 0) {
        lines.push(`    avoid (failed before): ${s.pitfalls.join("; ")}`);
      }
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
    // The learning contract (audit 2026-06-17): a run that converges with an
    // empty trace teaches nothing. Surface this at create time so the agent
    // records as it works — and knows retroactive records are accepted if it
    // builds first and verifies after.
    "Learning contract: call goal_record for each real action BEFORE the final assess — the recorded trace is what becomes the reusable workflow. If you do the work first and assess after (build-then-verify), goal_record is still accepted after convergence and spends no budget; without records the workflow can only be inferred from the activity log, or is not learned at all.",
  ].join("\n");
}

export function buildRecordGuidance(goal: Goal): string {
  if (goal.status === "converged") {
    return "Recorded retroactively onto the converged goal and folded into its reusable workflow (workflow_list) — this is how a build-then-verify run becomes muscle memory. Add one record per real step; retroactive records do not spend the iteration budget.";
  }
  if (goal.status === "blocked") {
    return `Recorded — but the iteration budget (${goal.maxIterations}) is now exhausted and the goal is BLOCKED. Ask the user whether to raise the budget via goal_update or stop.`;
  }
  const remaining = goal.maxIterations - goal.usedIterations;
  return `Recorded (iteration ${goal.usedIterations}/${goal.maxIterations}, ${remaining} left). Next: call goal_assess to check whether the goal has converged.`;
}
