import { isActionEvent } from "./activity.js";
import { evaluateAssertion } from "./assert.js";
import type { ConnectorManager } from "./connectors.js";
import { buildGuidance } from "./guidance.js";
import { relevantPatterns } from "./learn.js";
import { observationFromReport, recordObservation } from "./observe.js";
import { runProbe } from "./probes.js";
import { effectiveStability } from "./types.js";
import type { SlmProvider } from "./slm.js";
import { newId, slugify, type Store } from "./store.js";
import type {
  ActionRecord,
  ActionResult,
  ActivityEvent,
  Autonomy,
  ConvergenceReport,
  Criterion,
  CriterionEvaluation,
  CriterionInput,
  FocusState,
  Goal,
  WorkflowArtifact,
  WorkflowStep,
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

// Workflow-suggestion tuning. Surfacing a learned workflow on a new goal is a
// recall decision, not a correctness one — so the relevance bar is a knob, not
// a magic number baked into the loop. Lower it to cast a wider net, raise it to
// suppress weak matches. The convergence core stays purely deterministic.
function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
function envInt(name: string, fallback: number): number {
  const n = envFloat(name, fallback);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}
const WORKFLOW_SUGGESTION_MIN_SIMILARITY = envFloat("KEYOKU_WF_MIN_SIMILARITY", 0.2);
const WORKFLOW_SUGGESTION_LIMIT = envInt("KEYOKU_WF_SUGGEST_LIMIT", 2);

// Self-pruning. A workflow that keeps matching new goals on shared words but
// whose steps never actually recur in those goals is a noisy match — it should
// sink, not keep crowding out genuinely reusable workflows. We learn this from
// outcomes: at each convergence we score the neighbours that were relevant
// (`suggested`) against whether this goal's trace overlapped their steps
// (`helped`), and rank later suggestions by similarity × precision. It's a
// DOWNRANK, never a hard hide (a floor keeps a low-precision workflow available
// when nothing better exists), it only kicks in once a workflow has enough
// signal, and `KEYOKU_WF_SELF_PRUNE=0` disables it entirely → pure jaccard.
// Recall (which workflows are eligible) stays the deterministic jaccard gate.
const WORKFLOW_PRECISION_MIN_SIGNAL = envInt("KEYOKU_WF_PRECISION_MIN_SIGNAL", 3);
const WORKFLOW_PRECISION_FLOOR = envFloat("KEYOKU_WF_PRECISION_FLOOR", 0.25);
const WORKFLOW_HELP_OVERLAP_MIN = envFloat("KEYOKU_WF_HELP_OVERLAP", 0.3);

/** Normalize a step summary for cross-goal overlap matching: drop a leading
 *  tool prefix ("Bash: …"), lowercase, trim, and cap so trivial variation
 *  (a path tail, a flag) doesn't defeat the comparison. */
function normStep(summary: string): string {
  return summary.toLowerCase().replace(/^[a-z_][\w-]*:\s*/, "").trim().slice(0, 50);
}

// Activity-backfill cap: when a goal converges with nothing recorded, at most
// this many inferred steps are lifted from the activity log so the workflow
// isn't a hollow shell. A bound, not a retention contract.
const MAX_BACKFILL_STEPS = 30;
// How far BEFORE a goal was created to look for its work. Build-then-verify
// often means: do the work, THEN declare the goal and assess once — so the real
// actions sit just before createdAt. (Real-data check: two converged goals had
// 2–4s lifetimes because all work preceded goal_create.) A lookback knob.
const BACKFILL_LOOKBACK_MS = envInt("KEYOKU_BACKFILL_LOOKBACK_MIN", 45) * 60_000;
// When more steps are inferred than the cap allows, keep the first HEAD (setup)
// plus the most recent tail — a long build shouldn't lose how it was set up.
const BACKFILL_HEAD_STEPS = envInt("KEYOKU_BACKFILL_HEAD_STEPS", 8);

/** Same project subtree: equal, or one is a path-prefix of the other — so
 * monorepo subdirs stay together while sibling projects don't merge. */
function sameProject(a: string, b: string): boolean {
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

/** Cap a step list keeping the first `head` (setup) and the most recent
 * `max - head` (build/verify); a marker records the omission so the draft stays
 * honest about the gap. Lists at or under `max` pass through unchanged. */
function capHeadTail(steps: WorkflowStep[], max: number, head: number): WorkflowStep[] {
  if (steps.length <= max) return steps;
  const h = Math.max(0, Math.min(head, max - 1));
  const tail = steps.slice(-(max - h));
  const omitted = steps.length - h - tail.length;
  const marker: WorkflowStep = {
    summary: `… ${omitted} intermediate step${omitted === 1 ? "" : "s"} omitted …`,
    result: "success",
    source: "activity",
  };
  return [...steps.slice(0, h), marker, ...tail];
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
    // Optional lite model. When present AND opted in (KEYOKU_SLM_SUGGEST=1), it
    // re-ranks workflow suggestions by genuine relevance — a model decision, not
    // a token-overlap heuristic. Absent / off ⇒ deterministic jaccard order.
    readonly slm: SlmProvider | null = null,
  ) {}

  /** In-memory cache of SLM re-ranks, keyed by goal + candidate-set, so repeated
   *  assesses of the same goal (the protocol encourages assessing often) re-call the
   *  model at most once per distinct candidate set. Lives for the process lifetime. */
  private readonly rerankCache = new Map<string, string[]>();

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
    const focus = this.store.getFocus();
    if (focus && focus.goalId === goal.id) this.store.setFocus(null);
    return goal;
  }

  // ----- focus (live capture) -----

  /** Mark a goal as the live-capture focus: while focused, the activity
   * recorder also appends each real action to this goal's trace (source:
   * "activity"), so the run becomes muscle memory live. Scoped to the given
   * cwd/session so concurrent work on one ~/.keyoku doesn't bleed in. */
  setFocus(ref: string, scope: { cwd?: string; sessionId?: string } = {}): FocusState {
    const goal = this.getGoal(ref);
    if (goal.status !== "active") {
      throw new Error(
        `Can only focus an active goal — '${goal.slug}' is ${goal.status}. Reactivate it first if you mean to keep working on it.`,
      );
    }
    const focus: FocusState = {
      goalId: goal.id,
      goalSlug: goal.slug,
      ...(scope.cwd ? { cwd: scope.cwd } : {}),
      ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
      at: new Date().toISOString(),
    };
    this.store.setFocus(focus);
    return focus;
  }

  clearFocus(): FocusState | null {
    const focus = this.store.getFocus();
    this.store.setFocus(null);
    return focus;
  }

  getFocus(): FocusState | null {
    return this.store.getFocus();
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
      // Self-pruning: now that this goal has converged with a known trace, score
      // the neighbouring workflows that were relevant to it — did their steps
      // actually recur here? Only at a FRESH convergence (not on every retroactive
      // record / re-assert) so the signal isn't inflated.
      this.recordSuggestionOutcomes(fresh);
      // Focus is per-goal intent; once converged, stop live-capturing to it.
      const focus = this.store.getFocus();
      if (focus && focus.goalId === fresh.id) this.store.setFocus(null);
    } else if (driftDetected) {
      // Reconverging after drift still costs iterations — an exhausted budget
      // means the regression needs a human, not a silently re-armed agent.
      fresh.status =
        fresh.usedIterations >= fresh.maxIterations ? "blocked" : "active";
      fresh.convergedAt = null;
    }
    fresh.updatedAt = now;
    this.store.saveGoal(fresh);

    const suggestions = converged
      ? []
      : await this.rerankSuggestions(fresh, this.suggestWorkflows(fresh));
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
      guidance: buildGuidance(fresh, evaluations, suggestions, {
        driftDetected,
        patterns,
        // Honest convergence message: only claim a workflow was learned if one
        // actually exists (a zero-action convergence has none — nudge to record).
        workflowPromoted: converged ? this.store.getWorkflow(fresh.slug) != null : undefined,
      }),
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
    if (goal.status === "abandoned") {
      throw new Error(
        `Goal '${goal.slug}' is abandoned. Resume it with goal_update {status: 'active'} before recording actions.`,
      );
    }
    // A converged goal still accepts records — retroactively. This is how a
    // "build-then-verify" run (do the work, THEN assess once) captures the trace
    // that ACHIEVED convergence so it becomes a reusable workflow ("muscle
    // memory" — the product's promise). Retroactive records document what already
    // happened: they do NOT consume the corrective-action budget, do NOT change
    // status, and re-promote the workflow so the steps are actually learned.
    const retroactive = goal.status === "converged";
    if (goal.status === "blocked") {
      throw new Error(
        `Goal '${goal.slug}' is blocked: its iteration budget (${goal.maxIterations}) is exhausted. Raise it with goal_update {maxIterations} or abandon the goal.`,
      );
    }
    if (!retroactive) {
      goal.usedIterations += 1;
      if (goal.usedIterations >= goal.maxIterations) {
        goal.status = "blocked";
      }
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
    // The trace of a converged goal just grew — refresh its workflow so the
    // retroactively-captured steps become muscle memory.
    if (retroactive) this.promoteWorkflow(goal);
    return { record, goal };
  }

  // ----- learning slice: trace → workflow, workflow → suggestion -----

  private promoteWorkflow(goal: Goal): WorkflowArtifact | null {
    const trace = this.store.listRecords(goal.id);
    const steps = trace
      .filter((r) => r.result !== "failure")
      .map((r) => ({
        summary: r.summary,
        ...(r.tool ? { tool: r.tool } : {}),
        ...(r.detail ? { detail: r.detail } : {}),
        result: r.result,
        ...(r.source ? { source: r.source } : {}),
      }));
    // Failed approaches are negative muscle memory — capture them so a similar
    // goal doesn't repeat the dead ends.
    const failures = trace.filter((r) => r.result === "failure").map((r) => r.summary);

    const existing = this.store.getWorkflow(goal.slug);
    // Build-then-verify: the goal converged but the agent recorded nothing
    // through goal_record. The real work still happened — it's sitting in the
    // activity log — so infer the steps from there rather than learn a hollow
    // workflow. Inferred steps are labeled source:"activity" to stay honest
    // about provenance, and an explicit goal_record always wins over inference.
    const effectiveSteps: WorkflowStep[] =
      steps.length > 0 ? steps : this.backfillStepsFromActivity(goal);
    // Promote only when there is something to learn — steps (recorded OR
    // inferred), pitfalls, or an existing workflow to preserve. A convergence
    // with no records AND no relevant activity learns nothing and must not
    // become a hollow artifact; a retroactive goal_record then promotes it.
    if (effectiveSteps.length === 0 && failures.length === 0 && !existing) return null;
    // Deduped, newest-last, capped — pitfalls accumulate across re-convergences.
    const pitfalls = [...new Set([...(existing?.pitfalls ?? []), ...failures])].slice(-20);
    const now = new Date().toISOString();
    const workflow: WorkflowArtifact = existing
      ? {
          ...existing,
          objective: goal.objective,
          // Keep the richer trace: a re-convergence with no new actions
          // (steady-state check) shouldn't erase the learned steps.
          steps: effectiveSteps.length > 0 ? effectiveSteps : existing.steps,
          criteria: goal.criteria.map((c) => c.description),
          ...(pitfalls.length > 0 ? { pitfalls } : {}),
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
          steps: effectiveSteps,
          criteria: goal.criteria.map((c) => c.description),
          ...(pitfalls.length > 0 ? { pitfalls } : {}),
          stats: { convergences: 1, totalActions: trace.length },
          createdAt: now,
          updatedAt: now,
        };
    this.store.saveWorkflow(workflow);
    return workflow;
  }

  /**
   * Infer workflow steps for a goal that converged with nothing recorded
   * (build-then-verify). Scope = action events — mutating Bash / Edit / Write /
   * connector calls, never inspection or the harness's own bookkeeping —
   * within [createdAt − lookback, convergedAt], narrowed to the dominant session
   * and cwd-subtree so concurrent projects don't bleed in, then capped head+tail
   * so a long build keeps its setup. Deterministic and synchronous: it lifts
   * what actually happened from the activity log, it does not decide anything.
   * The log interleaves concurrent sessions, so this is a best-effort draft
   * (labeled source:"activity"), not a verified trace; the SLM-backed
   * workflow_suggest / harness_learn passes can refine it. The point is to stop
   * the product's headline feature — muscle memory — from silently producing
   * empty workflows just because the agent didn't call goal_record mid-run.
   */
  private backfillStepsFromActivity(goal: Goal): WorkflowStep[] {
    const created = Date.parse(goal.createdAt);
    if (Number.isNaN(created)) return [];
    // Window = [createdAt − lookback, convergedAt | now]. The lookback catches
    // work done just before the goal was declared (build-then-verify); the
    // upper bound keeps a goal converged in the past from sweeping in later,
    // unrelated activity.
    const since = created - BACKFILL_LOOKBACK_MS;
    const until = goal.convergedAt ? Date.parse(goal.convergedAt) : Date.now();
    const candidates = this.store.listActivity().filter((e) => {
      const t = Date.parse(e.at);
      if (Number.isNaN(t) || t < since || t > until) return false;
      const tool = e.tool ?? "";
      // The harness's own MCP calls (goal_*, workflow_*, …) are bookkeeping, not
      // the work being learned.
      if (tool.startsWith("mcp__keyoku__") || tool.startsWith("keyoku")) return false;
      return isActionEvent(e);
    });
    if (candidates.length === 0) return [];
    // The global log interleaves concurrent sessions — project A's edits sit
    // next to project B's. Scope to the single session that did the most work in
    // this window (the build-then-verify stream) so a goal doesn't inherit
    // another project's actions. Same within-session principle the pattern miner
    // uses; an SLM pass can refine further. (Real-data check: this is what
    // stopped a headroom goal from absorbing job-search edits.)
    const perSession = new Map<string, number>();
    for (const e of candidates) {
      const s = e.sessionId ?? "_";
      perSession.set(s, (perSession.get(s) ?? 0) + 1);
    }
    let dominant = "_";
    let best = -1;
    for (const [s, n] of perSession) {
      if (n > best) {
        best = n;
        dominant = s;
      }
    }
    let scoped = candidates.filter((e) => (e.sessionId ?? "_") === dominant);
    // Within that session, narrow to the dominant cwd-subtree for precise
    // attribution — one session can touch several projects. Events without a cwd
    // are kept: we can't attribute them, and dropping them would lose real work.
    const withCwd = scoped.filter((e) => e.cwd);
    if (withCwd.length > 0) {
      const perCwd = new Map<string, number>();
      for (const e of withCwd) {
        const c = e.cwd as string;
        perCwd.set(c, (perCwd.get(c) ?? 0) + 1);
      }
      let domCwd = "";
      let bestCwd = -1;
      for (const [c, n] of perCwd) {
        if (n > bestCwd) {
          bestCwd = n;
          domCwd = c;
        }
      }
      scoped = scoped.filter((e) => !e.cwd || sameProject(e.cwd, domCwd));
    }
    // Collapse consecutive identical actions (a formatter rewriting one file ten
    // times is one step, not ten), then cap to the most recent steps.
    const steps: WorkflowStep[] = [];
    let lastKey = "";
    for (const e of scoped) {
      const summary = e.summary.slice(0, 200);
      const key = `${e.tool ?? e.type}:${summary}`;
      if (key === lastKey) continue;
      lastKey = key;
      steps.push({
        summary,
        ...(e.tool ? { tool: e.tool } : {}),
        ...(e.detail ? { detail: e.detail.slice(0, 500) } : {}),
        result: "success" as const,
        source: "activity" as const,
      });
    }
    return capHeadTail(steps, MAX_BACKFILL_STEPS, BACKFILL_HEAD_STEPS);
  }

  /**
   * Record, at a fresh convergence, how the workflows that were RELEVANT to this
   * goal actually fared: each topically-eligible neighbour gets `suggested`++ ,
   * and `helped`++ when this goal's learned trace overlapped its steps (the
   * pattern genuinely recurred). suggestWorkflows() then ranks by precision, so a
   * workflow that keeps word-matching but never recurs sinks. Deterministic,
   * best-effort (never breaks a convergence), and a no-op when the converged goal
   * has no learnable steps (we can't judge "help" from nothing, so we don't
   * penalise neighbours for it) or when KEYOKU_WF_SELF_PRUNE=0.
   */
  private recordSuggestionOutcomes(goal: Goal): void {
    try {
      if (process.env.KEYOKU_WF_SELF_PRUNE === "0") return;
      const own = this.store.getWorkflow(goal.slug);
      const goalKeys = new Set((own?.steps ?? []).map((s) => normStep(s.summary)).filter((k) => k.length >= 3));
      if (goalKeys.size === 0) return; // nothing to judge overlap against
      const goalTokens = tokens(`${goal.objective} ${goal.slug}`);
      const now = new Date().toISOString();
      for (const w of this.store.listWorkflows()) {
        if (w.slug === goal.slug || w.steps.length === 0) continue;
        const sim = jaccard(goalTokens, tokens(`${w.objective} ${w.slug}`));
        if (sim < WORKFLOW_SUGGESTION_MIN_SIMILARITY) continue; // wouldn't have surfaced
        const matched = w.steps.filter((s) => {
          const k = normStep(s.summary);
          if (k.length < 3) return false;
          for (const gk of goalKeys) if (gk === k || gk.includes(k) || k.includes(gk)) return true;
          return false;
        }).length;
        const helped = matched / w.steps.length >= WORKFLOW_HELP_OVERLAP_MIN;
        w.stats.suggested = (w.stats.suggested ?? 0) + 1;
        if (helped) w.stats.helped = (w.stats.helped ?? 0) + 1;
        w.updatedAt = now;
        this.store.saveWorkflow(w);
      }
    } catch {
      // Outcome tracking is best-effort — it must never break a convergence.
    }
  }

  suggestWorkflows(goal: Goal): WorkflowSuggestion[] {
    const goalTokens = tokens(`${goal.objective} ${goal.slug}`);
    const selfPrune = process.env.KEYOKU_WF_SELF_PRUNE !== "0";
    // Precision multiplier: 1.0 until a workflow has enough outcome signal, then
    // helped/suggested, floored so a low-precision workflow is pushed down but
    // never fully erased (it can still surface when nothing better matches).
    const precision = (w: WorkflowArtifact): number => {
      const suggested = w.stats.suggested ?? 0;
      if (!selfPrune || suggested < WORKFLOW_PRECISION_MIN_SIGNAL) return 1;
      return Math.max(WORKFLOW_PRECISION_FLOOR, (w.stats.helped ?? 0) / suggested);
    };
    return this.store
      .listWorkflows()
      .filter((w) => w.slug !== goal.slug && w.steps.length > 0)
      .map((w) => {
        const similarity = jaccard(goalTokens, tokens(`${w.objective} ${w.slug}`));
        return {
          // recall gate stays pure jaccard; precision only reorders.
          eligible: similarity >= WORKFLOW_SUGGESTION_MIN_SIMILARITY,
          score: similarity * precision(w),
          suggestion: {
            slug: w.slug,
            objective: w.objective,
            similarity,
            convergences: w.stats.convergences,
            steps: w.steps,
            ...(w.pitfalls && w.pitfalls.length > 0 ? { pitfalls: w.pitfalls } : {}),
          } as WorkflowSuggestion,
        };
      })
      .filter((x) => x.eligible)
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.suggestion.similarity - a.suggestion.similarity ||
          b.suggestion.convergences - a.suggestion.convergences,
      )
      .slice(0, WORKFLOW_SUGGESTION_LIMIT)
      .map((x) => x.suggestion);
  }

  /**
   * Re-rank/filter jaccard candidates by genuine relevance using the lite model
   * (the "no heuristics — a cheap model decides" path). Jaccard is fast recall but
   * misses paraphrase and over-matches shared filler words; the model judges what
   * actually applies to THIS goal. Strictly additive and fail-safe: returns the
   * jaccard order unchanged when there's no SLM, it's not opted in
   * (KEYOKU_SLM_SUGGEST=1), there's nothing to disambiguate (<2), or anything goes
   * wrong — so the deterministic offline path is always intact.
   */
  private async rerankSuggestions(
    goal: Goal,
    suggestions: WorkflowSuggestion[],
  ): Promise<WorkflowSuggestion[]> {
    // On by default when a lite model is configured (a relevance decision is a model
    // call, per the no-heuristics principle); set KEYOKU_SLM_SUGGEST=0 to force the
    // deterministic jaccard order. Nothing to disambiguate (<2) ⇒ skip.
    if (!this.slm || suggestions.length < 2 || process.env.KEYOKU_SLM_SUGGEST === "0") {
      return suggestions;
    }
    // Cache by goal + the exact candidate set, so assessing often costs at most one
    // model call per distinct set. A changed candidate set is a new key ⇒ re-ranked.
    const cacheKey = `${goal.slug}::${suggestions.map((s) => s.slug).sort().join(",")}`;
    const cached = this.rerankCache.get(cacheKey);
    if (cached) return this.applyOrder(suggestions, cached);
    try {
      const list = suggestions
        .map((s, i) => `${i + 1}. [${s.slug}] ${s.objective}`)
        .join("\n");
      const prompt = `A coding agent is working toward this goal:\n"${goal.objective}"\n\nCandidate learned workflows from past goals:\n${list}\n\nReturn ONLY the ones genuinely relevant to achieving this goal, most relevant first. Reply with JSON only: {"relevant": [<1-based candidate numbers>]}. Omit irrelevant candidates; return an empty array if none apply.`;
      const raw = await this.slm.complete(prompt, { json: true, maxTokens: 200 });
      const parsed = JSON.parse(raw) as { relevant?: unknown };
      if (!Array.isArray(parsed.relevant)) return suggestions;
      const picked = parsed.relevant
        .map((n) => (typeof n === "number" ? suggestions[n - 1] : undefined))
        .filter((s): s is WorkflowSuggestion => Boolean(s));
      // A model that returned malformed/empty selection shouldn't blank out real
      // recall — fall back to the deterministic order in that case.
      if (picked.length === 0) return suggestions;
      this.rerankCache.set(cacheKey, picked.map((s) => s.slug));
      return picked;
    } catch {
      return suggestions;
    }
  }

  /** Reorder/filter the current suggestions to a cached slug ranking (a stale slug
   *  simply drops out; an empty result falls back to the given order). */
  private applyOrder(
    suggestions: WorkflowSuggestion[],
    slugs: string[],
  ): WorkflowSuggestion[] {
    const bySlug = new Map(suggestions.map((s) => [s.slug, s]));
    const ordered = slugs
      .map((sl) => bySlug.get(sl))
      .filter((s): s is WorkflowSuggestion => Boolean(s));
    return ordered.length > 0 ? ordered : suggestions;
  }
}

/**
 * Live capture: if a goal is focused (goal_focus) and this activity event is
 * real work that belongs to the focus, append it to the goal's trace as a
 * source:"activity" record. Called from BOTH the PostToolUse hook and the
 * activity_record MCP tool so either entry point feeds muscle memory live.
 *
 * Safe by construction: only ACTION events (never inspection or the harness's
 * own mcp__keyoku__* calls), only ACTIVE goals, scoped to the focus's session
 * or cwd-subtree so concurrent work on one ~/.keyoku doesn't bleed in, deduped
 * against the previous record, and appended WITHOUT spending the corrective
 * iteration budget (observed ≠ corrective). Never throws — a recording failure
 * must not break the hook.
 */
export function autoRecordToFocusGoal(store: Store, event: ActivityEvent): void {
  try {
    const focus = store.getFocus();
    if (!focus) return;
    const tool = event.tool ?? "";
    if (tool.startsWith("mcp__keyoku__") || tool.startsWith("keyoku")) return;
    if (!isActionEvent(event)) return;
    // Attribution gate. Session is authoritative when known on both sides: if
    // the focus is pinned to a session and this event came from a different one,
    // it's another session's work — reject it even if the cwd matches. Otherwise
    // fall back to cwd-subtree; a fully unscoped focus accepts everything.
    const focusSession = focus.sessionId;
    const evSession = event.sessionId;
    if (focusSession !== undefined && evSession !== undefined && focusSession !== evSession) return;
    const sessionMatch = focusSession !== undefined && evSession === focusSession;
    const a = event.cwd;
    const b = focus.cwd;
    const cwdMatch =
      b !== undefined && a !== undefined && (a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`));
    const unscoped = focusSession === undefined && focus.cwd === undefined;
    if (!sessionMatch && !cwdMatch && !unscoped) return;
    const goal = store.getGoal(focus.goalId);
    if (!goal || goal.status !== "active") return; // never live-record to a non-active goal
    const summary = event.summary.slice(0, 200);
    // Dedup against the immediately previous record (a formatter saving one file
    // ten times is one step).
    const recs = store.listRecords(goal.id);
    const last = recs[recs.length - 1];
    if (last && last.summary === summary && last.tool === event.tool) return;
    // Pin the session on the first matching action: once a session has done real
    // work toward this focused goal, later events must match it — so a second
    // session in the same project can't start writing into this goal's trace.
    if (focusSession === undefined && evSession !== undefined) {
      store.setFocus({ ...focus, sessionId: evSession });
    }
    store.appendRecord({
      id: newId("act"),
      goalId: goal.id,
      iteration: goal.usedIterations, // observed, not a corrective iteration
      summary,
      ...(event.detail ? { detail: event.detail.slice(0, 500) } : {}),
      ...(event.tool ? { tool: event.tool } : {}),
      result: "success",
      source: "activity",
      at: event.at,
    });
  } catch {
    // best-effort: recording must never break the hook
  }
}
