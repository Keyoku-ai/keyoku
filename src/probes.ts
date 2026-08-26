import { spawn } from "node:child_process";

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
    const detached = process.platform !== "win32";
    const child = spawn(probe.run, {
      cwd: probe.cwd,
      shell: true,
      detached,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let forced: "timeout" | "maxBuffer" | undefined;
    let spawnError: Error | undefined;
    const killTree = (): void => {
      if (!child.pid) return;
      try {
        if (detached) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        try { child.kill("SIGKILL"); } catch { /* already gone */ }
      }
    };
    const timer = setTimeout(() => {
      forced = "timeout";
      killTree();
    }, timeout);
    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) stdout.push(chunk);
      else if (!forced) { forced = "maxBuffer"; killTree(); }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderr.reduce((total, item) => total + item.length, 0) < STDERR_CAP) stderr.push(chunk);
      if (stderrBytes > MAX_OUTPUT_BYTES && !forced) { forced = "maxBuffer"; killTree(); }
    });
    child.on("error", (error) => { spawnError = error; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      // A shell may exit while a background grandchild remains in its process
      // group. Kill that group before a disposable checkout is cleaned.
      killTree();
      const parsed = parseOutput(Buffer.concat(stdout).toString("utf8"), probe.parse);
      const envelope: ProbeEnvelope = {
        output: parsed.value,
        stderr: cap(Buffer.concat(stderr).toString("utf8"), STDERR_CAP),
      };
      if (forced === "maxBuffer") {
        envelope.exitCode = -1;
        envelope.error = `command output exceeded ${MAX_OUTPUT_BYTES} bytes`;
      } else if (forced === "timeout") {
        envelope.exitCode = -1;
        envelope.error = `command timed out after ${timeout}ms`;
      } else if (spawnError) {
        envelope.exitCode = -1;
        envelope.error = `command failed to start: ${spawnError.message}`;
      } else if (signal) {
        envelope.exitCode = -1;
        envelope.error = `command terminated by signal ${signal}`;
      } else if ((code ?? 1) !== 0) {
        envelope.exitCode = code ?? 1;
        envelope.error = `command exited with code ${envelope.exitCode}`;
      } else envelope.exitCode = 0;
      if (parsed.parseError) envelope.error = envelope.error ? `${envelope.error}; ${parsed.parseError}` : parsed.parseError;
      resolve(envelope);
    });
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
    // A non-2xx response is a completed-but-FAILED probe (the HTTP analogue of a
    // nonzero exit): mark it with a transport error so a goal cannot silently
    // converge on a matching body while the service returned 4xx/5xx. The status
    // and body stay observable, so a criterion that DELIBERATELY inspects the
    // failure (e.g. `status eq 503`) still passes via the assess exemption.
    const httpError = res.ok ? undefined : `HTTP ${res.status}`;
    const error = [httpError, parsed.parseError].filter(Boolean).join("; ");
    return {
      output: parsed.value,
      status: res.status,
      ...(error ? { error } : {}),
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
  connectors?: ConnectorManager,
): Promise<ProbeEnvelope> {
  switch (probe.kind) {
    case "command":
      return runCommand(probe);
    case "http":
      return runHttp(probe);
    case "mcp":
      return connectors
        ? runMcp(probe, connectors)
        : { output: null, error: `connector '${probe.connector}' is unavailable in this proof runtime` };
  }
}
