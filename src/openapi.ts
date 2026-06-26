import { readFileSync } from "node:fs";

import YAML from "yaml";

import type { SynthAuth } from "./types.js";

// ---------------------------------------------------------------------------
// M3 — OpenAPI/Swagger specs synthesized into connector tools. parseSpec
// distills a spec into SynthTools; buildRequest/executeSynthTool turn a tool
// call into an HTTP request. Best-effort by design: anything we cannot map
// becomes a warning rather than a hard failure, so a partially odd spec still
// yields a usable connector.
// ---------------------------------------------------------------------------

export interface SynthParam {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  description?: string;
}

export interface SynthTool {
  name: string;
  description: string;
  method: string;
  pathTemplate: string;
  params: SynthParam[];
  hasBody: boolean;
  mutating: boolean;
}

export interface SynthSpec {
  title: string;
  baseUrl?: string;
  tools: SynthTool[];
  warnings: string[];
}

const FETCH_TIMEOUT_MS = 30_000;
const NAME_CAP = 128;
const BODY_CAP = 2_000;
const METHODS = ["get", "put", "post", "delete", "patch", "head"] as const;

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Fetch a spec by http(s) URL (30s timeout, non-2xx throws) or read it from a
 * local file path. Returns the raw text for parseSpec.
 */
export async function loadSpec(specUrl: string): Promise<string> {
  if (/^https?:\/\//i.test(specUrl)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(specUrl, { signal: controller.signal });
      if (!res.ok) {
        throw new Error(`failed to fetch spec from ${specUrl}: HTTP ${res.status}`);
      }
      return await res.text();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`fetching spec from ${specUrl} timed out after ${FETCH_TIMEOUT_MS}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  return readFileSync(specUrl, "utf8");
}

function parseDocument(raw: string): Dict {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    try {
      doc = YAML.parse(raw);
    } catch (err) {
      throw new Error(
        `spec is neither valid JSON nor valid YAML: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (!isDict(doc)) {
    throw new Error("spec did not parse to an object; expected an OpenAPI 3.x or Swagger 2 document");
  }
  return doc;
}

/** Resolve a local parameter $ref one level; undefined when unresolvable. */
function resolveParamRef(ref: string, doc: Dict): Dict | undefined {
  let target: unknown;
  const v3 = /^#\/components\/parameters\/([^/]+)$/.exec(ref);
  const v2 = /^#\/parameters\/([^/]+)$/.exec(ref);
  if (v3) {
    const components = isDict(doc.components) ? doc.components : {};
    const parameters = isDict(components.parameters) ? components.parameters : {};
    target = parameters[v3[1]];
  } else if (v2) {
    const parameters = isDict(doc.parameters) ? doc.parameters : {};
    target = parameters[v2[1]];
  }
  // One level only: a ref that resolves to another ref stays unresolved.
  if (!isDict(target) || typeof target.$ref === "string") return undefined;
  return target;
}

function sanitizeName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, NAME_CAP);
}

function fallbackName(method: string, pathKey: string): string {
  const slug =
    pathKey
      .replace(/[{}]/g, "")
      .split("/")
      .filter(Boolean)
      .map((seg) => seg.replace(/[^A-Za-z0-9_-]/g, "_"))
      .join("_") || "root";
  return `${method}_${slug}`.slice(0, NAME_CAP);
}

function dedupeName(base: string, used: Set<string>): string {
  let name = base;
  // Reserve room for the suffix so the deduped name still honors NAME_CAP.
  for (let i = 2; used.has(name); i++) {
    const suffix = `_${i}`;
    name = `${base.slice(0, NAME_CAP - suffix.length)}${suffix}`;
  }
  used.add(name);
  return name;
}

/**
 * Parse a raw OpenAPI 3.x / Swagger 2 spec (JSON or YAML) into synthesized
 * tools. Throws on documents that are unparseable, unrecognizable, or contain
 * no usable operations; everything mappable but odd lands in `warnings`.
 */
export function parseSpec(raw: string): SynthSpec {
  const doc = parseDocument(raw);
  const warnings: string[] = [];

  const isV3 = asString(doc.openapi)?.startsWith("3") ?? false;
  const isV2 = !isV3 && (asString(doc.swagger)?.startsWith("2") ?? false);
  if (!isV3 && !isV2) {
    throw new Error(
      "unrecognized spec: expected an OpenAPI document with an 'openapi: 3.x' or 'swagger: 2.x' field",
    );
  }

  const info = isDict(doc.info) ? doc.info : {};
  const title = asString(info.title) ?? "Untitled API";

  let baseUrl: string | undefined;
  if (isV3) {
    const servers = Array.isArray(doc.servers) ? doc.servers : [];
    const first = isDict(servers[0]) ? servers[0] : undefined;
    baseUrl = first ? asString(first.url) : undefined;
    if (!baseUrl) {
      warnings.push("spec declares no servers; provide a baseUrl when adding the connector");
    }
  } else {
    const host = asString(doc.host);
    if (host) {
      const schemes = Array.isArray(doc.schemes) ? doc.schemes : [];
      const scheme = asString(schemes[0]) ?? "https";
      baseUrl = `${scheme}://${host}${asString(doc.basePath) ?? ""}`;
    } else {
      warnings.push("spec declares no host; provide a baseUrl when adding the connector");
    }
  }

  const paths = isDict(doc.paths) ? doc.paths : {};
  const tools: SynthTool[] = [];
  const usedNames = new Set<string>();

  for (const [pathKey, pathValue] of Object.entries(paths)) {
    if (pathKey.startsWith("x-") || !isDict(pathValue)) continue;
    const pathLevelParams = Array.isArray(pathValue.parameters) ? pathValue.parameters : [];

    for (const method of METHODS) {
      const op = pathValue[method];
      if (!isDict(op)) continue;
      const upper = method.toUpperCase();

      const opId = asString(op.operationId);
      const name = dedupeName(
        opId ? sanitizeName(opId) : fallbackName(method, pathKey),
        usedNames,
      );

      const summary = asString(op.summary) ?? asString(op.description);
      const description = summary ? `${summary} (${upper} ${pathKey})` : `${upper} ${pathKey}`;

      // Operation-level params first: they override path-item-level ones with
      // the same name+location, and first-wins dedupe below preserves that.
      const rawParams = [
        ...(Array.isArray(op.parameters) ? op.parameters : []),
        ...pathLevelParams,
      ];
      const params: SynthParam[] = [];
      const seen = new Set<string>();
      let hasBody = isV3 && isDict(op.requestBody);

      for (const rawParam of rawParams) {
        if (!isDict(rawParam)) continue;
        let p = rawParam;
        const ref = asString(p.$ref);
        if (ref) {
          const resolved = resolveParamRef(ref, doc);
          if (!resolved) {
            warnings.push(`${name}: could not resolve parameter $ref '${ref}'; skipped`);
            continue;
          }
          p = resolved;
        }
        const pName = asString(p.name);
        const pIn = asString(p.in);
        if (!pName || !pIn) continue;
        if (pIn === "body") {
          hasBody = true;
          continue;
        }
        if (pIn === "cookie") {
          warnings.push(`${name}: cookie parameter '${pName}' is not supported; skipped`);
          continue;
        }
        if (pIn !== "path" && pIn !== "query" && pIn !== "header") {
          warnings.push(`${name}: unsupported parameter location '${pIn}' for '${pName}'; skipped`);
          continue;
        }
        const key = `${pIn}:${pName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const pDescription = asString(p.description);
        params.push({
          name: pName,
          in: pIn,
          // Path params are required by definition even when a sloppy spec
          // omits the flag.
          required: pIn === "path" ? true : Boolean(p.required),
          ...(pDescription ? { description: pDescription } : {}),
        });
      }

      tools.push({
        name,
        description,
        method,
        pathTemplate: pathKey,
        params,
        hasBody,
        mutating: method !== "get" && method !== "head",
      });
    }
  }

  if (tools.length === 0) {
    throw new Error(
      `spec '${title}' contains no usable operations (no paths with get/put/post/delete/patch/head)`,
    );
  }

  return { title, baseUrl, tools, warnings };
}

/**
 * Materialize one tool call into a concrete HTTP request. Throws when a
 * required argument is missing — callers surface that to the agent verbatim.
 */
export function buildRequest(
  tool: SynthTool,
  args: Record<string, unknown>,
  baseUrl: string,
  auth?: SynthAuth,
): { url: string; method: string; headers: Record<string, string>; body?: string } {
  const headers: Record<string, string> = {};
  const search = new URLSearchParams();
  let path = tool.pathTemplate;

  for (const param of tool.params) {
    const value = args[param.name];
    // Treat null like undefined: a null path/query value must not become the
    // literal string "null" in the URL.
    if (value === undefined || value === null) {
      if (param.required) {
        throw new Error(`missing required ${param.in} parameter '${param.name}'`);
      }
      continue;
    }
    switch (param.in) {
      case "path":
        path = path.split(`{${param.name}}`).join(encodeURIComponent(String(value)));
        break;
      case "query":
        search.append(param.name, String(value));
        break;
      case "header":
        headers[param.name] = String(value);
        break;
    }
  }

  // Prefer the spec's requestBody declaration, but tolerate sloppy specs for
  // mutating endpoints that omit it even though the server requires JSON.
  // Read-only operations still ignore undeclared args.body so a query/header
  // parameter literally named "body" is not sent twice.
  let body: string | undefined;
  if ((tool.hasBody || tool.mutating) && args.body !== undefined && args.body !== null) {
    if (typeof args.body === "string") {
      body = args.body;
    } else {
      body = JSON.stringify(args.body);
      headers["content-type"] = "application/json";
    }
  }

  if (auth) {
    switch (auth.kind) {
      case "bearer":
        headers["Authorization"] = `Bearer ${auth.token}`;
        break;
      case "header":
        headers[auth.name] = auth.value;
        break;
      case "query":
        // Auth wins over any caller-supplied query param of the same name —
        // drop the caller's value rather than appending a duplicate.
        search.delete(auth.name);
        search.append(auth.name, auth.value);
        break;
      case "none":
        break;
    }
  }

  const base = baseUrl.replace(/\/+$/, "");
  const rel = path.startsWith("/") ? path : `/${path}`;
  const qs = search.toString();
  return {
    url: `${base}${rel}${qs ? `?${qs}` : ""}`,
    method: tool.method.toUpperCase(),
    headers,
    ...(body !== undefined ? { body } : {}),
  };
}

/**
 * Build and execute a synthesized tool call. HTTP and network failures come
 * back as `isError` results; missing-argument errors from buildRequest
 * propagate so the caller can format them.
 */
export async function executeSynthTool(
  tool: SynthTool,
  args: Record<string, unknown>,
  baseUrl: string,
  auth?: SynthAuth,
  timeoutMs = 30_000,
): Promise<{ text: string; isError: boolean }> {
  const request = buildRequest(tool, args, baseUrl, auth);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return { text: `HTTP ${res.status}: ${cap(text, BODY_CAP)}`, isError: true };
    }
    try {
      return { text: JSON.stringify(JSON.parse(text), null, 2), isError: false };
    } catch {
      return { text, isError: false };
    }
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { text: `request timed out after ${timeoutMs}ms`, isError: true };
    }
    // undici hides the actionable reason (ECONNREFUSED, ENOTFOUND, TLS...)
    // in err.cause behind a generic "fetch failed".
    const cause = err instanceof Error && err.cause ? ` (${String(err.cause)})` : "";
    return {
      text: `${err instanceof Error ? err.message : String(err)}${cause}`,
      isError: true,
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Compact tool listing for connector_describe / approval prompts. */
export function describeTool(tool: SynthTool): { name: string; description: string } {
  const route = `${tool.method.toUpperCase()} ${tool.pathTemplate}`;
  const parts = [tool.description.includes(route) ? tool.description : `${route} — ${tool.description}`];
  if (tool.params.length > 0) {
    parts.push(`params: ${tool.params.map((p) => (p.required ? p.name : `${p.name}?`)).join(", ")}`);
  }
  if (tool.hasBody || tool.mutating) parts.push("accepts a request body via 'body'");
  if (tool.mutating) parts.push("(mutating)");
  return { name: tool.name, description: parts.join(" | ") };
}
