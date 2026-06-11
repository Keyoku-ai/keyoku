import { newId, Store } from "./store.js";
import type { ConvergenceReport, Observation } from "./types.js";

// ---------------------------------------------------------------------------
// M2 perception — turn convergence reports into observations (episodic memory
// of goal state over time) and summarize them for the driving agent.
// ---------------------------------------------------------------------------

/** Aggregate counts of a goal's observed state transitions. */
export interface StateTransitions {
  assessments: number;
  drifts: number;
  convergences: number;
  blocked: number;
  lastDriftAt?: string;
  lastConvergenceAt?: string;
}

/**
 * Distill a convergence report into an observation, ready for
 * `recordObservation` to stamp and persist.
 */
export function observationFromReport(
  report: ConvergenceReport,
): Omit<Observation, "id" | "at"> {
  const unmet = report.criteria.filter((c) => !c.pass).map((c) => c.id);
  const total = report.criteria.length;
  const kind = report.converged
    ? "convergence"
    : report.driftDetected
      ? "drift"
      : report.goal.status === "blocked"
        ? "blocked"
        : "assessment";
  const summary = report.converged
    ? `all ${total} criteria pass`
    : `${unmet.length}/${total} criteria unmet: ${unmet.join(", ")}`;
  return {
    goalId: report.goal.id,
    goalSlug: report.goal.slug,
    kind,
    summary,
    unmet,
  };
}

/** Stamp an observation with an id + timestamp and append it to the store. */
export function recordObservation(
  store: Store,
  partial: Omit<Observation, "id" | "at">,
): Observation {
  const observation: Observation = {
    ...partial,
    id: newId("obs"),
    at: new Date().toISOString(),
  };
  store.appendObservation(observation);
  return observation;
}

/**
 * Compact one-line-per-observation history for a goal, oldest first, capped
 * to the most recent `limit` entries. Empty string when nothing was observed.
 */
export function observationDigest(store: Store, goalId: string, limit = 50): string {
  return store
    .listObservations(goalId, limit)
    .map((o) => `${o.at} ${o.kind} ${o.summary}`)
    .join("\n");
}

/** Count state transitions across a goal's full observation history. */
export function stateTransitions(store: Store, goalId: string): StateTransitions {
  const transitions: StateTransitions = {
    assessments: 0,
    drifts: 0,
    convergences: 0,
    blocked: 0,
  };
  // Observations are stored oldest-first, so the last timestamp seen per kind
  // is the most recent one.
  for (const observation of store.listObservations(goalId)) {
    switch (observation.kind) {
      case "assessment":
        transitions.assessments += 1;
        break;
      case "drift":
        transitions.drifts += 1;
        transitions.lastDriftAt = observation.at;
        break;
      case "convergence":
        transitions.convergences += 1;
        transitions.lastConvergenceAt = observation.at;
        break;
      case "blocked":
        transitions.blocked += 1;
        break;
    }
  }
  return transitions;
}
