import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { stringify } from "yaml";

import { buildGenericPulseFixture, buildProcessyardPulseFixture } from "../src/pulse-fixtures.js";
import { initProject, runGate, startContribution } from "../src/contribution.js";
import {
  PulseEventSchema,
  VerifiedCheckpointSchema,
  appendPulseEvent,
  planPulseDelivery,
  planPulseDispatch,
  pulseDigest,
  readPulseEvents,
  renderPulseProjection,
  replayPulseEvents,
  sealPulseEvent,
  sealPulseSource,
  sealVerifiedCheckpoint,
  verifyAndSealLocalCheckpoint,
  writePulseProjection,
  type AgentActivityLease,
  type PulseEvent,
} from "../src/pulse.js";

describe("Keyoku Pulse", () => {
  it("strictly validates exact source, checkpoint, and event digests", () => {
    const fixture = buildGenericPulseFixture();
    const checkpointEvent = fixture.events.find((event) => event.type === "checkpoint_published")!;
    expect(PulseEventSchema.parse(checkpointEvent)).toEqual(checkpointEvent);
    if (checkpointEvent.type !== "checkpoint_published") throw new Error("fixture checkpoint missing");
    expect(() => VerifiedCheckpointSchema.parse({ ...checkpointEvent.checkpoint, contentDigest: "0".repeat(64) })).toThrow(/does not match checkpoint content/);
    expect(() => PulseEventSchema.parse({ ...checkpointEvent, eventDigest: "0".repeat(64) })).toThrow(/does not match event content/);
    expect(() => PulseEventSchema.parse({ ...checkpointEvent, unexpected: true })).toThrow(/unrecognized/i);
  });

  it("appends JSONL idempotently and rejects conflicting replay ids", () => {
    const root = mkdtempSync(join(tmpdir(), "keyoku-pulse-ledger-"));
    const event = buildGenericPulseFixture().events[0]!;
    expect(appendPulseEvent(root, event).status).toBe("appended");
    expect(appendPulseEvent(root, event).status).toBe("deduplicated");
    expect(readPulseEvents(root)).toEqual([event]);
    const conflict = sealPulseEvent({ ...event, at: "2026-08-24T16:00:01.000Z" });
    expect(() => appendPulseEvent(root, conflict)).toThrow(/different content/);
    expect(readFileSync(join(root, ".keyoku", "pulse", "events.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("replays lifecycle state without treating activity as proof", () => {
    const fixture = buildGenericPulseFixture();
    const state = replayPulseEvents(fixture.events.slice(0, 2));
    expect(state.leases[0]).toMatchObject({ state: "verifying" });
    expect(state.checkpoints).toEqual([]);
    const decision = planPulseDispatch({ events: fixture.events.slice(0, 2), now: "2026-08-24T16:02:10.000Z", debounceMs: 0 });
    expect(decision).toMatchObject({ outcome: "defer", reasonCode: "fresh_uncheckpointed_work" });
    expect(decision.snapshot).toBeUndefined();
  });

  it("replays valid event-set permutations identically and fails closed on genuinely ambiguous order", () => {
    const fixture = buildGenericPulseFixture();
    const forward = replayPulseEvents(fixture.events);
    expect(replayPulseEvents([...fixture.events].reverse())).toEqual(forward);
    expect(replayPulseEvents([...fixture.events, fixture.events[0]!])).toEqual(forward);
    expect(planPulseDispatch({ events: [...fixture.events].reverse(), ...fixture.recommendedPlan })).toEqual(planPulseDispatch({ events: fixture.events, ...fixture.recommendedPlan }));

    const verifying = fixture.events.find((event) => event.type === "verification_started");
    if (!verifying || verifying.type !== "verification_started") throw new Error("verification fixture missing");
    const heartbeat = sealPulseEvent({
      schemaVersion: "keyoku.dev/pulse-event/v1alpha1",
      id: "generic-same-time-heartbeat",
      type: "heartbeat",
      at: verifying.at,
      leaseId: verifying.leaseId,
      state: "working",
      source: verifying.source,
    });
    expect(() => replayPulseEvents([...fixture.events, heartbeat])).toThrow(/ambiguous ordering/);
  });

  it("sends one material checkpoint and deduplicates by the content-bound snapshot", () => {
    const fixture = buildGenericPulseFixture();
    const first = planPulseDispatch({ events: fixture.events, ...fixture.recommendedPlan });
    expect(first).toMatchObject({ outcome: "send", reasonCode: "material_checkpoint", failClosed: false });
    expect(first.snapshot?.checkpointIds).toEqual(["cart-recovery-verified"]);
    const duplicate = planPulseDispatch({
      events: fixture.events,
      ...fixture.recommendedPlan,
      deliveredContentDigests: [first.snapshot!.contentDigest],
    });
    expect(duplicate).toMatchObject({ outcome: "deduplicate", reasonCode: "already_delivered" });
  });

  it("defers during the coalescing window", () => {
    const fixture = buildGenericPulseFixture();
    const decision = planPulseDispatch({
      events: fixture.events.slice(0, 3),
      now: "2026-08-24T16:03:01.000Z",
      staleAfterMs: 300_000,
      debounceMs: 30_000,
    });
    expect(decision).toMatchObject({ outcome: "defer", reasonCode: "fresh_agents_working", checkpointIds: ["cart-recovery-verified"] });
  });

  it("fails closed instead of projecting future-dated activity", () => {
    const fixture = buildGenericPulseFixture();
    const decision = planPulseDispatch({
      events: fixture.events,
      now: "2026-08-24T16:02:30.000Z",
      staleAfterMs: 300_000,
      debounceMs: 0,
    });
    expect(decision).toMatchObject({ outcome: "suppress", reasonCode: "future_event", failClosed: true, checkpointIds: [] });
    expect(decision.snapshot).toBeUndefined();
  });

  it("recomputes local Factfile bytes and source identity before checkpoint promotion", async () => {
    const root = mkdtempSync(join(tmpdir(), "keyoku-pulse-local-factfile-"));
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.email", "owner@example.com"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Owner"], { cwd: root });
    writeFileSync(join(root, "README.md"), "# Local proof\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
    initProject({ root, name: "Local proof" });
    const timestamp = "2026-08-24T16:00:00.000Z";
    writeFileSync(join(root, ".keyoku", "outcomes", "local-proof.yaml"), stringify({
      schemaVersion: "keyoku.dev/outcome/v1alpha1",
      id: "local-proof",
      revision: 1,
      title: "Local proof is verified",
      objective: "Produce a complete source-bound Factfile.",
      owner: { kind: "human", id: "owner@example.com", name: "Owner" },
      constraints: [],
      criteria: [{
        description: "The command passes",
        probe: { kind: "command", run: "node -e \"console.log('ok')\"", parse: "text" },
        assert: { path: "exitCode", op: "eq", value: 0 },
      }],
      createdAt: timestamp,
      updatedAt: timestamp,
    }), "utf8");
    const contribution = startContribution({ root, outcomeId: "local-proof" });
    const factfile = await runGate(root, contribution.id);
    const factfilePath = `.keyoku/contributions/${contribution.id}/factfile.json`;
    const source = sealPulseSource({
      canonicalRoot: root,
      headSha: factfile.repository.headSha,
      worktreeDigest: factfile.repository.worktreeDigest,
      ancestryShas: [],
    });
    const checkpoint = verifyAndSealLocalCheckpoint(root, {
      schemaVersion: "keyoku.dev/pulse-checkpoint/v1alpha1",
      id: "local-checkpoint",
      projectId: "local-project",
      runId: "local-run",
      leaseIds: ["local-lease"],
      title: "Local proof verified",
      changeSummary: "Local Factfile bytes were checked.",
      whyItMatters: "A digest-shaped reference cannot promote itself.",
      publishedAt: "2026-08-24T16:01:00.000Z",
      source,
      verification: { status: "verified", verifiedAt: "2026-08-24T16:01:00.000Z", methods: [{ kind: "command", label: "test", reproduce: "npm test", result: "passed" }] },
      factfiles: [{ path: factfilePath }],
      assets: [],
      limitations: ["No deployment claim."],
      materialTrigger: "verified_checkpoint",
    });
    expect(checkpoint.evidenceBinding).toMatchObject({ mode: "local_factfiles", verifiedRoot: root });
    expect(checkpoint.factfiles[0]?.bytesDigest).toMatch(/^[a-f0-9]{64}$/);
    writeFileSync(join(root, factfilePath), `${JSON.stringify({ ...factfile, project: { ...factfile.project, summary: "tampered" } })}\n`, "utf8");
    expect(() => verifyAndSealLocalCheckpoint(root, {
      ...checkpoint,
      factfiles: [{ path: factfilePath }],
    })).toThrow(/digest mismatch/);
  });

  it("coalesces Processyard M0–M6 across compatible harnesses", () => {
    const fixture = buildProcessyardPulseFixture();
    const state = replayPulseEvents(fixture.events);
    expect(state.checkpoints.map((checkpoint) => checkpoint.title.split(" · ")[0])).toEqual(["M0", "M1", "M2", "M3", "M4", "M5", "M6"]);
    expect(new Set(state.leases.map((lease) => lease.lease.harness))).toEqual(new Set(["codex", "claude-code", "github-actions"]));
    const decision = planPulseDispatch({ events: fixture.events, ...fixture.coalescingPlan! });
    expect(decision).toMatchObject({ outcome: "coalesce", reasonCode: "compatible_checkpoints", checkpointIds: ["processyard-m5", "processyard-m6"] });
    expect(decision.snapshot?.checkpoints[0]?.assets[0]).toMatchObject({ kind: "video", posterPath: "evidence/economy-theatre-poster.png" });
    const timeline = renderPulseProjection(decision.snapshot!, "timeline");
    expect(timeline).toContain("Evidence asset unresolved");
    expect(timeline).not.toContain("<img");
  });

  it("freezes the latest trusted checkpoint and sends no normal update when leases go stale", () => {
    const fixture = buildProcessyardPulseFixture();
    const decision = planPulseDispatch({
      events: fixture.events,
      ...fixture.recommendedPlan,
    });
    expect(decision).toMatchObject({ outcome: "stale_no_send", reasonCode: "stale_activity_lease", failClosed: true });
    expect(decision.snapshot).toBeUndefined();
    expect(decision.frozenSnapshot?.checkpointIds).toEqual(["processyard-m6"]);
  });

  it("fails closed when agent checkpoints have conflicting source roots", () => {
    const sourceA = sealPulseSource({ canonicalRoot: "repo://example/a", headSha: "a".repeat(40), worktreeDigest: "a".repeat(64), ancestryShas: [] });
    const sourceB = sealPulseSource({ canonicalRoot: "repo://example/b", headSha: "b".repeat(40), worktreeDigest: "b".repeat(64), ancestryShas: [] });
    const makeLease = (id: string, source: ReturnType<typeof sealPulseSource>): AgentActivityLease => ({
      schemaVersion: "keyoku.dev/pulse-lease/v1alpha1",
      id,
      harness: "generic-jsonl",
      project: { id: "conflict-project", name: "Conflict Project" },
      runId: "conflict-run",
      agent: { id: `${id}-agent`, name: id },
      canonicalSourceRoot: source.canonicalRoot,
      task: { id: `${id}-task`, title: "Publish proof", outcome: "Produce an exact checkpoint." },
      startedAt: "2026-08-24T16:00:00.000Z",
      heartbeatAt: "2026-08-24T16:00:00.000Z",
      state: "working",
      currentSource: source,
    });
    const makeCheckpoint = (id: string, leaseId: string, source: ReturnType<typeof sealPulseSource>, minute: string) => sealVerifiedCheckpoint({
      schemaVersion: "keyoku.dev/pulse-checkpoint/v1alpha1",
      id,
      projectId: "conflict-project",
      runId: "conflict-run",
      leaseIds: [leaseId],
      title: id,
      changeSummary: "A bounded change was verified.",
      whyItMatters: "It is a material checkpoint.",
      publishedAt: `2026-08-24T16:${minute}:00.000Z`,
      source,
      verification: { status: "verified", verifiedAt: `2026-08-24T16:${minute}:00.000Z`, methods: [{ kind: "command", label: "check", reproduce: "npm test", result: "passed" }] },
      evidenceBinding: { mode: "fixture", label: "source-conflict adversarial fixture" },
      factfiles: [{ id: `${id}-factfile`, path: `${id}.json`, digest: pulseDigest(id), sourceDigest: source.verifiedDigest, state: "ready_for_review" }],
      assets: [],
      limitations: ["No deployment claim."],
      materialTrigger: "verified_checkpoint",
    });
    const leaseA = makeLease("lease-a", sourceA);
    const leaseB = makeLease("lease-b", sourceB);
    const checkpointA = makeCheckpoint("checkpoint-a", leaseA.id, sourceA, "01");
    const checkpointB = makeCheckpoint("checkpoint-b", leaseB.id, sourceB, "02");
    const events: PulseEvent[] = [
      sealPulseEvent({ schemaVersion: "keyoku.dev/pulse-event/v1alpha1", id: "start-a", type: "started", at: leaseA.startedAt, leaseId: leaseA.id, lease: leaseA }),
      sealPulseEvent({ schemaVersion: "keyoku.dev/pulse-event/v1alpha1", id: "start-b", type: "started", at: leaseB.startedAt, leaseId: leaseB.id, lease: leaseB }),
      sealPulseEvent({ schemaVersion: "keyoku.dev/pulse-event/v1alpha1", id: "publish-a", type: "checkpoint_published", at: checkpointA.publishedAt, leaseId: leaseA.id, checkpoint: checkpointA }),
      sealPulseEvent({ schemaVersion: "keyoku.dev/pulse-event/v1alpha1", id: "publish-b", type: "checkpoint_published", at: checkpointB.publishedAt, leaseId: leaseB.id, checkpoint: checkpointB }),
      sealPulseEvent({ schemaVersion: "keyoku.dev/pulse-event/v1alpha1", id: "block-a", type: "blocked", at: "2026-08-24T16:02:10.000Z", leaseId: leaseA.id, source: sourceA, reason: "Awaiting source reconciliation." }),
      sealPulseEvent({ schemaVersion: "keyoku.dev/pulse-event/v1alpha1", id: "block-b", type: "blocked", at: "2026-08-24T16:02:20.000Z", leaseId: leaseB.id, source: sourceB, reason: "Awaiting source reconciliation." }),
    ];
    const decision = planPulseDispatch({ events, now: "2026-08-24T16:03:00.000Z", staleAfterMs: 300_000, debounceMs: 0 });
    expect(decision).toMatchObject({ outcome: "suppress", reasonCode: "source_conflict", failClosed: true });
    expect(decision.snapshot).toBeUndefined();
  });

  it("renders every audience from one snapshot and only plans permissioned delivery", () => {
    const fixture = buildGenericPulseFixture();
    const dispatch = planPulseDispatch({ events: fixture.events, ...fixture.recommendedPlan });
    const snapshot = dispatch.snapshot!;
    expect(renderPulseProjection(snapshot, "stakeholder")).toContain("What changed");
    expect(renderPulseProjection(snapshot, "developer")).toContain("Verification");
    expect(renderPulseProjection(snapshot, "timeline")).toContain("What changed");
    expect(renderPulseProjection(snapshot, "email")).toContain("What changed");
    expect(renderPulseProjection(snapshot, "text")).toContain("WHAT CHANGED");
    expect(renderPulseProjection(snapshot, "json")).toContain(snapshot.contentDigest);
    expect(renderPulseProjection(snapshot, "timeline")).toContain("Open Factfile evidence");
    expect(renderPulseProjection(snapshot, "developer")).toContain(snapshot.source.verifiedDigest);
    expect(planPulseDelivery({ dispatch, adapter: { kind: "email", recipient: "owner@example.com" } })).toMatchObject({ status: "no_send", reason: expect.stringContaining("Fixture-bound") });
    const checkpointEvent = fixture.events.find((event) => event.type === "checkpoint_published");
    if (!checkpointEvent || checkpointEvent.type !== "checkpoint_published") throw new Error("checkpoint fixture missing");
    const { contentDigest: _fixtureDigest, ...checkpointContent } = checkpointEvent.checkpoint;
    const attestedCheckpoint = sealVerifiedCheckpoint({ ...checkpointContent, evidenceBinding: { mode: "adapter_attested", adapter: "test-adapter", responsibility: "The adapter verified remote Factfile bytes and exact source identity." } });
    const attestedEvents = fixture.events.map((event) => event.id === checkpointEvent.id
      ? sealPulseEvent({ ...event, checkpoint: attestedCheckpoint })
      : event);
    const attestedDispatch = planPulseDispatch({ events: attestedEvents, ...fixture.recommendedPlan });
    expect(planPulseDelivery({ dispatch: attestedDispatch, adapter: { kind: "email", recipient: "owner@example.com" } }).status).toBe("not_authorized");
    const planned = planPulseDelivery({
      dispatch: attestedDispatch,
      adapter: { kind: "email", recipient: "owner@example.com" },
      authority: { channel: "email", subject: "founder checkpoint", grantedBy: "owner@example.com", grantedAt: "2026-08-24T16:04:00.000Z", projectIds: [snapshot.projectId] },
      now: "2026-08-24T16:05:00.000Z",
    });
    expect(planned).toMatchObject({ status: "ready", snapshotDigest: attestedDispatch.snapshot?.contentDigest });
    expect(planned.reason).toContain("caller must perform");
    const root = mkdtempSync(join(tmpdir(), "keyoku-pulse-render-"));
    const path = writePulseProjection(join(root, "timeline.html"), snapshot, "timeline");
    expect(readFileSync(path, "utf8")).toContain(snapshot.contentDigest);
  });
});
