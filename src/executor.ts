import { spawn } from "node:child_process";
import type { ConnectorManager } from "./connectors.js";

export async function executeBashStep(
  command: string,
  cwd?: string,
  timeoutMs = 30_000,
): Promise<{ result: string; ok: boolean }> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: cwd ?? process.env.HOME,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ result: `timed out after ${timeoutMs}ms`, ok: false });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      const combined = [stdout, stderr ? `stderr: ${stderr}` : ""]
        .filter(Boolean)
        .join("\n")
        .trim()
        .slice(0, 2000);
      resolve({ result: combined || "(no output)", ok: code === 0 });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ result: err.message, ok: false });
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
