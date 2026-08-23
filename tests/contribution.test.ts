import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { stringify } from "yaml";
import { afterEach, describe, expect, it } from "vitest";

import {
  captureRepository,
  initProject,
  loadProject,
  publishFactfile,
  reviewContribution,
  runGate,
  startContribution,
} from "../src/contribution.js";

const roots: string[] = [];

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "keyoku-contribution-"));
  roots.push(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "owner@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Project Owner"], { cwd: root });
  writeFileSync(join(root, "README.md"), "# Example\n", "utf8");
  execFileSync("git", ["add", "README.md"], { cwd: root });
  execFileSync("git", ["commit", "-qm", "initial"], { cwd: root });
  return root;
}

afterEach(() => {
  // Temporary roots are intentionally left to the OS temp cleaner. Avoiding a
  // recursive delete also makes failed test fixtures available for debugging.
  roots.length = 0;
});

describe("repository-local contribution gates", () => {
  it("initializes without overwriting an existing project", () => {
    const root = repo();
    const project = initProject({ root, name: "Example Project", summary: "A proof-first example." });
    expect(project.id).toBe("example-project");
    expect(loadProject(root).summary).toBe("A proof-first example.");
    expect(() => initProject({ root })).toThrow(/will not overwrite/);
  });

  it("binds a passing Factfile to the exact repository snapshot", async () => {
    const root = repo();
    initProject({ root, name: "Example" });
    writeFileSync(join(root, "evidence.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"));
    writeFileSync(join(root, "journey.webm"), Buffer.from("portable-test-video"));
    const timestamp = new Date().toISOString();
    writeFileSync(
      join(root, ".keyoku", "outcomes", "working-build.yaml"),
      stringify({
        schemaVersion: "keyoku.dev/outcome/v1alpha1",
        id: "working-build",
        revision: 1,
        title: "The build works",
        objective: "The repository exposes a machine-verifiable build result.",
        owner: { kind: "human", id: "owner@example.com", name: "Project Owner" },
        constraints: ["Fail closed when the command cannot run."],
        criteria: [
          {
            description: "The probe returns the expected result",
            probe: { kind: "command", run: "node -e \"console.log(JSON.stringify({ok:true}))\"", parse: "json" },
            assert: { path: "output.ok", op: "eq", value: true },
            evidence: {
              summary: "The generated receipt renders the verified outcome for a maintainer.",
              whyItMatters: "A maintainer needs to see the result, not decode the assertion implementation.",
              code: [{ path: "src/contribution.ts", purpose: "Builds portable receipts and binds them to the source snapshot." }],
              artifacts: [
                { kind: "screenshot", path: "evidence.png", label: "Rendered outcome", caption: "A captured view of the behavior under review.", annotations: [{ label: "Visible result", detail: "The reviewer can see the outcome.", x: 50, y: 40 }] },
                { kind: "video", path: "journey.webm", label: "Outcome journey", caption: "A short recording of the behavior under review.", annotations: [{ label: "Interaction completes", atMs: 1200 }] },
              ],
            },
          },
        ],
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      "utf8",
    );
    const contribution = startContribution({
      root,
      outcomeId: "working-build",
      summary: "Created a portable receipt that ties the requested build outcome to this exact source snapshot.",
      knownLimits: ["This receipt does not establish product usability."],
    });
    const snapshot = await runGate(root, contribution.id);

    expect(snapshot.state).toBe("ready_for_review");
    expect(snapshot.summary).toMatchObject({ passed: 1, failed: 0, verified: true });
    expect(snapshot.contribution.actors[0]).toMatchObject({ name: "Project Owner", kind: "human" });
    expect(snapshot.repository.changedFiles).toContain(".keyoku/outcomes/working-build.yaml");
    expect(snapshot.repository.branch).toBeTruthy();
    expect(snapshot.repository.ahead).toBe(0);
    expect(snapshot.repository.changedFiles.every((path) => !path.startsWith(".keyoku/contributions/"))).toBe(true);

    const dir = join(root, ".keyoku", "contributions", contribution.id);
    expect(existsSync(join(dir, "factfile.html"))).toBe(true);
    expect(existsSync(join(dir, "snapshots", `${snapshot.id}.html`))).toBe(true);
    const html = readFileSync(join(dir, "factfile.html"), "utf8");
    expect(html).toContain("Insight");
    expect(html).toContain("Pending decisions");
    expect(html).toContain("Proposed directions");
    expect(html).toContain("Full evidence &amp; reproduction");
    expect(html).toContain("Work log");
    expect(html).toContain("Session &amp; proof history");
    expect(html).toContain("Repository, scope &amp; provenance");
    expect(html).toContain("Responsibility");
    expect(html).toContain("How the outcome changes");
    expect(html).toContain("class=\"hero hero-film\"");
    expect(html).toContain("film-caption");
    expect(html).toContain("Toggle light and dark appearance");
    expect(html).toContain("@media(prefers-color-scheme:dark)");
    expect(html).toContain("<html lang=\"en\"><head>");
    expect(html).toContain("class=\"local-time\"");
    expect(html).toContain("Intl.RelativeTimeFormat");
    expect(html).toContain("Copy direction");
    expect(html).not.toContain("Steer the agent directly");
    expect(html).toContain("Created a portable receipt");
    expect(html).toContain("This receipt does not establish product usability.");
    expect(html).toContain("What this establishes");
    expect(html).toContain("Relevant implementation");
    expect(html).toContain("Reproduce this observation");
    expect(html).toContain("data:image/png;base64,");
    expect(html).toContain("data:video/webm;base64,");
    expect(html).toContain("<video controls");
    expect(html).toContain("annotation-pin");
    expect(html).toContain("Visible result");
    expect(html).toContain("0:01");
    expect(html).toContain("Open verifier internals · observation, rule, runtime");
    expect(html).toContain("--good:#1a7f37");
    expect(html).toContain("class=\"ff-word\">keyoku</span>");
    expect(html).not.toContain("gradient");
    expect(html).not.toContain("#8b5cf6");
    expect(html).not.toMatch(/<style>\s*<\/style>/);
    expect(readFileSync(join(dir, "factfile.md"), "utf8")).toContain("Gate: READY FOR REVIEW");

    const after = captureRepository(root, contribution.baseSha);
    expect(after.worktreeDigest).toBe(snapshot.repository.worktreeDigest);

    let received = "";
    let authorization = "";
    const server = createServer((request, response) => {
      authorization = request.headers.authorization ?? "";
      request.on("data", (chunk) => { received += chunk; });
      request.on("end", () => {
        response.writeHead(201, { "content-type": "application/json" });
        response.end('{"created":true}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as AddressInfo;
      const result = await publishFactfile(root, contribution.id, `http://127.0.0.1:${address.port}`, "test-token");
      expect(result).toEqual({ created: true });
      expect(authorization).toBe("Bearer test-token");
      expect(JSON.parse(received).digest).toBe(snapshot.digest);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }

    await expect(publishFactfile(root, contribution.id, "http://example.com")).rejects.toThrow(/HTTPS or loopback/);
    await expect(publishFactfile(root, contribution.id, "http://user:password@127.0.0.1:1")).rejects.toThrow(/must not embed credentials/);

    const reviewed = reviewContribution({
      root,
      contributionId: contribution.id,
      decision: "note",
      comment: "The evidence and scope are understandable.",
    });
    expect(reviewed.reviews).toHaveLength(1);
    const accepted = reviewContribution({
      root,
      contributionId: contribution.id,
      decision: "accepted",
      comment: "I accept this exact snapshot.",
    });
    expect(accepted.state).toBe("accepted");
    expect(accepted.contribution.status).toBe("accepted");
    expect(accepted.reviews.at(-1)).toMatchObject({ decision: "accepted", reviewer: { kind: "human" } });
    expect(readFileSync(join(dir, "factfile.html"), "utf8")).toContain("A named human accepted this exact source identity.");

    writeFileSync(join(root, "README.md"), "# Changed after proof\n", "utf8");
    expect(() => reviewContribution({
      root,
      contributionId: contribution.id,
      decision: "accepted",
      comment: "This stale proof must not be accepted.",
    })).toThrow(/repository changed/);
    await expect(publishFactfile(root, contribution.id, "http://127.0.0.1:1")).rejects.toThrow(/repository changed/);
  });

  it("reports evidence gaps and never treats a failed probe as proof", async () => {
    const root = repo();
    initProject({ root, name: "Example" });
    const timestamp = new Date().toISOString();
    writeFileSync(
      join(root, ".keyoku", "outcomes", "broken-build.yaml"),
      stringify({
        schemaVersion: "keyoku.dev/outcome/v1alpha1",
        id: "broken-build",
        revision: 1,
        title: "A failing build stays unproven",
        objective: "Failed probes cannot produce a green gate.",
        owner: { kind: "human", id: "owner@example.com", name: "Project Owner" },
        constraints: [],
        criteria: [
          {
            description: "Command must succeed",
            probe: { kind: "command", run: "node -e \"process.exit(2)\"" },
            assert: { path: "output", op: "not_exists" },
          },
        ],
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      "utf8",
    );
    const contribution = startContribution({ root, outcomeId: "broken-build" });
    const snapshot = await runGate(root, contribution.id);
    expect(snapshot.state).toBe("evidence_gaps");
    expect(snapshot.summary.verified).toBe(false);
    expect(snapshot.evidence[0]?.pass).toBe(false);
  });

  it("keeps required human judgments separate from automated proof", async () => {
    const root = repo();
    initProject({ root, name: "Mixed Evidence" });
    const timestamp = new Date().toISOString();
    writeFileSync(
      join(root, ".keyoku", "outcomes", "mixed-gate.yaml"),
      stringify({
        schemaVersion: "keyoku.dev/outcome/v1alpha1",
        id: "mixed-gate",
        revision: 1,
        title: "Quality needs machines and people",
        objective: "Automated proof and human judgment remain independently visible.",
        owner: { kind: "human", id: "owner@example.com", name: "Project Owner" },
        constraints: [],
        criteria: [{
          description: "The build passes",
          probe: { kind: "command", run: "node -e \"process.exit(0)\"" },
          assert: { path: "exitCode", op: "eq", value: 0 },
        }],
        humanCriteria: [{
          id: "visual-quality",
          description: "The product owner judges the interface clear and polished",
          guidance: "Inspect the rendered interface at desktop and mobile sizes.",
        }],
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      "utf8",
    );
    const contribution = startContribution({
      root,
      outcomeId: "mixed-gate",
      actor: { kind: "agent", id: "codex:gpt-5.6-sol", name: "Codex", harness: "Codex", model: "gpt-5.6-sol", ownerId: "owner@example.com" },
    });
    expect(contribution.actors.map((actor) => actor.kind)).toEqual(["human", "agent"]);
    expect(contribution.actors[1]).toMatchObject({ harness: "Codex", model: "gpt-5.6-sol", ownerId: "owner@example.com" });
    let snapshot = await runGate(root, contribution.id);
    expect(snapshot.state).toBe("human_review_required");
    expect(snapshot.summary.verified).toBe(true);
    expect(snapshot.humanReview).toEqual({ passed: 0, failed: 0, pending: 1, total: 1 });
    expect(() => reviewContribution({ root, contributionId: contribution.id, decision: "accepted", comment: "Too early." })).toThrow(/ready-for-review/);
    expect(() => reviewContribution({
      root,
      contributionId: contribution.id,
      decision: "note",
      comment: "An agent cannot judge this.",
      criterionId: "visual-quality",
      verdict: "pass",
      reviewer: { kind: "agent", id: "agent", name: "Agent" },
    })).toThrow(/Only an identified human/);
    snapshot = reviewContribution({
      root,
      contributionId: contribution.id,
      decision: "note",
      comment: "The hierarchy and evidence are clear at both sizes.",
      criterionId: "visual-quality",
      verdict: "pass",
    });
    expect(snapshot.state).toBe("ready_for_review");
    expect(snapshot.humanReview).toEqual({ passed: 1, failed: 0, pending: 0, total: 1 });
    expect(snapshot.reviews[0]).toMatchObject({ criterionId: "visual-quality", verdict: "pass" });
  });

  it("redacts credential-shaped evidence before creating shareable files", async () => {
    const root = repo();
    initProject({ root, name: "Example" });
    const timestamp = new Date().toISOString();
    writeFileSync(
      join(root, ".keyoku", "outcomes", "secret-output.yaml"),
      stringify({
        schemaVersion: "keyoku.dev/outcome/v1alpha1",
        id: "secret-output",
        revision: 1,
        title: "Evidence is safe to share",
        objective: "Credential-shaped probe output is redacted from every Factfile view.",
        owner: { kind: "human", id: "owner@example.com", name: "Project Owner" },
        constraints: [],
        criteria: [
          {
            description: "Probe completes",
            probe: { kind: "command", run: "node -e \"console.log('api_key=sk-supersecret123')\"", parse: "text" },
            assert: { path: "output", op: "contains", value: "api_key" },
          },
        ],
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      "utf8",
    );
    const contribution = startContribution({ root, outcomeId: "secret-output" });
    const snapshot = await runGate(root, contribution.id);
    const dir = join(root, ".keyoku", "contributions", contribution.id);
    const published = [
      JSON.stringify(snapshot),
      readFileSync(join(dir, "factfile.json"), "utf8"),
      readFileSync(join(dir, "factfile.md"), "utf8"),
      readFileSync(join(dir, "factfile.html"), "utf8"),
    ].join("\n");
    expect(published).not.toContain("sk-supersecret123");
    expect(published).toContain("«redacted»");
  });
});
