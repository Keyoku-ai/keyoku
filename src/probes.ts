import { exec } from "node:child_process";

import type { ConnectorManager } from "./connectors.js";
import type { ParseMode, Probe, ProbeEnvelope } from "./types.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const STDERR_CAP = 4_000;

interface Parsed {
  value: unknown;
  parseError?: string;
}

export function parseOutput(text: string, mode: ParseMode = "auto"): Parsed {
  const trimmed = text.trim();
  switch (mode) {
    case "text":
      return { value: trimmed };
    case "number": {
      // Number("") === 0 — an empty output must NOT pass numeric assertions.
      const n = trimmed === "" ? NaN : Number(trimmed);
      return Number.isFinite(n)
        ? { value: n }
        : { value: trimmed, parseError: `not a number: ${JSON.stringify(cap(trimmed, 80))}` };
    }
    case "json":
      try {
        return { value: JSON.parse(trimmed) };
      } catch (err) {
        return {
          value: trimmed,
          parseError: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    case "auto":
    default:
      try {
        return { value: JSON.parse(trimmed) };
      } catch {
        return { value: trimmed };
      }
  }
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function runCommand(
  probe: Extract<Probe, { kind: "command" }>,
): Promise<ProbeEnvelope> {
  const timeout = probe.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    exec(
      probe.run,
      {
        cwd: probe.cwd,
        timeout,
        // SIGKILL cannot be trapped — a misbehaving command must not be able
        // to hang goal_assess past its timeout.
        killSignal: "SIGKILL",
        maxBuffer: MAX_OUTPUT_BYTES,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        const parsed = parseOutput(stdout ?? "", probe.parse);
        const envelope: ProbeEnvelope = {
          output: parsed.value,
          stderr: cap(stderr ?? "", STDERR_CAP),
        };
        if (err) {
          if (err.message?.includes("maxBuffer")) {
            envelope.exitCode = -1;
            envelope.error = `command output exceeded ${MAX_OUTPUT_BYTES} bytes`;
          } else if (err.killed) {
            envelope.exitCode = -1;
            envelope.error = `command timed out after ${timeout}ms`;
          } else if (err.signal) {
            envelope.exitCode = -1;
            envelope.error = `command terminated by signal ${err.signal}`;
          } else {
            envelope.exitCode = typeof err.code === "number" ? err.code : 1;
            envelope.error = `command exited with code ${envelope.exitCode}`;
          }
        } else {
          envelope.exitCode = 0;
        }
        if (parsed.parseError) {
          envelope.error = envelope.error
            ? `${envelope.error}; ${parsed.parseError}`
            : parsed.parseError;
        }
        resolve(envelope);
      },
    );
  });
}

async function runHttp(
  probe: Extract<Probe, { kind: "http" }>,
): Promise<ProbeEnvelope> {
  const timeout = probe.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(probe.url, {
      method: probe.method ?? "GET",
      headers: probe.headers,
      body: probe.body,
      signal: controller.signal,
    });
    const text = await res.text();
    const parsed = parseOutput(text, probe.parse);
    return {
      output: parsed.value,
      status: res.status,
      ...(parsed.parseError ? { error: parsed.parseError } : {}),
    };
  } catch (err) {
    const aborted = err instanceof Error && err.name === "AbortError";
    // undici hides the actionable reason (ECONNREFUSED, ENOTFOUND, TLS...)
    // in err.cause behind a generic "fetch failed".
    const cause =
      err instanceof Error && err.cause ? ` (${String(err.cause)})` : "";
    return {
      output: null,
      error: aborted
        ? `request timed out after ${timeout}ms`
        : `request failed: ${err instanceof Error ? err.message : String(err)}${cause}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function runMcp(
  probe: Extract<Probe, { kind: "mcp" }>,
  connectors: ConnectorManager,
): Promise<ProbeEnvelope> {
  try {
    const result = await connectors.callTool(
      probe.connector,
      probe.tool,
      probe.args ?? {},
    );
    const parsed = parseOutput(result.text, probe.parse);
    const envelope: ProbeEnvelope = { output: parsed.value };
    if (result.isError) {
      envelope.error = `connector tool reported an error`;
    }
    if (parsed.parseError) {
      envelope.error = envelope.error
        ? `${envelope.error}; ${parsed.parseError}`
        : parsed.parseError;
    }
    return envelope;
  } catch (err) {
    return {
      output: null,
      error: `connector '${probe.connector}' call failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Run a probe and return its envelope. Never throws — failures surface in the
 * envelope's `error` field so assertions can still inspect partial output.
 */
export async function runProbe(
  probe: Probe,
  connectors: ConnectorManager,
): Promise<ProbeEnvelope> {
  switch (probe.kind) {
    case "command":
      return runCommand(probe);
    case "http":
      return runHttp(probe);
    case "mcp":
      return runMcp(probe, connectors);
  }
}
