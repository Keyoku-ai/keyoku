import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";

import { parse } from "yaml";

export type ArchitectureLayer = "source" | "experience" | "control" | "intelligence" | "execution" | "proof" | "state";

export interface ArchitectureComponent {
  id: string;
  label: string;
  summary: string;
  layer: ArchitectureLayer;
  icon: string;
  owns?: string[];
  external?: boolean;
  view?: { x: number; y: number };
}

export interface ArchitectureRelation {
  from: string;
  to: string;
  kind: string;
}

export interface ArchitectureProjection {
  schemaVersion: "keyoku.dev/architecture-projection/v1alpha1";
  projectId: string;
  title: string;
  generatedAt: string;
  snapshotRef: string;
  source: { kind: "declared+observed"; path: string };
  components: Array<ArchitectureComponent & {
    observedFiles: number;
    changedFiles: string[];
    state: "external" | "stable" | "changing" | "missing";
  }>;
  relations: ArchitectureRelation[];
  unownedChanges: string[];
}

export interface ArchitectureProposal {
  schemaVersion: "keyoku.dev/architecture-proposal/v1alpha1";
  id: string;
  baseSnapshotRef: string;
  summary: string;
  rationale: string;
  operations: Array<{ op: "add" | "update" | "remove"; target: string; value?: unknown }>;
  actor: { id: string; name: string; harness?: string; model?: string };
  confidence: number;
  createdAt: string;
  status: "proposed";
}

interface ArchitectureDocument {
  projectId: string;
  title: string;
  components: ArchitectureComponent[];
  relations: ArchitectureRelation[];
}

function git(root: string, args: string[], fallback = "unknown"): string {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || fallback;
  } catch {
    return fallback;
  }
}

function filesUnder(root: string, entry: string): string[] {
  const absolute = join(root, entry);
  if (!existsSync(absolute)) return [];
  if (!statSync(absolute).isDirectory()) return [entry];
  const files: string[] = [];
  const visit = (directory: string) => {
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      if (["node_modules", ".git", "dist"].includes(child.name)) continue;
      const path = join(directory, child.name);
      if (child.isDirectory()) visit(path);
      else files.push(relative(root, path));
    }
  };
  visit(absolute);
  return files;
}

export function scanArchitecture(root: string): ArchitectureProjection {
  const architecturePath = join(root, ".keyoku", "architecture.yaml");
  if (!existsSync(architecturePath)) throw new Error("No .keyoku/architecture.yaml architecture contract exists.");
  const document = parse(readFileSync(architecturePath, "utf8")) as ArchitectureDocument;
  const status = git(root, ["status", "--porcelain=v1"], "");
  const changed = status ? status.split("\n").filter(Boolean).map((line) => line.slice(3)) : [];
  const owned = new Set<string>();
  const components = document.components.map((component) => {
    const files = (component.owns || []).flatMap((entry) => filesUnder(root, entry));
    files.forEach((file) => owned.add(file));
    const changedFiles = changed.filter((file) => files.includes(file) || (component.owns || []).some((entry) => file === entry || file.startsWith(`${entry}/`)));
    return {
      ...component,
      observedFiles: files.length,
      changedFiles,
      state: component.external ? "external" as const : files.length === 0 ? "missing" as const : changedFiles.length ? "changing" as const : "stable" as const,
    };
  });
  const snapshotInput = JSON.stringify({ head: git(root, ["rev-parse", "HEAD"]), status, document });
  return {
    schemaVersion: "keyoku.dev/architecture-projection/v1alpha1",
    projectId: document.projectId,
    title: document.title,
    generatedAt: new Date().toISOString(),
    snapshotRef: createHash("sha256").update(snapshotInput).digest("hex").slice(0, 16),
    source: { kind: "declared+observed", path: ".keyoku/architecture.yaml" },
    components,
    relations: document.relations,
    unownedChanges: changed.filter((file) => !owned.has(file) && ![...owned].some((entry) => file.startsWith(`${entry}/`))),
  };
}

function xml(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

export function renderArchitectureSvg(projection: ArchitectureProjection): string {
  const width = 1200;
  const height = 680;
  const nodeWidth = 190;
  const nodeHeight = 112;
  const nodes = new Map(projection.components.map((component) => [component.id, component]));
  const edge = (relation: ArchitectureRelation, index: number) => {
    const from = nodes.get(relation.from); const to = nodes.get(relation.to);
    if (!from?.view || !to?.view) return "";
    const x1 = from.view.x + nodeWidth; const y1 = from.view.y + nodeHeight / 2;
    const x2 = to.view.x; const y2 = to.view.y + nodeHeight / 2;
    const lift = 20 + (index % 4) * 10;
    const direction = x2 >= x1 ? 1 : -1;
    const c1 = x1 + direction * Math.max(45, Math.abs(x2 - x1) * .38);
    const c2 = x2 - direction * Math.max(45, Math.abs(x2 - x1) * .38);
    return `<path d="M ${x1} ${y1} C ${c1} ${y1 - lift}, ${c2} ${y2 + lift}, ${x2} ${y2}" fill="none" stroke="url(#edgeGradient)" stroke-opacity=".56" stroke-width="1.5" marker-end="url(#arrow)"/>`;
  };
  const node = (component: ArchitectureProjection["components"][number]) => {
    if (!component.view) return "";
    const state = component.state === "changing" ? "#06b6d4" : component.state === "missing" ? "#ef4444" : component.state === "external" ? "#8b5cf6" : "#6366f1";
    const mark = component.icon === "database" ? "DB" : component.icon === "keyoku" ? "K" : component.icon === "git" ? "GIT" : component.icon === "mcp" ? "MCP" : component.icon === "agent" ? "AI" : component.icon.slice(0, 2).toUpperCase();
    const detail = component.external ? "external boundary" : `${component.observedFiles} files${component.changedFiles.length ? ` · ${component.changedFiles.length} changing` : ""}`;
    return `<g data-component="${xml(component.id)}"><rect x="${component.view.x}" y="${component.view.y}" width="${nodeWidth}" height="${nodeHeight}" rx="13" fill="#18181b" stroke="${state}" stroke-opacity=".78"/><rect x="${component.view.x + 14}" y="${component.view.y + 15}" width="38" height="30" rx="8" fill="${state}" fill-opacity=".16"/><text x="${component.view.x + 33}" y="${component.view.y + 35}" text-anchor="middle" fill="${state}" font-size="10" font-weight="700">${xml(mark)}</text><text x="${component.view.x + 14}" y="${component.view.y + 65}" fill="#fafafa" font-size="14" font-weight="650">${xml(component.label)}</text><text x="${component.view.x + 14}" y="${component.view.y + 86}" fill="#a1a1aa" font-size="10">${xml(detail)}</text><text x="${component.view.x + 14}" y="${component.view.y + 101}" fill="#71717a" font-size="9">${xml(component.layer)}</text></g>`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc"><title id="title">${xml(projection.title)}</title><desc id="desc">Architecture projection for ${xml(projection.projectId)} at snapshot ${xml(projection.snapshotRef)}.</desc><defs><linearGradient id="edgeGradient" x1="0" x2="1"><stop stop-color="#6366f1"/><stop offset=".5" stop-color="#8b5cf6"/><stop offset="1" stop-color="#06b6d4"/></linearGradient><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#8b5cf6" fill-opacity=".78"/></marker><pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse"><path d="M 40 0 L 0 0 0 40" fill="none" stroke="#6366f1" stroke-opacity=".06"/></pattern></defs><rect width="1200" height="680" fill="#0c0c10"/><rect width="1200" height="680" fill="url(#grid)"/><text x="42" y="42" fill="#fafafa" font-family="system-ui,sans-serif" font-size="22" font-weight="650">${xml(projection.title)}</text><text x="42" y="62" fill="#71717a" font-family="ui-monospace,monospace" font-size="10">snapshot ${xml(projection.snapshotRef)} · ${xml(projection.source.kind)}</text><g font-family="system-ui,sans-serif">${projection.relations.map(edge).join("")}${projection.components.map(node).join("")}</g><text x="42" y="650" fill="#71717a" font-family="ui-monospace,monospace" font-size="9">Observed files + declared semantic structure · generated ${xml(projection.generatedAt)}</text></svg>`;
}

export function proposeArchitectureChange(input: {
  root: string;
  summary: string;
  rationale: string;
  operations: ArchitectureProposal["operations"];
  actor: ArchitectureProposal["actor"];
  confidence: number;
}): ArchitectureProposal {
  const projection = scanArchitecture(input.root);
  const proposal: ArchitectureProposal = {
    schemaVersion: "keyoku.dev/architecture-proposal/v1alpha1",
    id: `arch_${Date.now().toString(36)}_${createHash("sha256").update(`${input.actor.id}:${input.summary}:${Date.now()}`).digest("hex").slice(0, 10)}`,
    baseSnapshotRef: projection.snapshotRef,
    summary: input.summary.trim(),
    rationale: input.rationale.trim(),
    operations: input.operations,
    actor: input.actor,
    confidence: Math.max(0, Math.min(input.confidence, 1)),
    createdAt: new Date().toISOString(),
    status: "proposed",
  };
  if (!proposal.summary || !proposal.rationale || proposal.operations.length === 0) throw new Error("summary, rationale, and at least one operation are required");
  const path = join(input.root, ".keyoku", "runtime", "architecture-proposals.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(proposal)}\n`, { encoding: "utf8", mode: 0o600 });
  return proposal;
}
