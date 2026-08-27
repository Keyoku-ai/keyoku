import type { AgentActivityLease, PulseEvent, PulseSourceIdentity, VerifiedCheckpoint } from "./pulse.js";
import { pulseDigest, sealPulseEvent, sealPulseSource, sealVerifiedCheckpoint } from "./pulse.js";

const T = (minute: number, second = 0): string => `2026-08-24T16:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}.000Z`;
const hex = (value: number, length: number): string => value.toString(16).repeat(length);

function source(root: string, step: number): PulseSourceIdentity {
  const headSha = hex(step + 1, 40);
  return sealPulseSource({
    canonicalRoot: root,
    branch: "main",
    baseSha: hex(1, 40),
    headSha,
    worktreeDigest: hex(step + 8, 64),
    ancestryShas: Array.from({ length: step }, (_, index) => hex(index + 1, 40)),
  });
}

function lease(input: {
  id: string;
  harness: string;
  projectId: string;
  projectName: string;
  agentId: string;
  agentName: string;
  taskId: string;
  taskTitle: string;
  outcome: string;
  root: string;
  source: PulseSourceIdentity;
  at: string;
}): AgentActivityLease {
  return {
    schemaVersion: "keyoku.dev/pulse-lease/v1alpha1",
    id: input.id,
    harness: input.harness,
    project: { id: input.projectId, name: input.projectName },
    runId: `${input.projectId}-run-20260824`,
    agent: { id: input.agentId, name: input.agentName },
    canonicalSourceRoot: input.root,
    task: { id: input.taskId, title: input.taskTitle, outcome: input.outcome },
    startedAt: input.at,
    heartbeatAt: input.at,
    state: "working",
    currentSource: input.source,
  };
}

function checkpoint(input: {
  id: string;
  projectId: string;
  outcomeId: string;
  runId: string;
  leaseId: string;
  title: string;
  change: string;
  why: string;
  at: string;
  source: PulseSourceIdentity;
  trigger?: VerifiedCheckpoint["materialTrigger"];
  limitations: string[];
  nextTask?: string;
  humanDecisionRequest?: VerifiedCheckpoint["humanDecisionRequest"];
  assets?: VerifiedCheckpoint["assets"];
}): VerifiedCheckpoint {
  return sealVerifiedCheckpoint({
    schemaVersion: "keyoku.dev/pulse-checkpoint/v1alpha1",
    id: input.id,
    projectId: input.projectId,
    outcomeId: input.outcomeId,
    runId: input.runId,
    leaseIds: [input.leaseId],
    title: input.title,
    changeSummary: input.change,
    whyItMatters: input.why,
    publishedAt: input.at,
    source: input.source,
    verification: {
      status: "attested",
      verifiedAt: input.at,
      methods: [{
        kind: "command",
        label: `${input.id} acceptance check`,
        reproduce: `./scripts/verify-checkpoint ${input.id}`,
        result: "Passed in the integration fixture",
        evidenceDigest: pulseDigest(`verification:${input.id}`),
      }],
    },
    evidenceBinding: { mode: "fixture", label: `${input.projectId} demonstration fixture; adapters must bind real Factfile bytes before delivery` },
    factfiles: [{
      id: `${input.id}-factfile`,
      projectId: input.projectId,
      outcomeId: input.outcomeId,
      path: `.keyoku/contributions/${input.id}/factfile.json`,
      digest: pulseDigest(`factfile:${input.id}`),
      sourceDigest: input.source.verifiedDigest,
      state: input.humanDecisionRequest ? "human_review_required" : "ready_for_review",
    }],
    assets: input.assets ?? [],
    limitations: input.limitations,
    nextTask: input.nextTask,
    humanDecisionRequest: input.humanDecisionRequest,
    materialTrigger: input.trigger ?? "verified_checkpoint",
  });
}

function started(id: string, at: string, value: AgentActivityLease): PulseEvent {
  return sealPulseEvent({ schemaVersion: "keyoku.dev/pulse-event/v1alpha1", id, type: "started", at, leaseId: value.id, lease: value });
}

function published(id: string, value: VerifiedCheckpoint): PulseEvent {
  return sealPulseEvent({ schemaVersion: "keyoku.dev/pulse-event/v1alpha1", id, type: "checkpoint_published", at: value.publishedAt, leaseId: value.leaseIds[0], checkpoint: value });
}

export interface PulseFixture {
  name: "generic" | "processyard";
  description: string;
  events: PulseEvent[];
  recommendedPlan: {
    now: string;
    staleAfterMs: number;
    debounceMs: number;
    deliveredContentDigests: string[];
  };
  coalescingPlan?: {
    now: string;
    staleAfterMs: number;
    debounceMs: number;
    deliveredContentDigests: string[];
  };
}

export function buildGenericPulseFixture(): PulseFixture {
  const root = "repo://example/checkout";
  const firstSource = source(root, 0);
  const verifiedSource = source(root, 1);
  const agentLease = lease({
    id: "generic-run-agent-1",
    harness: "generic-jsonl",
    projectId: "checkout-example",
    projectName: "Checkout Example",
    agentId: "agent-1",
    agentName: "Fixture agent",
    taskId: "restore-cart",
    taskTitle: "Restore the saved cart",
    outcome: "Returning shoppers recover the same products and quantities.",
    root,
    source: firstSource,
    at: T(0),
  });
  const verified = checkpoint({
    id: "cart-recovery-verified",
    projectId: "checkout-example",
    outcomeId: "restore-cart",
    runId: agentLease.runId,
    leaseId: agentLease.id,
    title: "Saved-cart fixture checkpoint",
    change: "The cart recovery path now restores product ids and quantities from the saved session.",
    why: "Returning shoppers can continue checkout without rebuilding their cart.",
    at: T(3),
    source: verifiedSource,
    limitations: ["Visual review of the empty-cart state is still pending."],
    nextTask: "Capture the empty-cart visual Factfile.",
  });
  const events = [
    started("generic-started", T(0), agentLease),
    sealPulseEvent({ schemaVersion: "keyoku.dev/pulse-event/v1alpha1", id: "generic-verifying", type: "verification_started", at: T(2), leaseId: agentLease.id, source: verifiedSource }),
    published("generic-checkpoint", verified),
    sealPulseEvent({ schemaVersion: "keyoku.dev/pulse-event/v1alpha1", id: "generic-completed", type: "completed", at: T(4), leaseId: agentLease.id, source: verifiedSource, checkpointId: verified.id }),
  ];
  return {
    name: "generic",
    description: "Harness-neutral JSONL/stdin fixture with one synthetic attested checkpoint; it is intentionally nondispatchable.",
    events,
    recommendedPlan: { now: T(5), staleAfterMs: 300_000, debounceMs: 0, deliveredContentDigests: [] },
  };
}

export function buildProcessyardPulseFixture(): PulseFixture {
  const root = "repo://processyard/main";
  const sources = Array.from({ length: 7 }, (_, index) => source(root, index));
  const development = lease({
    id: "processyard-development",
    harness: "codex",
    projectId: "processyard",
    projectName: "Processyard",
    agentId: "development-agent",
    agentName: "Development agent",
    taskId: "economy-theatre",
    taskTitle: "Build the Economy Theatre story",
    outcome: "A founder can see verified product progress without reading agent transcripts.",
    root,
    source: sources[0]!,
    at: T(0),
  });
  const evidence = lease({
    id: "processyard-evidence",
    harness: "claude-code",
    projectId: "processyard",
    projectName: "Processyard",
    agentId: "evidence-agent",
    agentName: "Evidence agent",
    taskId: "economy-theatre-evidence",
    taskTitle: "Capture human-readable product evidence",
    outcome: "The milestone story includes replayable UI evidence and explicit limitations.",
    root,
    source: sources[0]!,
    at: T(1),
  });
  const ci = lease({
    id: "processyard-ci",
    harness: "github-actions",
    projectId: "processyard",
    projectName: "Processyard",
    agentId: "verification-workflow",
    agentName: "Verification workflow",
    taskId: "economy-theatre-verification",
    taskTitle: "Verify the checkpoint boundary",
    outcome: "Every reported milestone is bound to a reproducible Factfile and exact source digest.",
    root,
    source: sources[0]!,
    at: T(2),
  });
  const milestoneData = [
    ["M0", "Outcome pinned", "The founder outcome and source boundary were recorded before implementation.", "The milestone story starts from an explicit definition of done."],
    ["M1", "Storefront path observed", "The current customer journey and evidence gaps were captured.", "Work begins from the real product path instead of an imagined interface."],
    ["M2", "Economy Theatre implemented", "The demonstration flow now shows the product outcome in a browser-facing experience.", "A non-technical stakeholder can understand the product without a terminal transcript."],
    ["M3", "Checks bound to source", "Automated checks and the changed-file boundary were bound to one source identity.", "Passing output can no longer drift away from the code it describes."],
    ["M4", "Owner decision isolated", "The remaining launch choice was separated from machine verification.", "The agent can continue independent work without manufacturing stakeholder consent."],
    ["M5", "Evidence story staged", "A poster and replay path were declared in the synthetic checkpoint.", "The fixture shows the intended evidence shape but cannot claim the referenced bytes exist."],
    ["M6", "Release boundary rehearsed", "The complete M0–M6 story passed the fixture's schema and replay checks.", "A live integration must still promote local Factfiles before any stakeholder snapshot is dispatchable."],
  ] as const;
  const checkpoints = milestoneData.map(([id, title, change, why], index) => checkpoint({
    id: `processyard-${id.toLowerCase()}`,
    projectId: "processyard",
    outcomeId: "processyard-modernization",
    runId: development.runId,
    leaseId: index <= 4 ? development.id : index === 5 ? evidence.id : ci.id,
    title: `${id} · ${title}`,
    change,
    why,
    at: T(10 + index * 5),
    source: sources[index]!,
    trigger: index === 4 ? "owner_decision" : "verified_checkpoint",
    limitations: index === 6
      ? ["No production deployment is established by this local fixture.", "Gmail delivery authority and sent-message verification are not configured."]
      : ["Later Processyard milestones remain outside this checkpoint."],
    nextTask: index === 6 ? "Request explicit channel authority before preparing any founder email delivery." : `Verify ${milestoneData[index + 1]?.[0] ?? "the next"} without changing the established source boundary.`,
    humanDecisionRequest: index === 4 ? {
      id: "processyard-launch-boundary",
      title: "Choose the public launch boundary",
      whyHuman: "This changes the promise made to customers and belongs to the owner.",
      requestedAction: "Choose whether the launch stays local-first or includes the hosted Engine path.",
      options: ["Local-first Keyoku", "Keyoku plus hosted Engine"],
    } : undefined,
    assets: index === 5 ? [{
      kind: "video",
      path: "evidence/economy-theatre-demo.mp4",
      posterPath: "evidence/economy-theatre-poster.png",
      label: "Economy Theatre product demonstration",
      caption: "Expected Processyard poster and replay binding; no matching media bytes were found in the checked workspace, so a live integration must resolve and digest them before dispatch.",
    }] : [],
  }));
  const events: PulseEvent[] = [
    started("processyard-development-started", T(0), development),
    started("processyard-evidence-started", T(1), evidence),
    started("processyard-ci-started", T(2), ci),
    ...checkpoints.map((value) => published(`${value.id}-published`, value)),
    sealPulseEvent({ schemaVersion: "keyoku.dev/pulse-event/v1alpha1", id: "processyard-development-blocked", type: "blocked", at: T(41, 10), leaseId: development.id, source: sources[6]!, reason: "The long-running development lease is waiting for the explicit launch-boundary decision.", humanDecisionRequest: checkpoints[4]!.humanDecisionRequest }),
    sealPulseEvent({ schemaVersion: "keyoku.dev/pulse-event/v1alpha1", id: "processyard-evidence-completed", type: "completed", at: T(41, 20), leaseId: evidence.id, source: sources[5]!, checkpointId: checkpoints[5]!.id }),
    sealPulseEvent({ schemaVersion: "keyoku.dev/pulse-event/v1alpha1", id: "processyard-ci-completed", type: "completed", at: T(41, 30), leaseId: ci.id, source: sources[6]!, checkpointId: checkpoints[6]!.id }),
  ];
  const deliveredContentDigests = checkpoints.slice(0, 5).map((value) => pulseDigest({ projectId: value.projectId, checkpointDigests: [value.contentDigest] }));
  return {
    name: "processyard",
    description: "Processyard M0–M6 integration fixture with a long-running lease, multiple harnesses, coalescing, visual evidence paths, and a reproducible stale_no_send state.",
    events,
    recommendedPlan: { now: T(59), staleAfterMs: 5 * 60_000, debounceMs: 0, deliveredContentDigests },
    coalescingPlan: { now: T(42), staleAfterMs: 60 * 60_000, debounceMs: 0, deliveredContentDigests },
  };
}

export function buildPulseFixture(name: "generic" | "processyard"): PulseFixture {
  return name === "processyard" ? buildProcessyardPulseFixture() : buildGenericPulseFixture();
}
