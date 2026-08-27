import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { parse as parseYaml } from "yaml";

export type ViewField = {
  value: string;
  description: string;
  source: "manifest" | "agent";
  updatedAt?: string;
  actor?: { id: string; harness?: string; model?: string };
  confidence?: number;
};

export type ProjectView = {
  schemaVersion: "keyoku.dev/project-view/v1alpha1";
  template: string;
  fields: Record<string, ViewField>;
};

type ViewManifest = {
  schemaVersion?: string;
  template?: string;
  fields?: Record<string, { value?: unknown; description?: unknown }>;
};

type ViewPublication = {
  eventType: "view.fields.published";
  eventId: string;
  fields: Record<string, string>;
  actor: { id: string; harness?: string; model?: string };
  confidence: number;
  reason: string;
  createdAt: string;
};

const FIELD_NAME = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;

function manifestPath(root: string): string {
  return join(root, ".keyoku", "view.yaml");
}

function eventsPath(root: string): string {
  return join(root, ".keyoku", "runtime", "view-events.jsonl");
}

function publications(root: string): ViewPublication[] {
  const path = eventsPath(root);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try {
      const event = JSON.parse(line) as ViewPublication;
      return event.eventType === "view.fields.published" ? [event] : [];
    } catch {
      return [];
    }
  });
}

export function readProjectView(root: string): ProjectView {
  const path = manifestPath(root);
  if (!existsSync(path)) throw new Error("No .keyoku/view.yaml presentation manifest exists");
  const manifest = parseYaml(readFileSync(path, "utf8")) as ViewManifest;
  const fields: Record<string, ViewField> = {};
  for (const [name, field] of Object.entries(manifest.fields ?? {})) {
    if (!FIELD_NAME.test(name) || typeof field.value !== "string") continue;
    fields[name] = {
      value: field.value,
      description: typeof field.description === "string" ? field.description : "Agent-editable presentation field.",
      source: "manifest",
    };
  }
  for (const event of publications(root)) {
    for (const [name, value] of Object.entries(event.fields)) {
      if (!fields[name]) continue;
      fields[name] = { ...fields[name], value, source: "agent", updatedAt: event.createdAt, actor: event.actor, confidence: event.confidence };
    }
  }
  return { schemaVersion: "keyoku.dev/project-view/v1alpha1", template: manifest.template || "convergence-thread", fields };
}

export function publishProjectView(
  root: string,
  input: { fields: Record<string, string>; actor: { id: string; harness?: string; model?: string }; confidence?: number; reason: string },
): ViewPublication {
  const current = readProjectView(root);
  const fields: Record<string, string> = {};
  for (const [name, raw] of Object.entries(input.fields)) {
    if (!FIELD_NAME.test(name) || !current.fields[name]) throw new Error(`Unknown or protected view field '${name}'`);
    const value = raw.trim();
    if (!value) throw new Error(`View field '${name}' cannot be empty`);
    if (value.length > 2_000) throw new Error(`View field '${name}' exceeds 2,000 characters`);
    fields[name] = value;
  }
  if (!Object.keys(fields).length) throw new Error("At least one view field is required");
  const event: ViewPublication = {
    eventType: "view.fields.published",
    eventId: `view_${Date.now().toString(36)}_${randomBytes(5).toString("base64url")}`,
    fields,
    actor: input.actor,
    confidence: Math.max(0, Math.min(1, input.confidence ?? 0.8)),
    reason: input.reason.trim().slice(0, 1_000),
    createdAt: new Date().toISOString(),
  };
  const path = eventsPath(root);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
  return event;
}
