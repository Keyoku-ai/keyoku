import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { Dirent } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { Autonomy, ConnectorTransport } from "./types.js";

export interface ConnectorPreset {
  description: string;
  autonomy: Autonomy;
  buildTransport(): ConnectorTransport;
}

const DEFAULT_OMNIGENT_SERVER_URL = "http://127.0.0.1:6767";

function cleanBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

function fileMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function jsonFilesUnder(root: string): string[] {
  const files: string[] = [];
  if (!existsSync(root)) return files;

  const visit = (dir: string) => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(path);
    }
  };

  visit(root);
  return files.sort((a, b) => fileMtimeMs(b) - fileMtimeMs(a) || a.localeCompare(b));
}

function readResolvedServerUrl(path: string): string | undefined {
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { resolved_server_url?: unknown };
    return typeof value.resolved_server_url === "string" && value.resolved_server_url.trim()
      ? value.resolved_server_url.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function resolveOmnigentServerUrl(): string {
  const envUrl = process.env.OMNIGENT_SERVER_URL?.trim();
  if (envUrl) return cleanBaseUrl(envUrl);

  const daemonDir = join(homedir(), ".omnigent", "daemons");
  for (const file of jsonFilesUnder(daemonDir)) {
    const resolved = readResolvedServerUrl(file);
    if (resolved) return cleanBaseUrl(resolved);
  }

  return DEFAULT_OMNIGENT_SERVER_URL;
}

export const CONNECTOR_PRESETS: Record<string, ConnectorPreset> = {
  omnigent: {
    description: "Connect to the local Omnigent FastAPI server via its OpenAPI schema.",
    autonomy: "approve",
    buildTransport(): ConnectorTransport {
      const baseUrl = resolveOmnigentServerUrl();
      return {
        type: "openapi",
        specUrl: `${baseUrl}/openapi.json`,
        baseUrl,
        allowMutating: true,
        auth: { kind: "none" },
      };
    },
  },
};
