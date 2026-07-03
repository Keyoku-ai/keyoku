import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { detectPatterns, type ActivitySuggestion } from "./activity.js";
import type { ActivityEvent } from "./types.js";

// ---------------------------------------------------------------------------
// Proactive surfacing — the push side of the intelligence layer. The hooks
// (PostToolUse via `keyoku record`, SessionStart via `keyoku brief`) inject
// these messages as context, so the agent offers ripe workflows without
// anyone asking. Discipline: each pattern is surfaced ONCE per life (tracked
// in surfaced.json), and nudges speak to the agent, not over the user.
// ---------------------------------------------------------------------------

export function surfacedPath(home: string): string {
  return join(home, "surfaced.json");
}

export function loadSurfaced(home: string): Set<string> {
  try {
    const arr = JSON.parse(readFileSync(surfacedPath(home), "utf8"));
    return new Set(Array.isArray(arr) ? arr.filter((x) => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

export function saveSurfaced(home: string, surfaced: Set<string>): void {
  // Bounded: pattern keys are short and patterns are few; keep the tail.
  writeFileSync(surfacedPath(home), JSON.stringify([...surfaced].slice(-500)), { mode: 0o600 });
}

/** Ripe = runnable patterns not yet surfaced. Practice patterns are filed
 * into knowledge by workflow_suggest, never nudged as run buttons. */
export function findRipe(events: ActivityEvent[], surfaced: Set<string>): ActivitySuggestion[] {
  return detectPatterns(events, 3, 2000).filter((s) => s.kind === "automation" && !surfaced.has(s.key));
}

// --- ripeness cache -----------------------------------------------------
// The long-running MCP server is the brain: it recomputes ripeness in the
// background and persists it here. The hooks are just the wire — they read
// this cache (milliseconds) instead of mining inline, and fall back to
// inline mining only when no server has run recently.

export interface RipeCache {
  at: string;
  suggestions: ActivitySuggestion[];
}

export function ripePath(home: string): string {
  return join(home, "ripe.json");
}

export function saveRipe(home: string, suggestions: ActivitySuggestion[]): void {
  writeFileSync(ripePath(home), JSON.stringify({ at: new Date().toISOString(), suggestions }), { mode: 0o600 });
}

/** Cached ripeness, or null when absent/stale (older than maxAgeMs). */
export function loadRipe(home: string, maxAgeMs = 10 * 60_000): RipeCache | null {
  try {
    const cache = JSON.parse(readFileSync(ripePath(home), "utf8")) as RipeCache;
    if (!Array.isArray(cache.suggestions)) return null;
    if (Date.now() - new Date(cache.at).getTime() > maxAgeMs) return null;
    return cache;
  } catch {
    return null;
  }
}

/** Hook-side resolution: prefer the server's background computation. */
export function resolveRipe(
  home: string,
  surfaced: Set<string>,
  loadEvents: () => ActivityEvent[],
): ActivitySuggestion[] {
  const cached = loadRipe(home);
  if (cached) return cached.suggestions.filter((s) => !surfaced.has(s.key));
  return findRipe(loadEvents(), surfaced);
}

/** Context line for the PostToolUse channel — addressed to the agent. */
export function formatNudge(s: ActivitySuggestion): string {
  return (
    `[keyoku] Repeated workflow detected (${s.count}× recently): ${s.name}. ` +
    `When it won't interrupt the user's current task, offer to save it — call workflow_suggest to review drafts, then workflow_approve.`
  );
}

/** Context line for the SessionStart channel. Empty string = stay silent. */
export function formatBrief(templateCount: number, ripeCount: number): string {
  if (templateCount === 0 && ripeCount === 0) return "";
  const parts: string[] = [];
  if (templateCount > 0) {
    parts.push(
      `${templateCount} approved workflow${templateCount === 1 ? "" : "s"} available (MCP prompts / workflow_execute)`,
    );
  }
  if (ripeCount > 0) {
    parts.push(
      `${ripeCount} repeated pattern${ripeCount === 1 ? "" : "s"} not yet saved — run workflow_suggest to review`,
    );
  }
  return `[keyoku] ${parts.join("; ")}.`;
}
