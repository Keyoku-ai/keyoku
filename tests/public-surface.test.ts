import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import { afterEach, describe, expect, it } from "vitest";

import { PUBLIC_CLI_SURFACE, PUBLIC_MCP_SURFACE } from "../src/public-surface.js";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const children: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

function cli(args: string[]): { stdout: string; stderr: string; code: number } {
  try {
    return {
      stdout: execFileSync(process.execPath, [entry, ...args], { encoding: "utf8" }),
      stderr: "",
      code: 0,
    };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; status?: number };
    return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: failure.status ?? 1 };
  }
}

function mcpClient() {
  const child = spawn(process.execPath, [entry, "serve"]) as ChildProcessWithoutNullStreams;
  children.push(child);
  const lines = createInterface({ input: child.stdout });
  const waiters = new Map<number, (value: unknown) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as { id?: number };
    if (message.id !== undefined) {
      waiters.get(message.id)?.(message);
      waiters.delete(message.id);
    }
  });
  let id = 0;
  const rpc = (method: string, params?: unknown): Promise<any> => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 10_000);
    waiters.set(requestId, (value) => {
      clearTimeout(timer);
      resolve(value);
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
  });
  return { child, rpc };
}

describe("v3 checked public surface", () => {
  it("renders top-level help directly from the CLI inventory", () => {
    const help = cli(["--help"]);
    expect(help.code).toBe(0);
    for (const command of PUBLIC_CLI_SURFACE) expect(help.stdout).toContain(`keyoku ${command.name}`);
    for (const removed of ["goal", "workflow", "connector", "record", "learn", "iterate", "contribution", "gate", "project", "outcome"]) {
      expect(help.stdout).not.toMatch(new RegExp(`keyoku\\s+${removed}\\b`));
    }
  });

  it("documents every inventoried public subcommand in built help", () => {
    for (const command of PUBLIC_CLI_SURFACE) {
      if (command.subcommands.length === 0) continue;
      const help = cli([command.name, command.name === "pulse" ? "help" : "--help"]);
      expect(help.code, command.name).toBe(0);
      for (const subcommand of command.subcommands) expect(help.stdout, `${command.name} ${subcommand}`).toMatch(new RegExp(`\\b${subcommand}\\b`));
    }
  });

  it("rejects every legacy top-level command instead of silently dispatching compatibility code", () => {
    for (const command of ["goal", "record", "iterate", "contribution", "gate", "project", "outcome", "export"]) {
      const result = cli([command]);
      expect(result.code, command).toBe(2);
      expect(result.stderr, command).toContain(`Unknown command '${command}'`);
    }
  });

  it("offers stable JSON diagnostics from either global or command-local --json", () => {
    const global = JSON.parse(cli(["--json", "doctor"]).stdout);
    const local = JSON.parse(cli(["doctor", "--json"]).stdout);
    const expectedCli = PUBLIC_CLI_SURFACE.map((item) => item.name);
    const expectedMcp = PUBLIC_MCP_SURFACE.map((item) => item.name);
    expect(global.publicCliCommands).toEqual(expectedCli);
    expect(global.publicMcpTools).toEqual(expectedMcp);
    expect(local.publicCliCommands).toEqual(expectedCli);
    expect(local.boundaries).toEqual({ runsAgent: false, sendsPulseDelivery: false, mcpCanAcceptHumanReview: false });
  });

  it("registers exactly the inventory's MCP tools over the built stdio entrypoint", async () => {
    const client = mcpClient();
    await client.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "surface-test", version: "1" },
    });
    client.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const listed = await client.rpc("tools/list", {});
    const actual = listed.result.tools.map((tool: { name: string }) => tool.name);
    expect(actual).toEqual(PUBLIC_MCP_SURFACE.map((item) => item.name));
    expect(actual).not.toContain("contribution_review");
    expect(actual.some((name: string) => /^(goal_|workflow_|connector_|activity_|knowledge_|execution_)/.test(name))).toBe(false);
  });

  it("fails every public MCP tool closed on malformed input", async () => {
    const client = mcpClient();
    await client.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "malformed-surface-test", version: "1" },
    });
    client.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    for (const tool of PUBLIC_MCP_SURFACE) {
      const result = await client.rpc("tools/call", { name: tool.name, arguments: { cwd: 1 } });
      expect(result.result?.isError ?? Boolean(result.error), tool.name).toBe(true);
    }
  });
});
