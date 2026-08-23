import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

import { KEYOKU_DIR } from "./contribution.js";

// ---------------------------------------------------------------------------
// `keyoku deck` — a config-driven evidence-deck generator. An agent (or a
// human) writes/edits a per-project `.keyoku/deck.yaml`; `keyoku deck build`
// deterministically renders it into ONE self-contained HTML deck per persona
// — no agent calls at build time. Autonomy lives entirely at the planning
// layer (`keyoku deck plan`), which spawns an agent to draft/update the YAML;
// rendering itself is pure templating so the same config always produces the
// same deck.
// ---------------------------------------------------------------------------

// ---- config schema (keyoku.dev/deck/v1alpha1) ------------------------------

const ThemeSchema = z
  .object({ mode: z.enum(["auto", "light", "dark"]).default("auto") })
  .default({ mode: "auto" });

const FrameCropSchema = z.object({ leftPct: z.number().min(0).max(90) });

const SourcesSchema = z.object({
  factfile: z.string().min(1),
  demoVideo: z.string().min(1).optional(),
  demoVerdict: z.string().min(1).optional(),
  framesDir: z.string().min(1).optional(),
  frameCrop: FrameCropSchema.optional(),
});

const LinkSchema = z.object({ label: z.string().min(1), url: z.string().min(1) });

const SECTION_TYPES = ["intro", "slides", "status", "architecture", "summary"] as const;
type SectionType = (typeof SECTION_TYPES)[number];

const DEFAULT_SECTION_LABEL: Record<SectionType, string> = {
  intro: "Intro",
  slides: "Demo",
  status: "Status",
  architecture: "Architecture",
  summary: "Summary",
};

const IntroSectionSchema = z.object({
  type: z.literal("intro"),
  label: z.string().min(1).optional(),
  headline: z.string().min(1),
  body: z.string().min(1),
  video: z.boolean().default(true),
});

const SlideFrameSchema = z.object({
  frame: z.string().min(1),
  title: z.string().min(1),
  caption: z.string().min(1),
});

const SlidesSectionSchema = z.object({
  type: z.literal("slides"),
  label: z.string().min(1).optional(),
  frames: z.array(SlideFrameSchema).min(1),
});

const StatusSectionSchema = z.object({
  type: z.literal("status"),
  label: z.string().min(1).optional(),
  fromFactfile: z.boolean().default(true),
});

const ICONS = ["browser", "ui", "api", "db", "gear", "agent", "doc", "shield", "cloud", "queue"] as const;

const DiagramNodeSchema = z.object({
  id: z.string().min(1),
  icon: z.enum(ICONS),
  label: z.string().min(1),
  sub: z.string().min(1).optional(),
});

const DiagramEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().min(1).optional(),
});

const ArchitectureSectionSchema = z.object({
  type: z.literal("architecture"),
  label: z.string().min(1).optional(),
  diagram: z.object({
    nodes: z.array(DiagramNodeSchema).min(1),
    edges: z.array(DiagramEdgeSchema).default([]),
  }),
  explain: z.record(z.string().min(1)).default({}),
});

const SummarySectionSchema = z.object({
  type: z.literal("summary"),
  label: z.string().min(1).optional(),
  bullets: z.array(z.string().min(1)).min(1),
  proof: z.string().min(1).optional(),
});

const SectionSchema = z.discriminatedUnion("type", [
  IntroSectionSchema,
  SlidesSectionSchema,
  StatusSectionSchema,
  ArchitectureSectionSchema,
  SummarySectionSchema,
]);

const PersonaSchema = z.object({
  sections: z.array(z.enum(SECTION_TYPES)).min(1),
  depth: z.enum(["short", "full"]).default("short"),
  explainConcepts: z.boolean().default(false),
});

const DeckConfigSchema = z.object({
  schemaVersion: z.literal("keyoku.dev/deck/v1alpha1"),
  title: z.string().min(1),
  project: z.string().min(1),
  theme: ThemeSchema,
  sources: SourcesSchema,
  links: z.array(LinkSchema).default([]),
  sections: z.array(SectionSchema).min(1),
  personas: z.record(PersonaSchema).refine((p) => Object.keys(p).length > 0, {
    message: "at least one persona is required",
  }),
});

export type DeckConfig = z.infer<typeof DeckConfigSchema>;
export type DeckSection = z.infer<typeof SectionSchema>;
export type DeckPersona = z.infer<typeof PersonaSchema>;

// ---- the (minimal) slice of the Factfile the `status` section consumes ----

const FactfileCriterionSchema = z.object({
  id: z.string(),
  description: z.string(),
  pass: z.boolean(),
  durationMs: z.number().optional(),
  verification: z.object({ reproduce: z.string().optional() }).partial().optional(),
});

const FactfileHumanCriterionSchema = z.object({
  id: z.string(),
  description: z.string(),
  guidance: z.string().optional(),
});

const FactfileWorkItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.enum(["queued", "working", "blocked", "done"]),
});

const FactfileDirectionSchema = z.object({
  id: z.string(),
  eyebrow: z.string().optional(),
  label: z.string(),
  summary: z.string(),
});

const FactfileReviewSchema = z.object({
  criterionId: z.string().optional(),
  verdict: z.enum(["pass", "fail"]).optional(),
});

const FactfileSchema = z.object({
  state: z.string(),
  summary: z.object({ passed: z.number(), failed: z.number(), total: z.number(), verified: z.boolean() }),
  humanReview: z.object({ passed: z.number(), failed: z.number(), pending: z.number(), total: z.number() }),
  outcome: z.object({ humanCriteria: z.array(FactfileHumanCriterionSchema).default([]) }),
  evidence: z.array(FactfileCriterionSchema).default([]),
  reviews: z.array(FactfileReviewSchema).default([]),
  session: z
    .object({
      work: z.array(FactfileWorkItemSchema).default([]),
      directions: z.array(FactfileDirectionSchema).default([]),
    })
    .partial()
    .default({}),
});

type Factfile = z.infer<typeof FactfileSchema>;

// ---- small local flag helpers (kept local — index.ts's are not exported) --

function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

// ---- paths ------------------------------------------------------------

function configPath(root: string): string {
  return join(root, KEYOKU_DIR, "deck.yaml");
}

function resolveSourcePath(root: string, relOrAbs: string): string {
  return isAbsolute(relOrAbs) ? relOrAbs : join(root, relOrAbs);
}

// ---- template (deck init) ----------------------------------------------

const DECK_TEMPLATE = `# .keyoku/deck.yaml — Keyoku evidence-deck spec
# Build: keyoku deck build --for <persona> [--out <path>]
# Plan (an agent drafts/updates this file from a natural-language ask):
#   keyoku deck plan "a two-minute deck for the exec review, video first"
schemaVersion: keyoku.dev/deck/v1alpha1
title: <Deck title>
project: <Project name>
theme:
  mode: auto          # auto = follow system, with an in-page toggle (system/light/dark, persisted)
sources:
  factfile: .keyoku/contributions/<contribution-id>/factfile.json
  # demoVideo: demo-captures/<video>.webm
  # demoVerdict: .keyoku/contributions/<id>/demo-watch-verdict.json
  # framesDir: demo-captures/deck
  # frameCrop: { leftPct: 0 }     # crop e.g. a sidebar out of full-page stills

# links:
#   - { label: pull request, url: "https://github.com/org/repo/pull/1" }

sections:
  - type: intro
    headline: <One line the reader will remember>
    body: >
      A short paragraph of context — what this is and why it matters.
    video: true
  # - type: slides
  #   frames:
  #     - { frame: shot1.jpeg, title: <caption title>, caption: <one sentence> }
  - type: status        # renders straight from sources.factfile: verdict, criteria,
    fromFactfile: true  # humanReview pending, work items, directions
  # - type: architecture
  #   diagram:
  #     nodes:
  #       - { id: browser, icon: browser, label: <label>, sub: <detail> }
  #       - { id: api, icon: api, label: <label>, sub: <detail> }
  #     edges:
  #       - { from: browser, to: api, label: <optional edge label> }
  #   explain:
  #     <personaName>: <how to explain this diagram to that persona>
  - type: summary
    bullets:
      - <what shipped, bullet one>
    # proof: "Verified: N/N automated gate checks."

personas:
  stakeholder:
    sections: [intro, status, summary]
    depth: short           # status = verdict + counts + pending decisions only
    explainConcepts: true  # concept notes in plain language
  developer:
    sections: [intro, status, summary]
    depth: full             # status = every criterion with reproduce commands + durations
    explainConcepts: false
`;

function deckInit(): void {
  const root = resolve(process.cwd());
  mkdirSync(join(root, KEYOKU_DIR), { recursive: true });
  const path = configPath(root);
  if (existsSync(path)) {
    throw new Error(`${relative(root, path) || "deck.yaml"} already exists; Keyoku will not overwrite it.`);
  }
  writeFileSync(path, DECK_TEMPLATE, "utf8");
  console.log(`Created ${relative(root, path)}.

Edit sources/sections for your project, or let an agent draft it:
  keyoku deck plan "a two-minute deck for the exec review, video first"

Then render one self-contained HTML per persona:
  keyoku deck build --for stakeholder
  keyoku deck build --for developer`);
}

// ---- loading --------------------------------------------------------------

function loadDeckConfig(root: string): DeckConfig {
  const path = configPath(root);
  if (!existsSync(path)) {
    throw new Error(
      `No ${relative(root, path) || "deck.yaml"} found. Run 'keyoku deck init' first, or ` +
        `'keyoku deck plan "<what you want>"' to have an agent draft one.`,
    );
  }
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = DeckConfigSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid ${path}: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  return result.data;
}

function loadFactfile(root: string, relPath: string): Factfile {
  const path = resolveSourcePath(root, relPath);
  if (!existsSync(path)) {
    throw new Error(
      `sources.factfile points to '${relPath}', but ${path} does not exist. Run the project's proof/gate command first.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = FactfileSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `${path} does not match the expected Factfile shape: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }
  return result.data;
}

// ---- rendering primitives ---------------------------------------------

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Safe to inline inside a <script> tag: escapes '<' so a caption/string
 * value can never prematurely close the script element. */
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

const MIME: Record<string, string> = {
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function dataUri(path: string): string {
  const buf = readFileSync(path);
  const mime = MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
  return `data:${mime};base64,${buf.toString("base64")}`;
}

// ---- built-in icon set (minimal line icons, currentColor, no fixed fills) -

const ICON_DEFS = `
<symbol id="icon-browser" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <rect x="2.5" y="4" width="19" height="16" rx="2"/>
  <line x1="2.5" y1="8.5" x2="21.5" y2="8.5"/>
  <circle cx="5.5" cy="6.25" r="0.6" fill="currentColor" stroke="none"/>
  <circle cx="7.7" cy="6.25" r="0.6" fill="currentColor" stroke="none"/>
</symbol>
<symbol id="icon-ui" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="3" width="8" height="8" rx="1.2"/>
  <rect x="13" y="3" width="8" height="5" rx="1.2"/>
  <rect x="13" y="10" width="8" height="11" rx="1.2"/>
  <rect x="3" y="13" width="8" height="8" rx="1.2"/>
</symbol>
<symbol id="icon-api" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4 8h13"/>
  <path d="M13 4l4 4-4 4"/>
  <path d="M20 16H7"/>
  <path d="M11 20l-4-4 4-4"/>
</symbol>
<symbol id="icon-db" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <ellipse cx="12" cy="5.5" rx="8" ry="3"/>
  <path d="M4 5.5v13c0 1.66 3.58 3 8 3s8-1.34 8-3v-13"/>
  <path d="M4 12c0 1.66 3.58 3 8 3s8-1.34 8-3"/>
</symbol>
<symbol id="icon-gear" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="3.2"/>
  <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>
</symbol>
<symbol id="icon-agent" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <rect x="5" y="8" width="14" height="11" rx="2"/>
  <circle cx="9.5" cy="13.5" r="1.1" fill="currentColor" stroke="none"/>
  <circle cx="14.5" cy="13.5" r="1.1" fill="currentColor" stroke="none"/>
  <path d="M12 8V4"/>
  <circle cx="12" cy="3" r="1" fill="currentColor" stroke="none"/>
  <path d="M2 13h3M19 13h3"/>
</symbol>
<symbol id="icon-doc" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M6 2.5h9l4 4V21a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z"/>
  <path d="M14.5 2.5V7h4.5"/>
  <path d="M8 12h8M8 15.5h8M8 19h5"/>
</symbol>
<symbol id="icon-shield" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M12 2.5l7.5 3v6c0 5-3.2 8.6-7.5 10-4.3-1.4-7.5-5-7.5-10v-6z"/>
  <path d="M8.7 12l2.4 2.4 4.6-4.8"/>
</symbol>
<symbol id="icon-cloud" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <path d="M7.5 18a4.5 4.5 0 0 1-.5-8.97A5.5 5.5 0 0 1 17.9 9.1 4 4 0 0 1 17.5 18h-10z"/>
</symbol>
<symbol id="icon-queue" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="4.5" width="18" height="4" rx="1"/>
  <rect x="3" y="10" width="18" height="4" rx="1"/>
  <rect x="3" y="15.5" width="18" height="4" rx="1"/>
</symbol>`;

// ---- architecture diagram layout + render ---------------------------------

interface DiagramNode {
  id: string;
  icon: string;
  label: string;
  sub?: string;
}
interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
}

/** Longest-path layering: a node's layer is 1 + the max layer of every node
 * with an edge into it (0 if none). Bounded relaxation passes so a cyclic
 * diagram degrades gracefully instead of looping forever. */
function layerNodes(nodes: DiagramNode[], edges: DiagramEdge[]): Map<string, number> {
  const incoming = new Map<string, string[]>();
  for (const n of nodes) incoming.set(n.id, []);
  for (const e of edges) {
    if (!incoming.has(e.to)) continue; // edge references an unknown node — ignore defensively
    incoming.get(e.to)!.push(e.from);
  }
  const layer = new Map<string, number>();
  for (const n of nodes) layer.set(n.id, 0);
  for (let pass = 0; pass < nodes.length + 1; pass++) {
    let changed = false;
    for (const n of nodes) {
      let maxIn = -1;
      for (const src of incoming.get(n.id) ?? []) {
        if (!layer.has(src)) continue;
        maxIn = Math.max(maxIn, layer.get(src)!);
      }
      const next = maxIn + 1;
      if (next > (layer.get(n.id) ?? 0)) {
        layer.set(n.id, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return layer;
}

function renderArchitectureSvg(nodes: DiagramNode[], edges: DiagramEdge[], title: string): string {
  const layer = layerNodes(nodes, edges);
  const uniqueLayers = [...new Set(nodes.map((n) => layer.get(n.id) ?? 0))].sort((a, b) => a - b);
  const colOf = new Map(uniqueLayers.map((l, i) => [l, i]));
  const columns: DiagramNode[][] = uniqueLayers.map(() => []);
  for (const n of nodes) columns[colOf.get(layer.get(n.id) ?? 0)!]!.push(n);

  const boxW = 208;
  const boxH = 84;
  const colGap = 76;
  const rowGap = 30;
  const margin = 44;
  const numCols = columns.length;
  const maxRows = Math.max(...columns.map((c) => c.length), 1);
  const width = margin * 2 + numCols * boxW + (numCols - 1) * colGap;
  const height = margin * 2 + maxRows * boxH + (maxRows - 1) * rowGap;

  const pos = new Map<string, { x: number; y: number }>();
  columns.forEach((col, ci) => {
    const colHeight = col.length * boxH + (col.length - 1) * rowGap;
    const startY = margin + (height - margin * 2 - colHeight) / 2;
    col.forEach((n, ri) => {
      pos.set(n.id, { x: margin + ci * (boxW + colGap), y: startY + ri * (boxH + rowGap) });
    });
  });

  const nodesSvg = nodes
    .map((n) => {
      const p = pos.get(n.id);
      if (!p) return "";
      const iconId = ICONS.includes(n.icon as (typeof ICONS)[number]) ? n.icon : "doc";
      return `<g class="arch-node">
  <rect class="node-box" x="${p.x}" y="${p.y}" width="${boxW}" height="${boxH}" rx="10"/>
  <use class="node-icon" href="#icon-${iconId}" x="${p.x + 14}" y="${p.y + 14}" width="20" height="20"/>
  <text class="node-label" x="${p.x + 44}" y="${p.y + 28}">${esc(n.label)}</text>
  ${n.sub ? `<text class="node-sub" x="${p.x + 14}" y="${p.y + 54}">${esc(n.sub)}</text>` : ""}
</g>`;
    })
    .join("\n");

  const edgesSvg = edges
    .map((e) => {
      const from = pos.get(e.from);
      const to = pos.get(e.to);
      if (!from || !to) return ""; // defensive: never fail a build over a typo'd edge id
      const sameCol = from.x === to.x;
      let sx: number, sy: number, tx: number, ty: number, c1x: number, c1y: number, c2x: number, c2y: number;
      if (sameCol) {
        sx = from.x + boxW / 2;
        sy = from.y + boxH;
        tx = to.x + boxW / 2;
        ty = to.y;
        c1x = sx;
        c1y = sy + rowGap / 2;
        c2x = tx;
        c2y = ty - rowGap / 2;
      } else if (to.x >= from.x) {
        sx = from.x + boxW;
        sy = from.y + boxH / 2;
        tx = to.x;
        ty = to.y + boxH / 2;
        c1x = sx + colGap / 2;
        c1y = sy;
        c2x = tx - colGap / 2;
        c2y = ty;
      } else {
        sx = from.x;
        sy = from.y + boxH / 2;
        tx = to.x + boxW;
        ty = to.y + boxH / 2;
        c1x = sx - colGap / 2;
        c1y = sy;
        c2x = tx + colGap / 2;
        c2y = ty;
      }
      const midX = (sx + tx) / 2;
      const midY = (sy + ty) / 2;
      const label = e.label
        ? `<g class="edge-label"><rect x="${midX - esc(e.label).length * 2.9 - 6}" y="${midY - 15}" width="${esc(e.label).length * 5.8 + 12}" height="16" rx="4"/><text x="${midX}" y="${midY - 3}" text-anchor="middle">${esc(e.label)}</text></g>`
        : "";
      return `<path class="edge-line" d="M${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${tx},${ty}" marker-end="url(#arrow-head)"/>${label}`;
    })
    .join("\n");

  return `<svg class="arch-svg" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(title)} architecture diagram">
<defs>${ICON_DEFS}
<marker id="arrow-head" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="edge-arrow"/></marker>
</defs>
<g class="arch-edges">${edgesSvg}</g>
<g class="arch-nodes">${nodesSvg}</g>
</svg>`;
}

// ---- section renderers: each returns one or more full slide `inner` HTML --

interface RenderedSlide {
  sectionType: SectionType;
  inner: string;
}

function renderIntroSlide(section: z.infer<typeof IntroSectionSchema>, root: string, sources: DeckConfig["sources"]): RenderedSlide[] {
  const videoBlock =
    section.video && sources.demoVideo
      ? `<div class="intro-video"><video src="${dataUri(resolveSourcePath(root, sources.demoVideo))}" controls playsinline></video></div>`
      : "";
  return [
    {
      sectionType: "intro",
      inner: `<div class="intro-wrap">
  <div class="intro-text"><h1>${esc(section.headline)}</h1><p>${esc(section.body)}</p></div>
  ${videoBlock}
</div>`,
    },
  ];
}

function renderSlidesSlides(section: z.infer<typeof SlidesSectionSchema>, root: string, sources: DeckConfig["sources"]): RenderedSlide[] {
  if (!sources.framesDir) {
    throw new Error("A 'slides' section requires sources.framesDir to be set.");
  }
  const leftPct = sources.frameCrop?.leftPct ?? 0;
  return section.frames.map((f) => ({
    sectionType: "slides" as const,
    inner: `<div class="shot"><img src="${dataUri(join(resolveSourcePath(root, sources.framesDir!), f.frame))}" style="margin-left:-${leftPct}%" alt="${esc(f.title)}"></div>
<div class="cap"><span class="k">${esc(f.title)}</span><p>${esc(f.caption)}</p></div>`,
  }));
}

function chip(status: string, label: string): string {
  return `<span class="chip chip-${esc(status)}">${esc(label)}</span>`;
}

function renderStatusSlides(
  section: z.infer<typeof StatusSectionSchema>,
  factfile: Factfile,
  persona: DeckPersona,
): RenderedSlide[] {
  const { summary, humanReview, outcome, evidence, reviews, session } = factfile;
  const overallPass = summary.failed === 0 && summary.total > 0;
  const verdictLabel = overallPass ? "PASS" : "FAIL";
  const stateLabel = factfile.state.replace(/_/g, " ");
  const work = session.work ?? [];
  const directions = session.directions ?? [];
  const pendingHuman = outcome.humanCriteria.filter(
    (hc) => !reviews.some((r) => r.criterionId === hc.id && r.verdict === "pass"),
  );

  const conceptNote = persona.explainConcepts
    ? `<p class="concept-note">"Verdict" means every automated check that defines this outcome's "done" actually ran and passed against this exact revision — not a claim, a re-run.</p>`
    : "";

  const verdictBlock = `<div class="verdict"><span class="badge badge-${overallPass ? "pass" : "fail"}">${verdictLabel}</span><span class="counts">${summary.passed}/${summary.total} automated checks passed · ${humanReview.pending}/${humanReview.total} human decisions pending</span></div>
<p class="state-line">${esc(stateLabel)}</p>`;

  const pendingBlock = `<div class="pending"><h3>Pending human decisions (${pendingHuman.length})</h3>${
    pendingHuman.length
      ? `<ul>${pendingHuman.map((hc) => `<li>${esc(hc.description)}</li>`).join("")}</ul>`
      : `<p class="muted-line">None — every human decision has been resolved.</p>`
  }</div>`;

  const workBlock = `<div class="workchips"><h3>Work items (${work.length})</h3><div class="chips">${
    work.length ? work.map((w) => chip(w.status, w.title)).join("") : `<span class="muted-line">None recorded.</span>`
  }</div></div>`;

  if (persona.depth === "short") {
    return [
      {
        sectionType: "status",
        inner: `<div class="status-wrap status-short">
  <h2>${esc(section.label ?? "Status")}</h2>
  ${verdictBlock}
  ${conceptNote}
  ${pendingBlock}
  ${workBlock}
</div>`,
      },
    ];
  }

  const criteriaRows = evidence
    .map((c) => {
      const reproduceRow = c.verification?.reproduce
        ? `<tr class="repro-row"><td></td><td colspan="2"><code>${esc(c.verification.reproduce)}</code></td></tr>`
        : "";
      const duration = c.durationMs !== undefined ? `${(c.durationMs / 1000).toFixed(1)}s` : "";
      return `<tr><td class="mark mark-${c.pass ? "pass" : "fail"}">${c.pass ? "✓" : "✗"}</td><td class="desc">${esc(c.description)}</td><td class="dur">${esc(duration)}</td></tr>${reproduceRow}`;
    })
    .join("");

  const directionsBlock = `<div class="directions"><h3>Directions</h3>${
    directions.length
      ? `<ul>${directions.map((d) => `<li><strong>${esc(d.label)}</strong> — ${esc(d.summary)}</li>`).join("")}</ul>`
      : `<p class="muted-line">None proposed.</p>`
  }</div>`;

  return [
    {
      sectionType: "status",
      inner: `<div class="status-wrap status-full">
  <h2>${esc(section.label ?? "Status")}</h2>
  ${verdictBlock}
  <table class="criteria"><tbody>${criteriaRows}</tbody></table>
</div>`,
    },
    {
      sectionType: "status",
      inner: `<div class="status-wrap status-full">
  <h2>Human review &amp; directions</h2>
  ${pendingBlock}
  ${workBlock}
  ${directionsBlock}
</div>`,
    },
  ];
}

function renderArchitectureSlide(section: z.infer<typeof ArchitectureSectionSchema>, personaName: string, title: string): RenderedSlide[] {
  const explainText = section.explain[personaName] ?? Object.values(section.explain)[0] ?? "";
  const svg = renderArchitectureSvg(section.diagram.nodes, section.diagram.edges, title);
  return [
    {
      sectionType: "architecture",
      inner: `<div class="arch-wrap">
  <h2>${esc(section.label ?? "Architecture")}</h2>
  ${svg}
  ${explainText ? `<p class="explain">${esc(explainText)}</p>` : ""}
</div>`,
    },
  ];
}

function renderSummarySlide(section: z.infer<typeof SummarySectionSchema>, links: DeckConfig["links"]): RenderedSlide[] {
  return [
    {
      sectionType: "summary",
      inner: `<div class="sum">
  <h2>${esc(section.label ?? "What shipped")}</h2>
  <ul>${section.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>
  ${section.proof ? `<p class="proof">${esc(section.proof)}</p>` : ""}
  ${links.length ? `<p class="links">${links.map((l) => `<a href="${esc(l.url)}">${esc(l.label)}</a>`).join(" &middot; ")}</p>` : ""}
</div>`,
    },
  ];
}

// ---- full document ------------------------------------------------------

function renderStyle(): string {
  return `<style>
:root{--bg:#111315;--surface:#1A1D20;--ink:#F2F3F4;--muted:#9BA1A6;--line:#2A2E32;--accent:#E8E9EA;--tabbg:rgba(26,29,32,.92);--chipq:#2c3a5a;--chipw:#5a4a1f;--chipb:#5a2c2c;--chipd:#2c5a3d}
@media(prefers-color-scheme:light){:root{--bg:#FAFAF9;--surface:#FFFFFF;--ink:#1A1D20;--muted:#6B7076;--line:#E4E4E2;--accent:#1A1D20;--tabbg:rgba(255,255,255,.92)}}
html[data-theme="dark"]{--bg:#111315;--surface:#1A1D20;--ink:#F2F3F4;--muted:#9BA1A6;--line:#2A2E32;--accent:#E8E9EA;--tabbg:rgba(26,29,32,.92)}
html[data-theme="light"]{--bg:#FAFAF9;--surface:#FFFFFF;--ink:#1A1D20;--muted:#6B7076;--line:#E4E4E2;--accent:#1A1D20;--tabbg:rgba(255,255,255,.92)}
*{box-sizing:border-box}
html,body{height:100%}
body{margin:0;background:var(--bg);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;overflow:hidden;transition:background .15s,color .15s}
.deck{display:flex;height:100dvh;overflow-x:auto;overflow-y:hidden;scroll-snap-type:x mandatory;scrollbar-width:none}
.deck::-webkit-scrollbar{display:none}
.slide{flex:0 0 100vw;height:100dvh;scroll-snap-align:start;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;padding:96px 56px 78px;overflow:hidden}
.shot{width:min(100vw - 112px, calc((100dvh - 220px) * 1.4667));aspect-ratio:1056/720;overflow:hidden;border-radius:8px;border:1px solid var(--line);background:#000;flex:0 1 auto}
.shot img{height:100%;width:auto;display:block;max-width:none}
.cap{max-width:860px;text-align:center}
.cap .k{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--muted)}
.cap p{margin:5px 0 0;font-size:15px;line-height:1.45;color:var(--ink)}
.intro-wrap{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:36px;max-width:1160px;width:100%}
.intro-text{flex:1 1 380px;max-width:520px}
.intro-text h1{font-size:32px;line-height:1.15;letter-spacing:-.01em;margin:0 0 14px}
.intro-text p{font-size:15.5px;line-height:1.6;color:var(--muted)}
.intro-video{flex:1 1 480px;max-width:640px}
.intro-video video{width:100%;max-height:calc(100dvh - 220px);border-radius:8px;border:1px solid var(--line);background:#000;display:block}
.sum{max-width:640px}
.sum h2{font-size:30px;margin:0 0 18px;letter-spacing:-.01em}
.sum ul{margin:0;padding-left:20px;line-height:1.9;font-size:15.5px;color:var(--ink)}
.sum .proof{color:var(--muted);font-size:14px;margin-top:20px}
.sum .links{font-size:14px}
.sum a{color:var(--accent);text-decoration:underline;text-underline-offset:3px}
.status-wrap{max-width:880px;width:100%;max-height:calc(100dvh - 220px);overflow:auto}
.status-wrap h2{font-size:26px;margin:0 0 14px;letter-spacing:-.01em}
.status-wrap h3{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:18px 0 8px}
.verdict{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.badge{font-size:12px;font-weight:800;letter-spacing:.08em;padding:4px 10px;border-radius:5px}
.badge-pass{background:var(--chipd);color:#eafff1}
.badge-fail{background:var(--chipb);color:#ffecec}
.counts{font-size:14px;color:var(--muted)}
.state-line{font-size:12px;color:var(--muted);text-transform:capitalize;margin:4px 0 0}
.concept-note{font-size:13px;color:var(--muted);border-left:2px solid var(--line);padding-left:10px;margin:12px 0}
.pending ul,.directions ul{margin:0;padding-left:18px;font-size:14px;line-height:1.7}
.muted-line{color:var(--muted);font-size:13px;margin:0}
.chips{display:flex;flex-wrap:wrap;gap:8px}
.chip{font-size:12px;padding:4px 10px;border-radius:999px;border:1px solid var(--line)}
.chip-done{background:var(--chipd);color:#eafff1;border-color:transparent}
.chip-blocked{background:var(--chipb);color:#ffecec;border-color:transparent}
.chip-queued{background:var(--chipq);color:#eaf0ff;border-color:transparent}
.chip-working{background:var(--chipw);color:#fff8e3;border-color:transparent}
table.criteria{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:10px}
table.criteria td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
table.criteria .mark{width:22px;text-align:center;font-weight:700}
.mark-pass{color:#3fbf76}
.mark-fail{color:#e2695f}
table.criteria .dur{width:64px;color:var(--muted);text-align:right;font-variant-numeric:tabular-nums}
table.criteria .repro-row td{border-bottom:1px solid var(--line);padding-top:0}
table.criteria code{font-family:ui-monospace,Menlo,monospace;font-size:11.5px;color:var(--muted);word-break:break-all}
.arch-wrap{max-width:1080px;width:100%;text-align:center}
.arch-wrap h2{font-size:26px;margin:0 0 10px;letter-spacing:-.01em}
.arch-svg{width:100%;height:auto;max-height:calc(100dvh - 300px)}
.arch-svg .node-box{fill:var(--surface);stroke:var(--line)}
.arch-svg .node-icon{color:var(--ink)}
.arch-svg .node-label{fill:var(--ink);font-family:-apple-system,sans-serif;font-size:13.5px;font-weight:600}
.arch-svg .node-sub{fill:var(--muted);font-family:-apple-system,sans-serif;font-size:10.5px}
.arch-svg .edge-line{fill:none;stroke:var(--muted);stroke-width:1.6}
.arch-svg .edge-arrow{fill:var(--muted)}
.arch-svg .edge-label rect{fill:var(--surface);stroke:var(--line)}
.arch-svg .edge-label text{fill:var(--ink);font-family:ui-monospace,monospace;font-size:10px}
.arch-wrap .explain{max-width:760px;margin:16px auto 0;font-size:14px;line-height:1.6;color:var(--muted);text-align:left}
.topbar{position:fixed;top:0;left:0;right:0;z-index:6;display:flex;align-items:center;gap:18px;padding:0 18px;height:52px;background:var(--tabbg);backdrop-filter:blur(6px);border-bottom:1px solid var(--line)}
.brand{font-size:11px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);white-space:nowrap}
.tabs{display:flex;gap:4px;overflow-x:auto;flex:1 1 auto}
.tab{appearance:none;border:none;background:transparent;color:var(--muted);font-size:12.5px;font-weight:600;padding:8px 12px;border-radius:6px;cursor:pointer;white-space:nowrap}
.tab:hover{color:var(--ink)}
.tab.active{color:var(--ink);background:var(--line)}
.topbar-right{display:flex;align-items:center;gap:12px;white-space:nowrap}
.theme-toggle{appearance:none;border:1px solid var(--line);background:var(--surface);color:var(--ink);font-size:11px;padding:6px 10px;border-radius:6px;cursor:pointer}
.count{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums}
nav.dots{position:fixed;bottom:0;left:0;right:0;display:flex;align-items:center;justify-content:center;gap:14px;padding:14px;background:linear-gradient(transparent,rgba(0,0,0,.18))}
.dot{width:8px;height:8px;border-radius:50%;border:none;background:var(--line);cursor:pointer;padding:0}
.dot.on{background:var(--ink)}
.arrow{position:fixed;top:calc(50% + 20px);transform:translateY(-50%);width:44px;height:44px;border-radius:50%;border:1px solid var(--line);background:var(--surface);color:var(--ink);font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center;z-index:5;opacity:.9}
.arrow:hover{opacity:1}
.arrow:focus-visible,.dot:focus-visible,.tab:focus-visible,.theme-toggle:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
#prev{left:12px}#next{right:12px}
@media(prefers-reduced-motion:no-preference){.deck{scroll-behavior:smooth}}
</style>`;
}

function renderScript(sectionRanges: Array<{ type: string; start: number }>, totalSlides: number): string {
  return `<script>
var SECTION_RANGES=${scriptJson(sectionRanges)};
var deck=document.getElementById('deck'),N=${totalSlides},cur=0;
function sectionForIndex(i){var owner=SECTION_RANGES[0];for(var k=0;k<SECTION_RANGES.length;k++){if(SECTION_RANGES[k].start<=i)owner=SECTION_RANGES[k];}return owner;}
function go(i){cur=Math.max(0,Math.min(N-1,i));deck.scrollTo({left:cur*window.innerWidth});paint();}
function paint(){
  document.querySelectorAll('.dot').forEach(function(d,i){d.classList.toggle('on',i===cur);});
  var c=document.getElementById('count');if(c)c.textContent=(cur+1)+' / '+N;
  var owner=sectionForIndex(cur);
  document.querySelectorAll('.tab').forEach(function(t){t.classList.toggle('active',t.dataset.type===owner.type);});
  var v=document.querySelector('video');var slide=document.querySelectorAll('.slide')[cur];
  if(v&&(!slide||!slide.contains(v)))v.pause();
}
document.getElementById('prev').onclick=function(){go(cur-1)};
document.getElementById('next').onclick=function(){go(cur+1)};
document.querySelectorAll('.dot').forEach(function(d){d.onclick=function(){go(+d.dataset.i)};});
document.querySelectorAll('.tab').forEach(function(t){t.onclick=function(){go(+t.dataset.start)};});
document.addEventListener('keydown',function(e){if(e.key==='ArrowRight'||e.key===' ')go(cur+1);if(e.key==='ArrowLeft')go(cur-1);});
deck.addEventListener('scroll',function(){var i=Math.round(deck.scrollLeft/window.innerWidth);if(i!==cur){cur=i;paint();}});
window.addEventListener('resize',function(){go(cur)});
paint();
(function(){
  var KEY='keyoku-deck-theme';var order=['system','light','dark'];var btn=document.getElementById('themeBtn');
  function apply(mode){
    if(mode==='system')document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme',mode);
    btn.textContent='Theme: '+mode.charAt(0).toUpperCase()+mode.slice(1);
  }
  var stored=localStorage.getItem(KEY)||'system';
  apply(stored);
  btn.onclick=function(){var idx=order.indexOf(stored);stored=order[(idx+1)%order.length];localStorage.setItem(KEY,stored);apply(stored);};
})();
</script>`;
}

export function renderDeck(config: DeckConfig, personaName: string, persona: DeckPersona, factfile: Factfile, root: string): string {
  const sectionByType = new Map(config.sections.map((s) => [s.type, s] as const));
  for (const type of persona.sections) {
    if (!sectionByType.has(type)) {
      throw new Error(`Persona '${personaName}' references section type '${type}', which is not defined in top-level 'sections'.`);
    }
  }

  const slides: RenderedSlide[] = [];
  const sectionRanges: Array<{ type: SectionType; label: string; start: number }> = [];
  for (const type of persona.sections) {
    const section = sectionByType.get(type)!;
    const start = slides.length;
    let rendered: RenderedSlide[];
    switch (section.type) {
      case "intro":
        rendered = renderIntroSlide(section, root, config.sources);
        break;
      case "slides":
        rendered = renderSlidesSlides(section, root, config.sources);
        break;
      case "status":
        rendered = renderStatusSlides(section, factfile, persona);
        break;
      case "architecture":
        rendered = renderArchitectureSlide(section, personaName, config.title);
        break;
      case "summary":
        rendered = renderSummarySlide(section, config.links);
        break;
    }
    slides.push(...rendered);
    sectionRanges.push({ type, label: ("label" in section && section.label) || DEFAULT_SECTION_LABEL[type], start });
  }

  const N = slides.length;
  const slideHtml = slides
    .map((s, i) => `<section class="slide" id="s${i + 1}" data-section="${s.sectionType}">\n${s.inner}\n</section>`)
    .join("\n");
  const tabsHtml = sectionRanges
    .map((r) => `<button class="tab" data-type="${esc(r.type)}" data-start="${r.start}">${esc(r.label)}</button>`)
    .join("");
  const dotsHtml = slides.map((_, i) => `<button class="dot" data-i="${i}" aria-label="Slide ${i + 1}"></button>`).join("");

  return `<meta charset="utf-8">
<title>${esc(config.title)}</title>
${renderStyle()}
<header class="topbar">
  <span class="brand">${esc(config.project)} &middot; ${esc(personaName)}</span>
  <nav class="tabs" id="tabs">${tabsHtml}</nav>
  <div class="topbar-right">
    <button class="theme-toggle" id="themeBtn" aria-label="Toggle theme">Theme: System</button>
    <span class="count" id="count">1 / ${N}</span>
  </div>
</header>
<div class="deck" id="deck">${slideHtml}</div>
<button class="arrow" id="prev" aria-label="Previous slide">&#8249;</button>
<button class="arrow" id="next" aria-label="Next slide">&#8250;</button>
<nav class="dots" id="dots">${dotsHtml}</nav>
${renderScript(
  sectionRanges.map((r) => ({ type: r.type, start: r.start })),
  N,
)}`;
}

// ---- build ---------------------------------------------------------------

async function deckBuild(args: string[]): Promise<void> {
  const root = resolve(process.cwd());
  const config = loadDeckConfig(root);
  const personaNames = Object.keys(config.personas);
  const requested = flagValue(args, "--for");
  const personaName = requested ?? personaNames[0];
  if (!personaName || !config.personas[personaName]) {
    throw new Error(`Unknown persona '${requested ?? ""}'. Available: ${personaNames.join(", ") || "(none defined)"}`);
  }
  const persona = config.personas[personaName]!;
  const outArg = flagValue(args, "--out");
  const outPath = outArg ? resolve(root, outArg) : join(root, KEYOKU_DIR, "deck", `deck-${personaName}.html`);
  const factfile = loadFactfile(root, config.sources.factfile);
  const html = renderDeck(config, personaName, persona, factfile, root);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, html, "utf8");
  console.log(`Built '${personaName}' deck (${persona.sections.length} section(s)) -> ${relative(root, outPath) || outPath}`);
}

// ---- plan (agent-drafted config; the only place autonomy lives) ----------

function buildPlanPrompt(root: string, request: string): string {
  const path = configPath(root);
  const rel = relative(root, path) || "deck.yaml";
  return `You are planning a Keyoku evidence deck for this repository. Read the project's available demo/proof assets — most importantly the latest Factfile (an outcome's evidence snapshot under .keyoku/contributions/*/factfile.json), any recorded demo video/frames, and any existing ${rel} — and WRITE (or update) ${path} so it satisfies this request:

"${request}"

${rel} MUST validate against this exact shape (schemaVersion "keyoku.dev/deck/v1alpha1"):

  schemaVersion: keyoku.dev/deck/v1alpha1
  title: <string>
  project: <string>
  theme: { mode: auto|light|dark }
  sources:
    factfile: <path to a real factfile.json, relative to repo root>
    demoVideo: <path to a recorded demo video, optional>
    demoVerdict: <path to a demo-watch verdict.json, optional>
    framesDir: <dir of still-frame images referenced by 'slides' sections, optional>
    frameCrop: { leftPct: <number 0-90> }   # optional CSS crop, e.g. to remove a sidebar from full-page stills
  links: [{ label: <string>, url: <string> }, ...]
  sections:                     # each item is ONE of:
    - { type: intro, label?: <string>, headline: <string>, body: <string>, video?: <bool> }
    - { type: slides, label?: <string>, frames: [{ frame: <filename in framesDir>, title: <string>, caption: <string> }, ...] }
    - { type: status, label?: <string>, fromFactfile: true }
    - { type: architecture, label?: <string>, diagram: { nodes: [{ id, icon: browser|ui|api|db|gear|agent|doc|shield|cloud|queue, label, sub? }], edges: [{ from, to, label? }] }, explain: { <personaName>: <string>, ... } }
    - { type: summary, label?: <string>, bullets: [<string>, ...], proof?: <string> }
  personas:
    <personaName>:
      sections: [<one or more of intro|slides|status|architecture|summary, in the order to render them>]
      depth: short|full        # status: short = verdict+counts+pending decisions+work chips only; full = every criterion + reproduce commands
      explainConcepts: <bool>  # true = add a plain-language note explaining the gate concept

Rules:
- \`keyoku deck build --for <persona>\` renders whatever you write here DETERMINISTICALLY — no agent runs at build time — so every fact you put in the YAML (frame filenames, node ids referenced by edges, factfile path) must be real and correct.
- Prefer editing the existing ${rel} in place over inventing a new structure, unless the request clearly needs a new persona or section mix.
- Do not fabricate factfile numbers, PR links, or frame filenames — verify paths exist before writing them.

When you are done, ${path} must exist and parse as valid YAML matching the shape above. Contract note for any agent runner substituted for this CLI wrapper: the only hard requirement is that the file exists afterward and matches this shape — how you get there is up to you.`;
}

async function deckPlan(rest: string[]): Promise<void> {
  const request = rest.join(" ").trim();
  if (!request) throw new Error('Usage: keyoku deck plan "<what you want the deck to say>"');
  const root = resolve(process.cwd());
  const path = configPath(root);
  const availability = spawnSync("claude", ["--version"], { stdio: "ignore" });
  if (availability.status !== 0) {
    console.error(
      "No agent runner available: the `claude` CLI was not found on PATH.\n" +
        `'keyoku deck plan' needs an agent that can read repo files and write ${relative(root, path) || "deck.yaml"}.\n` +
        "Any runner may be substituted, as long as it writes a deck.yaml matching the keyoku.dev/deck/v1alpha1 shape — see 'keyoku deck init' for a template.",
    );
    process.exit(2);
  }
  const prompt = buildPlanPrompt(root, request);
  console.log(`Planning a deck with \`claude\`: "${request}"...`);
  const run = spawnSync("claude", ["-p", prompt, "--permission-mode", "acceptEdits"], { cwd: root, stdio: "inherit" });
  if (run.status !== 0) {
    console.error(`\`claude\` exited with status ${run.status ?? "unknown"}.`);
    process.exit(run.status && run.status > 0 ? run.status : 1);
  }
  if (!existsSync(path)) {
    console.error(`The agent run finished but ${relative(root, path) || "deck.yaml"} was not written.`);
    process.exit(2);
  }
  console.log(`\nWrote ${relative(root, path) || "deck.yaml"}. Review it, then:\n  keyoku deck build --for <persona>`);
}

// ---- entrypoint ------------------------------------------------------

export async function deckCmd(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "init") return deckInit();
  if (sub === "build") return deckBuild(rest);
  if (sub === "plan") return deckPlan(rest);
  throw new Error('Usage: keyoku deck init | build [--for <persona>] [--out <path>] | plan "<natural language>"');
}

export { DeckConfigSchema, FactfileSchema };
