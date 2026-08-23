import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

// ---------------------------------------------------------------------------
// `keyoku arch` — a standalone, deterministic architecture-diagram renderer.
// `renderArchSvg` is a pure function (spec in, SVG string out — no I/O, no
// randomness) so it is safely reusable both by `keyoku deck`'s `architecture`
// section (embedded mode, inherits the deck's design tokens) and directly via
// the `keyoku arch render <spec.yaml>` CLI (standalone mode, ships its own
// minimal <style> so the file is legible opened on its own).
// ---------------------------------------------------------------------------

// ---- icon registry: one small, consistent line-icon family ----------------
// 24x24 viewBox, stroke="currentColor", stroke-width 1.5, round caps/joins,
// no fills except small accent dots — same visual weight and optical size
// across the whole set so a diagram never looks like mixed clip-art.

export const ICON_IDS = [
  "browser",
  "ui",
  "api",
  "db",
  "gear",
  "agent",
  "doc",
  "shield",
  "cloud",
  "queue",
  "cache",
  "storage",
  "lock",
  "chart",
  "mail",
  "mobile",
  "terminal",
  "git",
  "user",
  "webhook",
] as const;
export type IconId = (typeof ICON_IDS)[number];

const ICON_PATHS: Record<IconId, string> = {
  browser: `<rect x="2.75" y="4" width="18.5" height="16" rx="2.25"/>
<path d="M2.75 8.75h18.5"/>
<circle cx="5.75" cy="6.375" r="0.55" fill="currentColor" stroke="none"/>
<circle cx="7.85" cy="6.375" r="0.55" fill="currentColor" stroke="none"/>`,
  ui: `<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/>
<rect x="13.5" y="3" width="7.5" height="4.5" rx="1.5"/>
<rect x="13.5" y="9.5" width="7.5" height="11.5" rx="1.5"/>
<rect x="3" y="12.5" width="7.5" height="8.5" rx="1.5"/>`,
  api: `<path d="M4 8.5h12.5"/>
<path d="M13 4.5l4 4-4 4"/>
<path d="M20 15.5H7.5"/>
<path d="M11 19.5l-4-4 4-4"/>`,
  db: `<ellipse cx="12" cy="5.5" rx="8" ry="2.75"/>
<path d="M4 5.5v13c0 1.52 3.58 2.75 8 2.75s8-1.23 8-2.75v-13"/>
<path d="M4 12c0 1.52 3.58 2.75 8 2.75s8-1.23 8-2.75"/>`,
  gear: `<circle cx="12" cy="12" r="3.1"/>
<path d="M12 2.5v3M12 18.5v3M4.4 4.4l2.1 2.1M17.5 17.5l2.1 2.1M2.5 12h3M18.5 12h3M4.4 19.6l2.1-2.1M17.5 6.5l2.1-2.1"/>`,
  agent: `<rect x="5" y="8" width="14" height="11" rx="2.25"/>
<circle cx="9.5" cy="13.5" r="1" fill="currentColor" stroke="none"/>
<circle cx="14.5" cy="13.5" r="1" fill="currentColor" stroke="none"/>
<path d="M12 8V4.5"/>
<circle cx="12" cy="3.25" r="1" fill="currentColor" stroke="none"/>
<path d="M2.5 13h2.5M19 13h2.5"/>`,
  doc: `<path d="M6.25 2.5h8.5l4.25 4.25V21a1 1 0 0 1-1 1H6.25a1 1 0 0 1-1-1V3.5a1 1 0 0 1 1-1z"/>
<path d="M14.75 2.5V7h4.25"/>
<path d="M8 12.25h8M8 15.75h8M8 19.25h4.75"/>`,
  shield: `<path d="M12 2.5l7.25 2.9v5.8c0 4.85-3.1 8.35-7.25 9.7-4.15-1.35-7.25-4.85-7.25-9.7V5.4z"/>
<path d="M8.75 12l2.35 2.35 4.4-4.6"/>`,
  cloud: `<path d="M7.5 18a4.35 4.35 0 0 1-.5-8.67A5.35 5.35 0 0 1 17.65 9.05 3.85 3.85 0 0 1 17.35 18h-9.85z"/>`,
  queue: `<rect x="3" y="4.5" width="18" height="3.75" rx="1"/>
<rect x="3" y="10.125" width="18" height="3.75" rx="1"/>
<rect x="3" y="15.75" width="18" height="3.75" rx="1"/>`,
  cache: `<path d="M12 3.5l8 4.25-8 4.25-8-4.25z"/>
<path d="M4 12l8 4.25L20 12"/>
<path d="M4 15.75l8 4.25 8-4.25"/>`,
  storage: `<path d="M5 6.5h14l-1.4 12.6a2 2 0 0 1-2 1.9H8.4a2 2 0 0 1-2-1.9z"/>
<path d="M3.5 6.5h17"/>
<path d="M9 3.5h6l1 3H8z"/>`,
  lock: `<rect x="5" y="10.5" width="14" height="10" rx="2"/>
<path d="M8 10.5V7.75a4 4 0 0 1 8 0v2.75"/>
<circle cx="12" cy="15" r="1.15" fill="currentColor" stroke="none"/>
<path d="M12 16.15v1.85"/>`,
  chart: `<path d="M3.5 20.5h17"/>
<rect x="5.5" y="13" width="3.2" height="7.5" rx="0.6"/>
<rect x="10.4" y="8.5" width="3.2" height="12" rx="0.6"/>
<rect x="15.3" y="4.5" width="3.2" height="16" rx="0.6"/>`,
  mail: `<rect x="2.75" y="5" width="18.5" height="14" rx="2"/>
<path d="M3.25 6.25l8.75 7 8.75-7"/>`,
  mobile: `<rect x="7" y="2.5" width="10" height="19" rx="2.25"/>
<path d="M10.5 19h3"/>`,
  terminal: `<rect x="2.75" y="4" width="18.5" height="16" rx="2.25"/>
<path d="M6.5 9.5l3.5 3-3.5 3"/>
<path d="M12.5 15.5h5"/>`,
  git: `<circle cx="6" cy="6" r="2"/>
<circle cx="6" cy="18" r="2"/>
<circle cx="18" cy="9" r="2"/>
<path d="M6 8v8"/>
<path d="M6 12c0-3.3 2.7-6 6-6h4"/>`,
  user: `<circle cx="12" cy="7.5" r="3.75"/>
<path d="M4.5 20.5c1.1-4 4-6 7.5-6s6.4 2 7.5 6"/>`,
  webhook: `<path d="M13 2.5L5.5 13.5h5.25L10.5 21.5l8-11.5H13z"/>`,
};

/** SVG `<symbol>` defs for every registered icon — used verbatim in <defs>. */
export function iconSymbolDefs(): string {
  return ICON_IDS.map(
    (id) =>
      `<symbol id="icon-${id}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[id]}</symbol>`,
  ).join("\n");
}

// ---- spec schema (keyoku.dev/arch/v1alpha1) --------------------------------
// A superset of the deck's inline diagram shape: adds `zone` on nodes,
// `style` on edges, and top-level `zones` (optional grouping lanes).

export const ArchNodeSchema = z.object({
  id: z.string().min(1),
  icon: z.enum(ICON_IDS),
  label: z.string().min(1),
  sub: z.string().min(1).optional(),
  zone: z.string().min(1).optional(),
});
export type ArchNode = z.infer<typeof ArchNodeSchema>;

export const ArchEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string().min(1).optional(),
  style: z.enum(["solid", "dashed"]).default("solid"),
});
export type ArchEdge = z.infer<typeof ArchEdgeSchema>;

export const ArchZoneSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});
export type ArchZone = z.infer<typeof ArchZoneSchema>;

export const ArchSpecSchema = z
  .object({
    title: z.string().min(1).optional(),
    nodes: z.array(ArchNodeSchema).min(1),
    edges: z.array(ArchEdgeSchema).default([]),
    zones: z.array(ArchZoneSchema).default([]),
  })
  .superRefine((spec, ctx) => {
    const nodeIds = new Set(spec.nodes.map((n) => n.id));
    const zoneIds = new Set(spec.zones.map((z) => z.id));
    spec.edges.forEach((edge, i) => {
      if (!nodeIds.has(edge.from)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["edges", i, "from"], message: `edges[${i}].from references unknown node id '${edge.from}'` });
      }
      if (!nodeIds.has(edge.to)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["edges", i, "to"], message: `edges[${i}].to references unknown node id '${edge.to}'` });
      }
    });
    spec.nodes.forEach((node, i) => {
      if (node.zone && !zoneIds.has(node.zone)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["nodes", i, "zone"], message: `nodes[${i}].zone references unknown zone id '${node.zone}'` });
      }
    });
  });
export type ArchSpec = z.infer<typeof ArchSpecSchema>;

export interface RenderArchOptions {
  /** true = the caller supplies page-level CSS for the `.arch-svg …`
   * classes (see ARCH_CSS) and the diagram inherits its own design tokens
   * (e.g. `keyoku deck`'s light/dark theme). false/undefined = standalone
   * output embeds its own <style> with fallback colors so the file is
   * legible opened on its own (white background). */
  embedded?: boolean;
  title?: string;
}

// ---- shared CSS — single source of truth for both embed modes -------------
// Every color is `var(--arch-token, var(--token, fallback))`: a page that
// defines --ink/--muted/--surface/--line (e.g. keyoku deck's theme) themes
// the diagram automatically; a bare standalone file falls through to the
// literal fallback and stays legible on white.

export const ARCH_CSS = `.arch-svg{width:100%;height:auto}
.arch-svg .arch-zone-box{fill:var(--arch-zone-bg,rgba(120,120,128,.05));stroke:var(--arch-line,var(--line,#e4e4e2));stroke-dasharray:3 3}
.arch-svg .arch-zone-label{fill:var(--arch-muted,var(--muted,#6b7076));font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase}
.arch-svg .arch-node-box{fill:var(--arch-surface,var(--surface,#ffffff));stroke:var(--arch-line,var(--line,#e4e4e2))}
.arch-svg .arch-node-icon-tile{fill:currentColor;fill-opacity:.08;stroke:currentColor;stroke-opacity:.16}
.arch-svg .arch-node-icon{color:var(--arch-ink,var(--ink,#1a1d20))}
.arch-svg .arch-node-label{fill:var(--arch-ink,var(--ink,#1a1d20));font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:13.5px;font-weight:600}
.arch-svg .arch-node-sub{fill:var(--arch-muted,var(--muted,#6b7076));font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;font-size:10.5px}
.arch-svg .arch-edge-line{fill:none;stroke:var(--arch-muted,var(--muted,#9ba1a6));stroke-width:1.6}
.arch-svg .arch-edge-dashed{stroke-dasharray:5 4}
.arch-svg .arch-edge-arrow{fill:var(--arch-muted,var(--muted,#9ba1a6))}
.arch-svg .arch-edge-label-bg{fill:var(--arch-surface,var(--surface,#ffffff));stroke:var(--arch-line,var(--line,#e4e4e2))}
.arch-svg .arch-edge-label-text{fill:var(--arch-ink,var(--ink,#1a1d20));font-family:ui-monospace,Menlo,monospace;font-size:10px}`;

// ---- layout: longest-path layering (same algorithm the deck used) ---------
// A node's layer is 1 + the max layer of every node with an edge into it (0
// if none). Bounded relaxation passes so a cyclic diagram degrades
// gracefully instead of looping forever. Deterministic: no randomness, and
// iteration order always follows the input node/edge array order.

function layerArchNodes(nodes: ArchNode[], edges: ArchEdge[]): Map<string, number> {
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

// ---- orthogonal edge routing (rounded 6px corners) -------------------------

interface Pt {
  x: number;
  y: number;
}

function distance(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

function pointTowards(from: Pt, to: Pt, dist: number): Pt {
  const len = distance(from, to) || 1;
  const t = Math.min(dist, len) / len;
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

/** Renders a polyline through `pts` as straight segments with each interior
 * corner rounded by a quadratic curve of radius `r` (clamped to half the
 * shorter adjacent segment so short hops never overshoot). */
function roundedPolylinePath(pts: Pt[], r: number): string {
  if (pts.length < 2) return "";
  if (pts.length === 2) return `M${pts[0]!.x},${pts[0]!.y} L${pts[1]!.x},${pts[1]!.y}`;
  let d = `M${pts[0]!.x},${pts[0]!.y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]!;
    const cur = pts[i]!;
    const next = pts[i + 1]!;
    const rr = Math.min(r, distance(prev, cur) / 2, distance(cur, next) / 2);
    const p1 = pointTowards(cur, prev, rr);
    const p2 = pointTowards(cur, next, rr);
    d += ` L${p1.x},${p1.y} Q${cur.x},${cur.y} ${p2.x},${p2.y}`;
  }
  const last = pts[pts.length - 1]!;
  d += ` L${last.x},${last.y}`;
  return d;
}

/** Via-points for an edge between two node positions. `fromCol`/`toCol` are
 * the nodes' column indices (not pixel x) — routing decisions are made on
 * column adjacency, not raw coordinates, so a diagram with uneven column
 * widths still routes correctly:
 *  - same column: straight vertical hop within the column's own x.
 *  - adjacent column (|Δcol| === 1): a direct line, or a two-bend route
 *    through the empty gutter between the two columns when rows differ.
 *  - anywhere else (skips one or more columns, or any backward jump): a
 *    dedicated bus lane OUTSIDE every node's vertical extent (`laneY`, e.g.
 *    the empty top margin) so the line can never cut through an unrelated
 *    node sitting in an intermediate column. */
function edgeViaPoints(
  from: Pt,
  to: Pt,
  fromCol: number,
  toCol: number,
  boxW: number,
  boxH: number,
  colGap: number,
  laneY: number,
  desiredBendSegment?: number,
  forceBusLane = false,
): Pt[] {
  if (fromCol === toCol) {
    const goingDown = to.y > from.y;
    const sx = from.x + boxW / 2;
    const sy = goingDown ? from.y + boxH : from.y;
    const tx = to.x + boxW / 2;
    const ty = goingDown ? to.y : to.y + boxH;
    return [
      { x: sx, y: sy },
      { x: tx, y: ty },
    ];
  }
  const colDelta = toCol - fromCol;
  if (Math.abs(colDelta) === 1 && !forceBusLane) {
    const forward = colDelta === 1;
    const sx = forward ? from.x + boxW : from.x;
    const sy = from.y + boxH / 2;
    const tx = forward ? to.x : to.x + boxW;
    const ty = to.y + boxH / 2;
    if (sy === ty) {
      return [
        { x: sx, y: sy },
        { x: tx, y: ty },
      ];
    }
    // Bias the bend toward whichever segment needs to carry a label: by
    // default split the gutter evenly, but grow the first (source-side)
    // segment up to fit `desiredBendSegment` (a label's pill width) so a
    // long label doesn't bleed back into the source node's own box.
    const available = Math.abs(tx - sx);
    const offset = Math.min(Math.max(desiredBendSegment ?? available / 2, 24), Math.max(available - 16, 24));
    const midX = sx + (forward ? offset : -offset);
    return [
      { x: sx, y: sy },
      { x: midX, y: sy },
      { x: midX, y: ty },
      { x: tx, y: ty },
    ];
  }
  // Bus lane: used for any column skip (forward or backward), so the line
  // never passes through a node in a column between from and to — and also
  // forced for an adjacent-column bend whose label pill can't fit in the
  // gutter, so the label never bleeds into the source node's box.
  const goingForward = colDelta > 0;
  const sx = goingForward ? from.x + boxW : from.x;
  const sy = from.y + boxH / 2;
  const tx = goingForward ? to.x : to.x + boxW;
  const ty = to.y + boxH / 2;
  return [
    { x: sx, y: sy },
    { x: sx, y: laneY },
    { x: tx, y: laneY },
    { x: tx, y: ty },
  ];
}

// ---- render -----------------------------------------------------------

function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pillWidth(label: string): number {
  return label.length * 5.6 + 14;
}

/** Places the label pill at the midpoint of the path's LONGEST segment — the
 * segment most likely to have room for it — rather than always the
 * geometric middle via-point, so a long label on a route with one short
 * bend (e.g. a tight adjacent-column jog) still prefers open space. */
function renderEdgeLabel(label: string, pts: Pt[]): string {
  // The pill is wide and horizontal, so a vertical segment's *length* isn't
  // useful room for it — prefer the longest HORIZONTAL segment; only fall
  // back to a vertical one if the route has no horizontal segment at all
  // (e.g. a pure same-column vertical hop).
  const segments: Array<{ from: Pt; to: Pt; len: number; horizontal: boolean }> = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const from = pts[i]!;
    const to = pts[i + 1]!;
    segments.push({ from, to, len: distance(from, to), horizontal: from.y === to.y });
  }
  const horizontals = segments.filter((s) => s.horizontal);
  const pool = horizontals.length > 0 ? horizontals : segments;
  const best = pool.reduce((a, b) => (b.len > a.len ? b : a));
  const mid = { x: (best.from.x + best.to.x) / 2, y: (best.from.y + best.to.y) / 2 };
  const w = pillWidth(label);
  const h = 17;
  return `<g class="arch-edge-label"><rect class="arch-edge-label-bg" x="${mid.x - w / 2}" y="${mid.y - h / 2}" width="${w}" height="${h}" rx="5"/><text class="arch-edge-label-text" x="${mid.x}" y="${mid.y + 3.5}" text-anchor="middle">${esc(label)}</text></g>`;
}

/**
 * Pure, deterministic renderer: the same spec always produces byte-identical
 * SVG. Consistent node size, generous column/row gaps, vertically centered
 * layers, orthogonal rounded edges, dashed-style support, zones rendered
 * behind nodes as quiet containers.
 */
export function renderArchSvg(spec: ArchSpec, opts: RenderArchOptions = {}): string {
  const nodes = spec.nodes;
  const edges = spec.edges ?? [];
  const zones = spec.zones ?? [];
  const title = opts.title ?? spec.title ?? "Architecture";

  const boxW = 224;
  const boxH = 92;
  const colGap = 140;
  const rowGap = 36;
  const margin = 72;
  const iconTile = 40;
  const iconSize = 22;
  const cornerRadius = 12;
  const edgeRadius = 6;

  const layer = layerArchNodes(nodes, edges);
  const uniqueLayers = [...new Set(nodes.map((n) => layer.get(n.id) ?? 0))].sort((a, b) => a - b);
  const colOf = new Map(uniqueLayers.map((l, i) => [l, i]));
  const columns: ArchNode[][] = uniqueLayers.map(() => []);
  for (const n of nodes) columns[colOf.get(layer.get(n.id) ?? 0)!]!.push(n);

  const numCols = columns.length;
  const maxRows = Math.max(...columns.map((c) => c.length), 1);
  const width = margin * 2 + numCols * boxW + Math.max(numCols - 1, 0) * colGap;
  const height = margin * 2 + maxRows * boxH + Math.max(maxRows - 1, 0) * rowGap;

  const pos = new Map<string, Pt>();
  const nodeCol = new Map<string, number>();
  columns.forEach((col, ci) => {
    const colHeight = col.length * boxH + Math.max(col.length - 1, 0) * rowGap;
    const startY = margin + (height - margin * 2 - colHeight) / 2;
    col.forEach((n, ri) => {
      pos.set(n.id, { x: margin + ci * (boxW + colGap), y: startY + ri * (boxH + rowGap) });
      nodeCol.set(n.id, ci);
    });
  });
  // A dedicated bus lane, safely above every node's vertical extent (nodes
  // never start above `margin`), used only by edges that skip a column.
  const busLaneY = margin / 2;

  const zonesSvg = zones
    .map((z) => {
      const members = nodes
        .filter((n) => n.zone === z.id)
        .map((n) => pos.get(n.id))
        .filter((p): p is Pt => !!p);
      if (members.length === 0) return "";
      const pad = 22;
      const labelH = 24;
      const minX = Math.min(...members.map((p) => p.x)) - pad;
      const minY = Math.min(...members.map((p) => p.y)) - pad - labelH;
      const maxX = Math.max(...members.map((p) => p.x + boxW)) + pad;
      const maxY = Math.max(...members.map((p) => p.y + boxH)) + pad;
      return `<g class="arch-zone" data-id="${esc(z.id)}"><rect class="arch-zone-box" x="${minX}" y="${minY}" width="${maxX - minX}" height="${maxY - minY}" rx="16"/><text class="arch-zone-label" x="${minX + 14}" y="${minY + 17}">${esc(z.label)}</text></g>`;
    })
    .join("\n");

  let busLaneCount = 0;
  const edgesSvg = edges
    .map((e) => {
      const from = pos.get(e.from);
      const to = pos.get(e.to);
      if (!from || !to) return ""; // defensive: never fail a build over a typo'd edge id
      const fromCol = nodeCol.get(e.from) ?? 0;
      const toCol = nodeCol.get(e.to) ?? 0;
      // Stagger successive bus-lane edges by a few px so two column-skipping
      // edges never trace the exact same horizontal line.
      const colDelta = toCol - fromCol;
      const columnSkip = fromCol !== toCol && Math.abs(colDelta) !== 1;
      // A labeled adjacent-column bend needs its source-side segment to be at
      // least as long as the label's pill, or the pill bleeds back into the
      // source node's own box. If even the whole gutter can't fit it, fall
      // back to the bus lane instead of letting it overlap a node.
      const desiredBendSegment = e.label ? pillWidth(e.label) + 16 : undefined;
      const bentAdjacent = Math.abs(colDelta) === 1 && from.y !== to.y;
      const forceBusLane = bentAdjacent && !!desiredBendSegment && desiredBendSegment > colGap - 16;
      const isBusEdge = columnSkip || forceBusLane;
      const laneY = isBusEdge ? busLaneY - (busLaneCount++ % 3) * 9 : busLaneY;
      const pts = edgeViaPoints(from, to, fromCol, toCol, boxW, boxH, colGap, laneY, desiredBendSegment, forceBusLane);
      const d = roundedPolylinePath(pts, edgeRadius);
      const dashClass = e.style === "dashed" ? " arch-edge-dashed" : "";
      const labelSvg = e.label ? renderEdgeLabel(e.label, pts) : "";
      return `<path class="arch-edge-line${dashClass}" d="${d}" marker-end="url(#arch-arrow-head)"/>${labelSvg}`;
    })
    .join("\n");

  const nodesSvg = nodes
    .map((n) => {
      const p = pos.get(n.id);
      if (!p) return "";
      const iconId = (ICON_IDS as readonly string[]).includes(n.icon) ? n.icon : "doc";
      const tileX = p.x + 14;
      const tileY = p.y + (boxH - iconTile) / 2;
      const iconX = tileX + (iconTile - iconSize) / 2;
      const iconY = tileY + (iconTile - iconSize) / 2;
      const textX = tileX + iconTile + 14;
      const labelY = n.sub ? p.y + boxH / 2 - 6 : p.y + boxH / 2 + 5;
      const subY = labelY + 18;
      return `<g class="arch-node" data-id="${esc(n.id)}">
  <rect class="arch-node-box" x="${p.x}" y="${p.y}" width="${boxW}" height="${boxH}" rx="${cornerRadius}"/>
  <rect class="arch-node-icon-tile" x="${tileX}" y="${tileY}" width="${iconTile}" height="${iconTile}" rx="10"/>
  <use class="arch-node-icon" href="#icon-${iconId}" x="${iconX}" y="${iconY}" width="${iconSize}" height="${iconSize}"/>
  <text class="arch-node-label" x="${textX}" y="${labelY}">${esc(n.label)}</text>
  ${n.sub ? `<text class="arch-node-sub" x="${textX}" y="${subY}">${esc(n.sub)}</text>` : ""}
</g>`;
    })
    .join("\n");

  const styleBlock = opts.embedded ? "" : `<style>${ARCH_CSS}</style>`;

  return `<svg class="arch-svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(title)} architecture diagram">
<title>${esc(title)}</title>
${styleBlock}
<defs>${iconSymbolDefs()}
<marker id="arch-arrow-head" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="arch-edge-arrow" d="M0,0 L10,5 L0,10 z"/></marker>
</defs>
<g class="arch-zones">${zonesSvg}</g>
<g class="arch-edges">${edgesSvg}</g>
<g class="arch-nodes">${nodesSvg}</g>
</svg>`;
}

// ---- CLI: keyoku arch render <spec.yaml> [-o out.svg] ----------------------

function flagValue(argv: string[], flags: string[]): string | undefined {
  for (const flag of flags) {
    const index = argv.indexOf(flag);
    if (index >= 0 && argv[index + 1] && !argv[index + 1]!.startsWith("-")) return argv[index + 1];
  }
  return undefined;
}

async function archRender(rest: string[]): Promise<void> {
  const specArg = rest.find((a) => !a.startsWith("-") && a !== flagValue(rest, ["-o", "--out"]));
  if (!specArg) throw new Error("Usage: keyoku arch render <spec.yaml> [-o <out.svg>]");
  const root = resolve(process.cwd());
  const specPath = isAbsolute(specArg) ? specArg : join(root, specArg);
  if (!existsSync(specPath)) throw new Error(`Spec file not found: ${specPath}`);

  let raw: unknown;
  try {
    raw = parse(readFileSync(specPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot parse ${specPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = ArchSpecSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `Invalid ${specPath}: ${result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")}`,
    );
  }

  const svg = renderArchSvg(result.data, { embedded: false });
  const outArg = flagValue(rest, ["-o", "--out"]);
  const outPath = outArg ? (isAbsolute(outArg) ? outArg : join(root, outArg)) : join(root, "architecture.svg");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, svg, "utf8");
  console.log(
    `Rendered architecture diagram (${result.data.nodes.length} node(s), ${result.data.edges.length} edge(s)) -> ${relative(root, outPath) || outPath}`,
  );
}

export async function archCmd(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (sub === "render") return archRender(rest);
  throw new Error("Usage: keyoku arch render <spec.yaml> [-o <out.svg>]");
}
