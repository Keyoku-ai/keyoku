import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { DeckConfigSchema, deckCmd, renderDeck, FactfileSchema } from "../src/deck.js";

function fixture(): string {
  return mkdtempSync(join(tmpdir(), "keyoku-deck-"));
}

const DECK_YAML = `schemaVersion: keyoku.dev/deck/v1alpha1
title: Demo Deck
project: Demo
theme:
  mode: auto
sources:
  factfile: factfile.json
  demoVideo: video.webm
  framesDir: frames
  frameCrop: { leftPct: 10 }
links:
  - { label: pull request, url: "https://example.com/pr/1" }
sections:
  - type: intro
    headline: It works
    body: A short body.
    video: true
  - type: slides
    frames:
      - { frame: a.jpeg, title: Frame A, caption: First frame. }
      - { frame: b.jpeg, title: Frame B, caption: Second frame. }
  - type: status
    fromFactfile: true
  - type: architecture
    diagram:
      nodes:
        - { id: browser, icon: browser, label: Browser, sub: entrypoint }
        - { id: api, icon: api, label: API, sub: backend }
        - { id: db, icon: db, label: DB, sub: storage }
      edges:
        - { from: browser, to: api, label: HTTP }
        - { from: api, to: db }
    explain:
      stakeholder: Plain language explanation.
      developer: Technical explanation.
  - type: summary
    bullets:
      - Shipped thing one
      - Shipped thing two
    proof: "Verified: 2/2 checks."
personas:
  stakeholder:
    sections: [intro, status, architecture, summary]
    depth: short
    explainConcepts: true
  developer:
    sections: [intro, status, slides, architecture, summary]
    depth: full
    explainConcepts: false
`;

function factfileJson(): unknown {
  return {
    state: "human_review_required",
    summary: { passed: 2, failed: 0, total: 2, verified: true },
    humanReview: { passed: 0, failed: 0, pending: 1, total: 1 },
    outcome: {
      humanCriteria: [{ id: "review-diff", description: "Review the diff", guidance: "Look closely" }],
    },
    evidence: [
      {
        id: "c1",
        description: "Build succeeds",
        pass: true,
        durationMs: 1200,
        verification: { reproduce: "npm run build" },
      },
      {
        id: "c2",
        description: "Tests pass",
        pass: true,
        durationMs: 3400,
        verification: { reproduce: "npm test" },
      },
    ],
    reviews: [],
    session: {
      work: [{ id: "w1", title: "Shipped it", status: "done" }],
      directions: [{ id: "d1", label: "Ship it", summary: "Send the PR." }],
    },
  };
}

function seedProject(root: string): void {
  writeFileSync(join(root, ".keyoku", "deck.yaml"), DECK_YAML, "utf8");
  writeFileSync(join(root, "factfile.json"), JSON.stringify(factfileJson()), "utf8");
  writeFileSync(join(root, "video.webm"), Buffer.from("fake-video-bytes"));
  mkdirSync(join(root, "frames"), { recursive: true });
  writeFileSync(join(root, "frames", "a.jpeg"), Buffer.from("fake-jpeg-a"));
  writeFileSync(join(root, "frames", "b.jpeg"), Buffer.from("fake-jpeg-b"));
}

describe("deck config + factfile schemas", () => {
  it("accepts the documented shape", () => {
    const parsed = DeckConfigSchema.parse(parseYaml(DECK_YAML));
    expect(parsed.personas.stakeholder.depth).toBe("short");
    expect(parsed.sections).toHaveLength(5);
  });

  it("parses a real-shaped factfile", () => {
    expect(FactfileSchema.parse(factfileJson()).summary.total).toBe(2);
  });
});

describe("keyoku deck init", () => {
  it("writes a template and refuses to overwrite it", async () => {
    const root = fixture();
    const cwd = process.cwd();
    process.chdir(root);
    try {
      await deckCmd(["init"]);
      const path = join(root, ".keyoku", "deck.yaml");
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).toContain("schemaVersion: keyoku.dev/deck/v1alpha1");
      await expect(deckCmd(["init"])).rejects.toThrow(/already exists/);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe("keyoku deck build", () => {
  it("exits 2 with a clear message when no deck.yaml exists", async () => {
    const root = fixture();
    mkdirSync(join(root, ".keyoku"), { recursive: true });
    const cwd = process.cwd();
    process.chdir(root);
    try {
      await expect(deckCmd(["build"])).rejects.toThrow(/No .*deck\.yaml found/);
    } finally {
      process.chdir(cwd);
    }
  });

  it("renders a self-contained, tabbed, theme-aware deck per persona", async () => {
    const root = fixture();
    mkdirSync(join(root, ".keyoku"), { recursive: true });
    seedProject(root);
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const outStakeholder = join(root, "out-stakeholder.html");
      const outDeveloper = join(root, "out-developer.html");
      await deckCmd(["build", "--for", "stakeholder", "--out", "out-stakeholder.html"]);
      await deckCmd(["build", "--for", "developer", "--out", "out-developer.html"]);

      const stakeholder = readFileSync(outStakeholder, "utf8");
      const developer = readFileSync(outDeveloper, "utf8");

      // charset first
      expect(stakeholder.startsWith('<meta charset="utf-8">')).toBe(true);
      expect(developer.startsWith('<meta charset="utf-8">')).toBe(true);

      // tab bar present, in persona order
      expect(stakeholder.indexOf(">Intro<")).toBeLessThan(stakeholder.indexOf(">Status<"));
      expect(stakeholder.indexOf(">Status<")).toBeLessThan(stakeholder.indexOf(">Architecture<"));
      expect(stakeholder.indexOf(">Architecture<")).toBeLessThan(stakeholder.indexOf(">Summary<"));
      expect(stakeholder).not.toContain(">Demo<"); // stakeholder persona excludes 'slides'
      expect(developer).toContain(">Demo<");

      // video embedded
      expect(stakeholder).toContain("data:video/webm;base64,");

      // N frame slides only for personas that include 'slides'
      expect((developer.match(/data-section="slides"/g) ?? []).length).toBe(2);
      expect(stakeholder).not.toContain('data-section="slides"');

      // status: counts shown in both; reproduce commands only at depth=full
      expect(stakeholder).toContain("2/2 automated checks passed");
      expect(developer).toContain("2/2 automated checks passed");
      expect(stakeholder).not.toContain("npm run build");
      expect(developer).toContain("npm run build");
      expect(developer).toContain("npm test");

      // architecture: node + labeled edge + arrowhead marker (rendered via arch.ts, embedded mode)
      expect((developer.match(/class="arch-node"/g) ?? []).length).toBe(3);
      expect(developer).toContain('marker-end="url(#arch-arrow-head)"');
      expect(developer).toContain(">HTTP<");
      expect(developer).toContain("Technical explanation.");
      expect(stakeholder).toContain("Plain language explanation.");

      // theme toggle
      expect(stakeholder).toContain("keyoku-deck-theme");
      expect(stakeholder).toContain('id="themeBtn"');
    } finally {
      process.chdir(cwd);
    }
  });

  it("rejects an unknown persona with available personas listed", async () => {
    const root = fixture();
    mkdirSync(join(root, ".keyoku"), { recursive: true });
    seedProject(root);
    const cwd = process.cwd();
    process.chdir(root);
    try {
      await expect(deckCmd(["build", "--for", "nope"])).rejects.toThrow(/Unknown persona 'nope'.*stakeholder.*developer/s);
    } finally {
      process.chdir(cwd);
    }
  });
});

describe("keyoku deck plan", () => {
  it("requires a natural-language prompt", async () => {
    await expect(deckCmd(["plan"])).rejects.toThrow(/Usage: keyoku deck plan/);
  });
});

describe("renderDeck", () => {
  it("lays out architecture nodes into distinct columns by edge topology", () => {
    const root = fixture();
    mkdirSync(join(root, ".keyoku"), { recursive: true });
    seedProject(root);
    const config = DeckConfigSchema.parse(parseYaml(DECK_YAML));
    const factfile = FactfileSchema.parse(factfileJson());
    const html = renderDeck(config, "developer", config.personas.developer, factfile, root);
    // 3 nodes across a 3-hop chain browser->api->db should produce 3 distinct x positions
    const xs = [...html.matchAll(/class="arch-node-box" x="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(new Set(xs).size).toBe(3);
  });
});
