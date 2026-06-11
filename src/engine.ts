import { evaluateAssertion } from "./assert.js";
import type { ConnectorManager } from "./connectors.js";
import { buildGuidance } from "./guidance.js";
import { relevantPatterns } from "./learn.js";
import { observationFromReport, recordObservation } from "./observe.js";
import { runProbe } from "./probes.js";
import { effectiveStability } from "./types.js";
import { newId, slugify, type Store } from "./store.js";
import type {
  ActionRecord,
  ActionResult,
  Autonomy,
  ConvergenceReport,
  Criterion,
  CriterionEvaluation,
  CriterionInput,
  Goal,
  WorkflowArtifact,
  WorkflowSuggestion,
} from "./types.js";

const STOPWORDS = new Set([
  "the", "a", "an", "to", "of", "in", "on", "for", "with", "and", "or",
  "is", "are", "all", "be", "has", "have", "should", "must", "that", "this",
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOPWORDS.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

const MAX_ACTUAL_CHARS = 2_000;

/** Probe output can be megabytes; reports go back into an agent's context. */
function capActual(value: unknown): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(value) ?? "undefined";
  } catch {
    serialized = String(value);
  }
  if (serialized.length <= MAX_ACTUAL_CHARS) return value;
  return `${serialized.slice(0, MAX_ACTUAL_CHARS)}… (truncated ${serialized.length - MAX_ACTUAL_CHARS} chars)`;
}

export interface CreateGoalInput {
  objective: string;
  slug?: string;
  criteria: CriterionInput[];
  constraints?: string[];
  autonomy?: Autonomy;
  maxIterations?: number;
}

export interface RecordActionInput {
  summary: string;
  detail?: string;
  tool?: string;
  result?: ActionResult;
}

/**
 * The harness engine: goal lifecycle, the assess step of the convergence
 * loop, episodic recording, and trace → workflow promotion (the M1 learning
 * slice).
 */
export class Harness {
  constructor(
    readonly store: Store,
    readonly connectors: ConnectorManager,
  ) {}

  // ----- goal lifecycle -----

  createGoal(input: CreateGoalInput): Goal {
    if (input.criteria.length === 0) {
      throw new Error(
        "A goal needs at least one machine-checkable criterion — otherwise convergence can never be detected. Ask the user how success would be verified, then encode it as a probe + assertion.",
      );
    }
    for (const c of input.criteria) {
      if (c.probe.kind === "mcp" && !this.store.getConnector(c.probe.connector)) {
        throw new Error(
          `Criterion '${c.description}' references unknown connector '${c.probe.connector}'. Register it first with connector_add.`,
        );
      }
    }
    const now = new Date().toISOString();
    const goal: Goal = {
      id: newId("goal"),
      slug: this.store.uniqueSlug(slugify(input.slug ?? input.objective)),
      objective: input.objective,
      criteria: input.criteria.map(
        (c, i): Criterion => ({ ...c, id: `c${i + 1}` }),
      ),
      constraints: input.constraints ?? [],
      autonomy: input.autonomy ?? "suggest",
      maxIterations: input.maxIterations ?? 10,
      usedIterations: 0,
      status: "active",
      createdAt: now,
      updatedAt: now,
      convergedAt: null,
      lastAssessedAt: null,
    };
    this.store.saveGoal(goal);
    return goal;
  }

  getGoal(ref: string): Goal {
    const goal = this.store.getGoal(ref);
    if (!goal) {
      const known = this.store.listGoals().map((g) => g.slug);
      throw new Error(
        `No goal '${ref}'. Known goals: ${known.length > 0 ? known.join(", ") : "(none — create one with goal_create)"}`,
      );
    }
    return goal;
  }

  updateGoal(
    ref: string,
    patch: Partial<
      Pick<Goal, "objective" | "autonomy" | "maxIterations" | "constraints">
    > & { status?: "active" | "abandoned" },
  ): Goal {
    const goal = this.getGoal(ref);
    if (patch.objective !== undefined) goal.objective = patch.objective;
    if (patch.autonomy !== undefined) goal.autonomy = patch.autonomy;
    if (patch.constraints !== undefined) goal.constraints = patch.constraints;
    if (patch.maxIterations !== undefined) {
      goal.maxIterations = patch.maxIterations;
      if (goal.status === "blocked" && goal.usedIterations < goal.maxIterations) {
        goal.status = "active";
      }
      // Lowering the budget below what's already spent must block, not leave
      // one free over-budget action on the table.
      if (goal.status === "active" && goal.usedIterations >= goal.maxIterations) {
        goal.status = "blocked";
      }
    }
    if (patch.status !== undefined) {
      // 'active' must not be a budget bypass: a goal with an exhausted budget
      // stays blocked until maxIterations is actually raised.
      if (patch.status === "active" && goal.usedIterations >= goal.maxIterations) {
        throw new Error(
          `Cannot reactivate '${goal.slug}': its iteration budget (${goal.usedIterations}/${goal.maxIterations}) is exhausted. Raise maxIterations instead.`,
        );
      }
      goal.status = patch.status;
    }
    goal.updatedAt = new Date().toISOString();
    this.store.saveGoal(goal);
    return goal;
  }

  deleteGoal(ref: string): Goal {
    const goal = this.getGoal(ref);
    this.store.deleteGoal(goal.id);
    return goal;
  }

  // ----- the assess step -----

  async assess(ref: string): Promise<ConvergenceReport> {
    const goal = this.getGoal(ref);
    if (goal.status === "abandoned") {
      throw new Error(
        `Goal '${goal.slug}' is abandoned. Resume it first with goal_update {status: 'active'} if you want to assess it.`,
      );
    }

    const evaluations: CriterionEvaluation[] = await Promise.all(
      goal.criteria.map(async (criterion): Promise<CriterionEvaluation> => {
        const started = Date.now();
        const envelope = await runProbe(criterion.probe, this.connectors);
        const result = evaluateAssertion(envelope, criterion.assert);
        // A probe that failed at the transport level (nonzero exit, timeout,
        // connector failure, parse error) must not satisfy a criterion —
        // unless the assertion's path IS a transport field (exact match: a
        // path like output.status targets the body, not the transport), in
        // which case inspecting failure IS the criterion. Silent false
        // convergence is the one unforgivable bug in a harness whose promise
        // is deterministic verification.
        const inspectsTransport = /^(exitCode|status|stderr|error)$/.test(
          (criterion.assert.path ?? "").trim(),
        );
        const pass = result.pass && (!envelope.error || inspectsTransport);
        const error = [
          envelope.error,
          result.error,
          result.pass && !pass ? "assertion passed but the probe itself failed — failing the criterion" : undefined,
        ]
          .filter(Boolean)
          .join("; ");
        return {
          id: criterion.id,
          description: criterion.description,
          pass,
          actual: capActual(result.actual),
          expected: {
            op: criterion.assert.op,
            value: criterion.assert.value,
            path: criterion.assert.path ?? "output",
          },
          ...(error ? { error } : {}),
          ...(result.note ? { note: result.note } : {}),
          durationMs: Date.now() - started,
        };
      }),
    );

    // Probes can run for minutes; the goal may have been recorded against,
    // updated, or deleted meanwhile. Re-fetch and apply ONLY assess-derived
    // fields to the fresh copy — persisting the pre-probe snapshot would
    // silently roll back concurrent writes (budget increments, status
    // changes) or resurrect a deleted goal.
    const fresh = this.store.getGoal(goal.id);
    if (!fresh) {
      throw new Error(`Goal '${goal.slug}' was deleted while it was being assessed.`);
    }
    if (fresh.status === "abandoned") {
      throw new Error(
        `Goal '${goal.slug}' was abandoned while it was being assessed; discarding the result.`,
      );
    }

    const converged = evaluations.every((e) => e.pass);
    const wasConverged = fresh.status === "converged";
    const driftDetected = wasConverged && !converged;
    const now = new Date().toISOString();

    fresh.lastAssessedAt = now;
    if (converged && !wasConverged) {
      fresh.status = "converged";
      fresh.convergedAt = now;
      this.promoteWorkflow(fresh);
    } else if (driftDetected) {
      // Reconverging after drift still costs iterations — an exhausted budget
      // means the regression needs a human, not a silently re-armed agent.
      fresh.status =
        fresh.usedIterations >= fresh.maxIterations ? "blocked" : "active";
      fresh.convergedAt = null;
    }
    fresh.updatedAt = now;
    this.store.saveGoal(fresh);

    const suggestions = converged ? [] : this.suggestWorkflows(fresh);
    const patternNow = new Date(now);
    const patterns = converged
      ? []
      : relevantPatterns(this.store, `${fresh.objective} ${fresh.criteria.map((c) => c.description).join(" ")}`).map(
          (p) => ({
            name: p.name,
            description: p.description,
            steps: p.steps,
            // Surface the decayed stability (what retrieval ranks by and
            // pattern_list shows) — not the raw counter — so a long-dead
            // pattern doesn't read as well-worn in guidance.
            stability: Number(effectiveStability(p, patternNow).toFixed(2)),
          }),
        );

    const report = {
      goal: {
        id: fresh.id,
        slug: fresh.slug,
        objective: fresh.objective,
        status: fresh.status,
        autonomy: fresh.autonomy,
        constraints: fresh.constraints,
        iterationsUsed: fresh.usedIterations,
        iterationsRemaining: Math.max(0, fresh.maxIterations - fresh.usedIterations),
      },
      converged,
      driftDetected,
      criteria: evaluations,
      unmetCount: evaluations.filter((e) => !e.pass).length,
      suggestedWorkflows: suggestions,
      relevantPatterns: patterns,
      guidance: buildGuidance(fresh, evaluations, suggestions, { driftDetected, patterns }),
    };

    // Perception (M2): every assessment becomes episodic memory the learning
    // loop mines. A failure here must never break the assessment itself.
    // Only a FRESH convergence is a "convergence" transition — re-asserting an
    // already-converged goal is a plain assessment, or drift counts inflate.
    try {
      const observation = observationFromReport(report);
      if (observation.kind === "convergence" && wasConverged) {
        observation.kind = "assessment";
      }
      recordObservation(this.store, observation);
    } catch {
      // Observation recording is best-effort.
    }

    return report;
  }

  // ----- episodic recording -----

  recordAction(ref: string, input: RecordActionInput): { record: ActionRecord; goal: Goal } {
    const goal = this.getGoal(ref);
    if (goal.status === "blocked") {
      throw new Error(
        `Goal '${goal.slug}' is blocked: its iteration budget (${goal.maxIterations}) is exhausted. Raise it with goal_update {maxIterations} or abandon the goal.`,
      );
    }
    if (goal.status === "converged") {
      throw new Error(
        `Goal '${goal.slug}' is already converged — there is nothing to act on. Run goal_assess first; if the state drifted, the goal reactivates and recording resumes.`,
      );
    }
    if (goal.status === "abandoned") {
      throw new Error(
        `Goal '${goal.slug}' is abandoned. Resume it with goal_update {status: 'active'} before recording actions.`,
      );
    }
    goal.usedIterations += 1;
    if (goal.usedIterations >= goal.maxIterations) {
      goal.status = "blocked";
    }
    goal.updatedAt = new Date().toISOString();

    const record: ActionRecord = {
      id: newId("act"),
      goalId: goal.id,
      iteration: goal.usedIterations,
      summary: input.summary,
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.tool ? { tool: input.tool } : {}),
      result: input.result ?? "success",
      at: new Date().toISOString(),
    };
    this.store.appendRecord(record);
    this.store.saveGoal(goal);
    return { record, goal };
  }

  // ----- learning slice: trace → workflow, workflow → suggestion -----

  private promoteWorkflow(goal: Goal): WorkflowArtifact {
    const trace = this.store.listRecords(goal.id);
    const steps = trace
      .filter((r) => r.result !== "failure")
      .map((r) => ({
        summary: r.summary,
        ...(r.tool ? { tool: r.tool } : {}),
        result: r.result,
      }));

    const existing = this.store.getWorkflow(goal.slug);
    const now = new Date().toISOString();
    const workflow: WorkflowArtifact = existing
      ? {
          ...existing,
          objective: goal.objective,
          // Keep the richer trace: a re-convergence with no new actions
          // (steady-state check) shouldn't erase the learned steps.
          steps: steps.length > 0 ? steps : existing.steps,
          criteria: goal.criteria.map((c) => c.description),
          stats: {
            convergences: existing.stats.convergences + 1,
            // The trace is cumulative (all records ever), so this is an
            // absolute count, not an increment.
            totalActions: trace.length,
          },
          updatedAt: now,
        }
      : {
          id: newId("wf"),
          slug: goal.slug,
          objective: goal.objective,
          steps,
          criteria: goal.criteria.map((c) => c.description),
          stats: { convergences: 1, totalActions: trace.length },
          createdAt: now,
          updatedAt: now,
        };
    this.store.saveWorkflow(workflow);
    return workflow;
  }

  suggestWorkflows(goal: Goal): WorkflowSuggestion[] {
    const goalTokens = tokens(`${goal.objective} ${goal.slug}`);
    return this.store
      .listWorkflows()
      .filter((w) => w.slug !== goal.slug)
      .map((w) => ({
        slug: w.slug,
        objective: w.objective,
        similarity: jaccard(goalTokens, tokens(`${w.objective} ${w.slug}`)),
        convergences: w.stats.convergences,
        steps: w.steps,
      }))
      .filter((s) => s.similarity >= 0.2)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 2);
  }
}
