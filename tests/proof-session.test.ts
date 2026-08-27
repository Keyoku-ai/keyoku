import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { describe, expect, it } from "vitest";

import { getActiveContribution, initProject, runGate, startContribution } from "../src/contribution.js";
import {
  acknowledgeInstruction,
  heartbeatAgent,
  nextInstruction,
  proposeDirection,
  readProofSession,
  readProofSessionEvents,
  reportWork,
  requestDecision,
  resolveDecision,
} from "../src/proof-session.js";
import { startProofSessionServer } from "../src/session-server.js";

function project(): string {
  const root = mkdtempSync(join(tmpdir(), "keyoku-live-proof-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "owner@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Owner"], { cwd: root });
  writeFileSync(join(root, "README.md"), "# Demo\n");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  initProject({ root, name: "Live Demo" });
  const timestamp = new Date().toISOString();
  writeFileSync(join(root, ".keyoku", "outcomes", "live-loop.yaml"), stringify({
    schemaVersion: "keyoku.dev/outcome/v1alpha1", id: "live-loop", revision: 1,
    title: "A live proof loop works", objective: "A human and agent can coordinate against one durable contribution.",
    owner: { kind: "human", id: "owner@example.com", name: "Owner" }, constraints: [],
    criteria: [{ description: "The demo command passes", probe: { kind: "command", run: "node -e \"process.exit(0)\"", parse: "text" }, assert: { path: "exitCode", op: "eq", value: 0 } }],
    humanCriteria: [], createdAt: timestamp, updatedAt: timestamp,
  }));
  return root;
}

describe("two-way proof sessions", () => {
  it("keeps work, blockers, decisions, and instructions durable and distinct", () => {
    const root = project();
    const contribution = startContribution({ root, outcomeId: "live-loop" });
    reportWork(root, contribution.id, { id: "render-ui", title: "Render the proof session", detail: "Building the human-facing view.", status: "working", actorId: "agent-1" });
    heartbeatAgent(root, contribution.id, { actorId: "agent-1", name: "Coding agent", harness: "test-harness", status: "working", currentWorkId: "render-ui" });
    proposeDirection(root, contribution.id, {
      id: "ship-alpha", eyebrow: "Ship", label: "Prepare the alpha release", summary: "Package the supported outcome for early adopters.",
      outcomeEffect: "Moves the supported snapshot into a release candidate without claiming human acceptance.",
      deepDive: "Verify release notes, package contents, and the GitHub action before tagging.", basis: "Machine evidence is supported and the release preflight passed.",
      tradeoffs: ["Starts the compatibility clock"], evidenceRefs: ["factfile:machine"], instruction: "Prepare the alpha release but do not publish without human acceptance.", proposedBy: "agent-1",
    });
    const decision = requestDecision(root, contribution.id, {
      id: "choose-scope", title: "Choose the V1 boundary", agentIntent: "Finish the public launch slice.",
      blocker: "Two valid scopes have different launch risk.", whyHuman: "This changes the public product promise.",
      options: [
        { id: "narrow", label: "Keep V1 narrow", description: "Ship the proof loop first.", instruction: "Keep V1 limited to the local proof loop.", outcomeEffect: "The launch remains focused.", deepDive: "Defer cloud dispatch.", tradeoffs: ["Less breadth", "Faster learning"] },
        { id: "expand", label: "Add cloud dispatch", description: "Broader surface and more delay.", instruction: "Include cloud dispatch in V1." },
      ],
      recommendedOptionId: "narrow", noResponse: "The agent will continue only on independent proof work.", requestedBy: "agent-1",
    });
    expect(readProofSession(root, contribution.id)).toMatchObject({
      work: [{ id: "render-ui", status: "working" }],
      decisions: [{ id: decision.id, status: "pending" }],
      agents: [{ actorId: "agent-1", connected: true }],
      directions: [{ id: "ship-alpha", proposedBy: "agent-1" }],
    });
    const beforeResolution = readProofSessionEvents(root, contribution.id).length;
    const resolved = resolveDecision(root, contribution.id, { decisionId: decision.id, selectedOptionId: "narrow", resolvedBy: "owner@example.com" });
    const resolutionEvents = readProofSessionEvents(root, contribution.id).slice(beforeResolution);
    expect(resolutionEvents.map((event) => event.type)).toEqual(["decision.resolved", "instruction.queued"]);
    expect(new Set(resolutionEvents.map((event) => event.at)).size).toBe(1);
    expect(resolved.instruction.text).toContain("local proof loop");
    expect(nextInstruction(root, contribution.id, "agent-1")?.id).toBe(resolved.instruction.id);
    expect(acknowledgeInstruction(root, contribution.id, resolved.instruction.id, "agent-1").status).toBe("acknowledged");
    expect(readProofSession(root, contribution.id).decisions[0]).toMatchObject({ status: "resolved", selectedOptionId: "narrow" });
  });

  it("reuses one active contribution per branch and outcome unless a new one is requested", () => {
    const root = project();
    const first = startContribution({ root, outcomeId: "live-loop", reuseActive: true });
    const reused = startContribution({ root, outcomeId: "live-loop", reuseActive: true });
    const fresh = startContribution({ root, outcomeId: "live-loop" });
    expect(reused.id).toBe(first.id);
    expect(fresh.id).not.toBe(first.id);
    expect(getActiveContribution(root, "live-loop")?.id).toBe(fresh.id);
  });

  it("rejects an outcome edit that did not increment the revision", async () => {
    const root = project();
    const contribution = startContribution({ root, outcomeId: "live-loop" });
    const path = join(root, ".keyoku", "outcomes", "live-loop.yaml");
    writeFileSync(path, readFileSync(path, "utf8").replace("A live proof loop works", "A silently changed proof loop"));
    expect(getActiveContribution(root, "live-loop")).toBeUndefined();
    await expect(runGate(root, contribution.id)).rejects.toThrow(/changed without a revision increment/);
  });

  it("serves a token-scoped live Factfile and turns a human choice into an agent instruction", async () => {
    const root = project();
    const contribution = startContribution({ root, outcomeId: "live-loop" });
    requestDecision(root, contribution.id, {
      id: "ship-shape", title: "Choose the launch shape", agentIntent: "Finish V1", blocker: "A product choice is unresolved", whyHuman: "The owner controls scope",
      options: [{ id: "proof", label: "Proof loop", description: "Stay focused", instruction: "Ship the focused proof loop." }], recommendedOptionId: "proof", noResponse: "Dependent work pauses", requestedBy: "agent-1",
    });
    await runGate(root, contribution.id);
    const server = await startProofSessionServer({ root, contributionId: contribution.id });
    try {
      expect((await fetch(`http://127.0.0.1:${server.port}/`)).status).toBe(401);
      const html = await (await fetch(server.url)).text();
      expect(html).toContain("Live proof session");
      expect(html).toContain("Required judgment");
      expect(html).toContain("Choose the launch shape");
      expect(html).toContain("Optional agent coordination");
      expect(html).toContain("Toggle light and dark appearance");
      expect(html).toContain("Queue direction");
      const response = await fetch(`http://127.0.0.1:${server.port}/api/decisions/ship-shape?token=${server.token}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ selectedOptionId: "proof", resolvedBy: "owner@example.com" }),
      });
      expect(response.status).toBe(200);
      expect(nextInstruction(root, contribution.id)?.text).toBe("Ship the focused proof loop.");
    } finally { await server.close(); }
  });
});
