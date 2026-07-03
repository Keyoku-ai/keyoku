import { spawn } from "node:child_process";
import type { ConnectorManager } from "./connectors.js";

export interface BashStepOptions {
  cwd?: string;
  timeoutMs?: number;
  /**
   * Extra environment for the step. Workflow {{params}} are bound HERE (as env
   * vars the command references via "$VAR") rather than interpolated into the
   * command string — so `sh` treats param values as data and a value like
   * `$(rm -rf ~)` can never inject, regardless of quoting in the template.
   */
  env?: Record<string, string>;
}

/** PIDs of bash children still running, each the leader of its own process
 * group — so shutdown (index.ts serve) can tear down whole trees. */
const inFlight = new Set<number>();

/** Kill every in-flight bash step and its descendants. Called on server
 * shutdown so a slow child (and its grandchildren) can't outlive the server. */
export function killAllBashSteps(signal: NodeJS.Signals = "SIGKILL"): void {
  for (const pid of inFlight) {
    try {
      process.kill(-pid, signal);
    } catch {
      try { process.kill(pid, signal); } catch { /* already gone */ }
    }
  }
  inFlight.clear();
}

export async function executeBashStep(
  command: string,
  opts: BashStepOptions = {},
): Promise<{ result: string; ok: boolean }> {
  const { cwd, timeoutMs = 30_000, env } = opts;
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: cwd ?? process.cwd(),
      ...(env ? { env: { ...process.env, ...env } } : {}),
      // Lead a new process group so a timeout / shutdown kills the whole tree
      // (grandchildren included), not just the direct `sh`.
      detached: true,
    });
    const pid = child.pid;
    if (pid !== undefined) inFlight.add(pid);
    let settled = false;
    const settle = (r: { result: string; ok: boolean }): void => {
      if (settled) return;
      settled = true;
      if (pid !== undefined) inFlight.delete(pid);
      resolve(r);
    };
    const killTree = (signal: NodeJS.Signals): void => {
      if (pid === undefined) { child.kill(signal); return; }
      try { process.kill(-pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
    };
    let stdout = "";
    let stderr = "";
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const clearTimers = (): void => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
    };
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      killTree("SIGTERM");
      // Escalate to SIGKILL after 2s if SIGTERM is ignored. Tracked + unref'd so
      // it is CLEARED once the child exits (otherwise it fires a stray
      // process.kill(-pid) 2s later — a pid/pgid-reuse hazard — and hangs
      // one-shot CLI runs for 2s after every timed-out step).
      killTimer = setTimeout(() => killTree("SIGKILL"), 2000);
      killTimer.unref?.();
      settle({ result: `timed out after ${timeoutMs}ms`, ok: false });
    }, timeoutMs);
    timer.unref?.();
    child.on("close", (code) => {
      clearTimers();
      const combined = [stdout, stderr ? `stderr: ${stderr}` : ""]
        .filter(Boolean)
        .join("\n")
        .trim()
        .slice(0, 2000);
      settle({ result: combined || "(no output)", ok: code === 0 });
    });
    child.on("error", (err) => {
      clearTimers();
      settle({ result: err.message, ok: false });
    });
  });
}

export async function executeMcpStep(
  connector: string,
  tool: string,
  args: Record<string, unknown>,
  connectors: ConnectorManager,
): Promise<{ result: string; ok: boolean }> {
  try {
    const r = await connectors.callTool(connector, tool, args);
    return { result: (r.text ?? "(empty)").slice(0, 2000), ok: !r.isError };
  } catch (err) {
    return { result: err instanceof Error ? err.message : String(err), ok: false };
  }
}
