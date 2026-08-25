import {
  checkpointIteration,
  currentIterationInstruction,
  readIteration,
  startIteration,
  type IterationState,
} from "./iteration.js";
import { findProjectRoot } from "./contribution.js";

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

function positiveNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${flag} must be a positive number.`);
  return parsed;
}

function nonnegativeNumber(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${flag} must be a nonnegative number.`);
  return parsed;
}

function format(state: IterationState): string {
  const last = state.rounds.at(-1);
  return [
    `${state.status.replaceAll("_", " ").toUpperCase()} — ${state.outcomeId}`,
    `Session: ${state.id}`,
    `Contribution: ${state.contributionId}`,
    `Rounds: ${state.rounds.length}/${state.limits.maxRounds}`,
    `Evidence: ${last ? `${last.automated.passed}/${last.automated.total} automated; ${last.humanReview.pending} human pending` : "not evaluated"}`,
    `Source: ${last ? `${last.repository.headSha.slice(0, 12)}+${last.repository.worktreeDigest.slice(0, 12)}${last.repository.dirty ? " dirty" : " clean"}` : "not captured"}`,
    `Usage: ${state.usage.inputTokens + state.usage.outputTokens} reported tokens; $${state.usage.costUsd.toFixed(6)} reported cost`,
    ...(state.stopReason ? [`Stop: ${state.stopReason}`] : []),
    ...(state.currentInstruction ? ["", "Next instruction:", JSON.stringify(state.currentInstruction, null, 2)] : []),
  ].join("\n");
}

export function iterationHelp(): string {
  return `Keyoku behavior iteration

Usage:
  keyoku iterate start <outcome> [--max-rounds N] [--max-minutes N] [--max-no-progress N] [--max-tokens N] [--max-cost-usd N] [--json]
  keyoku iterate status <session> [--json]
  keyoku iterate next <session> [--json]
  keyoku iterate checkpoint <session> --idempotency-key <id> --summary <text> [--input-tokens N] [--output-tokens N] [--cached-input-tokens N] [--tool-calls N] [--cost-usd N] [--usage-source agent_reported|provider_receipt|unknown] [--json]

Keyoku evaluates repository-owned behavior, issues a bounded repair instruction,
and re-evaluates only after an agent checkpoint. It never fills human judgments,
accepts a contribution, or infers provider usage from chat messages.`;
}

export async function iterationCmd(argv: string[]): Promise<void> {
  const sub = argv[0] ?? "help";
  const json = argv.includes("--json");
  if (sub === "help" || sub === "--help" || sub === "-h") {
    console.log(iterationHelp());
    return;
  }
  const root = findProjectRoot();
  let state: IterationState;
  if (sub === "start") {
    const outcomeId = argv[1];
    if (!outcomeId || outcomeId.startsWith("--")) throw new Error("Usage: keyoku iterate start <outcome> [limits] [--json]");
    const maxRounds = positiveNumber(flagValue(argv, "--max-rounds"), "--max-rounds");
    const maxMinutes = positiveNumber(flagValue(argv, "--max-minutes"), "--max-minutes");
    const maxNoProgressRounds = positiveNumber(flagValue(argv, "--max-no-progress"), "--max-no-progress");
    const maxTokens = positiveNumber(flagValue(argv, "--max-tokens"), "--max-tokens");
    const maxCostUsd = positiveNumber(flagValue(argv, "--max-cost-usd"), "--max-cost-usd");
    state = await startIteration({ root, outcomeId, limits: {
      ...(maxRounds !== undefined ? { maxRounds } : {}),
      ...(maxMinutes !== undefined ? { maxDurationMs: Math.round(maxMinutes * 60_000) } : {}),
      ...(maxNoProgressRounds !== undefined ? { maxNoProgressRounds } : {}),
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    } });
  } else if (sub === "status") {
    const sessionId = argv[1];
    if (!sessionId || sessionId.startsWith("--")) throw new Error("Usage: keyoku iterate status <session> [--json]");
    state = readIteration(root, sessionId);
  } else if (sub === "next") {
    const sessionId = argv[1];
    if (!sessionId || sessionId.startsWith("--")) throw new Error("Usage: keyoku iterate next <session> [--json]");
    const instruction = currentIterationInstruction(root, sessionId);
    if (!instruction) throw new Error(`Iteration '${sessionId}' has no pending agent instruction.`);
    console.log(json ? JSON.stringify({ sessionId, instruction }, null, 2) : JSON.stringify(instruction, null, 2));
    return;
  } else if (sub === "checkpoint") {
    const sessionId = argv[1];
    const checkpointId = flagValue(argv, "--idempotency-key");
    const summary = flagValue(argv, "--summary");
    if (!sessionId || sessionId.startsWith("--") || !checkpointId || !summary) throw new Error("Usage: keyoku iterate checkpoint <session> --idempotency-key <id> --summary <text> [usage] [--json]");
    const usageSource = flagValue(argv, "--usage-source");
    if (usageSource && !["agent_reported", "provider_receipt", "unknown"].includes(usageSource)) throw new Error("--usage-source must be agent_reported, provider_receipt, or unknown.");
    state = await checkpointIteration({
      root,
      sessionId,
      checkpointId,
      summary,
      usage: {
        inputTokens: nonnegativeNumber(flagValue(argv, "--input-tokens"), "--input-tokens") ?? 0,
        outputTokens: nonnegativeNumber(flagValue(argv, "--output-tokens"), "--output-tokens") ?? 0,
        cachedInputTokens: nonnegativeNumber(flagValue(argv, "--cached-input-tokens"), "--cached-input-tokens") ?? 0,
        toolCalls: nonnegativeNumber(flagValue(argv, "--tool-calls"), "--tool-calls") ?? 0,
        costUsd: nonnegativeNumber(flagValue(argv, "--cost-usd"), "--cost-usd") ?? 0,
      },
      usageSource: (usageSource as "agent_reported" | "provider_receipt" | "unknown" | undefined) ?? "unknown",
    });
  } else {
    throw new Error(iterationHelp());
  }
  console.log(json ? JSON.stringify(state, null, 2) : format(state));
}
