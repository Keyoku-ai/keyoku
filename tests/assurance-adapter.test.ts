import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  appendWorkEvent,
  evaluateEvidence,
  readWorkEvents,
  sealEvidenceEnvelope,
  sealWorkEvent,
} from "../src/assurance-adapter.js";
import { initProject } from "../src/contribution.js";
import { resolveLocalLedger, updateLocalLedger } from "../src/local-ledger.js";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const children: ChildProcessWithoutNullStreams[] = [];
const digest = (character: string): string => character.repeat(64);

afterEach(() => {
  for (const child of children.splice(0)) child.kill();
});

function envelope(decision: "approved" | "pending" | "rejected" = "approved") {
  return sealEvidenceEnvelope({
    schemaVersion: "evidence-provider/v1",
    work: { id: "bounded-change", objective: "Confirm one bounded change." },
    claims: [{ id: "behavior", statement: "The behavior passes.", verdict: "pass", evidenceRefs: ["native-check"] }],
    source: { capturedDigest: digest("a"), currentDigest: digest("a") },
    commands: [{ id: "native-check", command: "project-test-command", exitCode: 0, resultDigest: digest("b") }],
    artifacts: [],
    limitations: ["No deployment claim."],
    authority: { kind: "human", id: "review-owner", decision },
  });
}

function cli(args: string[]): string {
  return execFileSync(process.execPath, [entry, ...args], { encoding: "utf8" });
}

function mcpClient() {
  const child = spawn(process.execPath, [entry, "serve"]) as ChildProcessWithoutNullStreams;
  children.push(child);
  const lines = createInterface({ input: child.stdout });
  const waiters = new Map<number, (value: any) => void>();
  lines.on("line", (line) => {
    const message = JSON.parse(line) as { id?: number };
    if (message.id !== undefined) { waiters.get(message.id)?.(message); waiters.delete(message.id); }
  });
  let id = 0;
  const rpc = (method: string, params?: unknown): Promise<any> => new Promise((resolve, reject) => {
    const requestId = ++id;
    const timer = setTimeout(() => reject(new Error(`RPC timeout: ${method}`)), 10_000);
    waiters.set(requestId, (value) => { clearTimeout(timer); resolve(value); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params })}\n`);
  });
  return { child, rpc };
}

async function initializeMcp() {
  const client = mcpClient();
  await client.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "assurance-test", version: "1" } });
  client.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  return client;
}

describe("optional assurance adapter", () => {
  it("reads an absent local ledger without mutating the caller's project", () => {
    const root = mkdtempSync(join(tmpdir(), "keyoku-work-events-read-"));
    expect(readWorkEvents(root)).toEqual([]);
    expect(existsSync(join(root, ".keyoku"))).toBe(false);
  });

  it("returns deterministic accepted, rejected, stale, and human-review results without mutating input", () => {
    const acceptedInput = envelope();
    const before = JSON.stringify(acceptedInput);
    const accepted = evaluateEvidence(acceptedInput);
    expect(accepted).toMatchObject({ status: "accepted", reasons: [{ code: "evidence_accepted" }] });
    expect(evaluateEvidence(acceptedInput)).toEqual(accepted);
    expect(JSON.stringify(acceptedInput)).toBe(before);

    const tampered = { ...acceptedInput, work: { ...acceptedInput.work, objective: "Tampered after sealing." } };
    expect(evaluateEvidence(tampered)).toMatchObject({ status: "rejected", reasons: [{ code: "content_digest_mismatch" }] });

    const stale = sealEvidenceEnvelope({ ...acceptedInput, source: { capturedDigest: digest("a"), currentDigest: digest("c") } });
    expect(evaluateEvidence(stale)).toMatchObject({ status: "stale", reasons: [{ code: "source_changed" }] });

    expect(evaluateEvidence(envelope("pending"))).toMatchObject({ status: "human_review_required", reasons: [{ code: "authority_pending" }] });
    expect(evaluateEvidence(envelope("rejected"))).toMatchObject({ status: "rejected", reasons: [{ code: "authority_rejected" }] });
  });

  it("stores neutral WorkEvents idempotently and fails closed on conflicting ids", () => {
    const root = mkdtempSync(join(tmpdir(), "keyoku-work-events-"));
    const event = sealWorkEvent({ schemaVersion: "work-event/v1", id: "checkpoint-1", kind: "checkpoint", at: "2026-08-25T16:00:00.000Z", workId: "bounded-change", summary: "Evidence is ready.", limitations: [] });
    expect(appendWorkEvent(root, event).status).toBe("appended");
    expect(appendWorkEvent(root, event).status).toBe("deduplicated");
    expect(readWorkEvents(root)).toEqual([event]);
    const conflict = sealWorkEvent({ ...event, summary: "Conflicting content." });
    expect(() => appendWorkEvent(root, conflict)).toThrow(/different content/);
  });

  it("fails closed on linked storage paths and concurrent local writers", () => {
    const event = sealWorkEvent({ schemaVersion: "work-event/v1", id: "checkpoint-locked", kind: "checkpoint", at: "2026-08-25T16:00:00.000Z", workId: "bounded-change", summary: "Evidence is ready.", limitations: [] });

    const linkedRoot = mkdtempSync(join(tmpdir(), "keyoku-work-events-link-"));
    const outside = mkdtempSync(join(tmpdir(), "keyoku-work-events-outside-"));
    symlinkSync(outside, join(linkedRoot, ".keyoku"), "dir");
    expect(() => appendWorkEvent(linkedRoot, event)).toThrow(/real directory|symbolic link/);

    const lockedRoot = mkdtempSync(join(tmpdir(), "keyoku-work-events-lock-"));
    const pulseDir = join(lockedRoot, ".keyoku", "pulse");
    mkdirSync(pulseDir, { recursive: true });
    const lockPath = join(pulseDir, "work-events.jsonl.lock");
    writeFileSync(lockPath, "active writer\n", "utf8");
    expect(() => appendWorkEvent(lockedRoot, event)).toThrow(/ledger is busy/);
    expect(readFileSync(lockPath, "utf8")).toBe("active writer\n");
  });

  it("permits only bounded append-only ledger updates", () => {
    const root = mkdtempSync(join(tmpdir(), "keyoku-ledger-append-only-"));
    const path = resolveLocalLedger(root, "events.jsonl");
    updateLocalLedger(path, (current) => Buffer.concat([current, Buffer.from("one\n")]));
    expect(() => updateLocalLedger(path, () => Buffer.from("replacement\n"))).toThrow(/append-only/);
    expect(readFileSync(path, "utf8")).toBe("one\n");
    expect(existsSync(`${path}.lock`)).toBe(false);
  });

  it("returns the same canonical evaluation through the library, CLI, and MCP", async () => {
    const root = mkdtempSync(join(tmpdir(), "keyoku-assurance-paths-"));
    const input = envelope();
    const path = join(root, "evidence.json");
    writeFileSync(path, `${JSON.stringify(input)}\n`, "utf8");
    const direct = evaluateEvidence(input);
    const cliResult = JSON.parse(cli(["factfile", "assess", "--file", path, "--json"]));
    expect(cliResult.result.assessment).toEqual(direct);

    const client = await initializeMcp();
    const response = await client.rpc("tools/call", { name: "evidence_evaluate", arguments: { envelope: input } });
    const mcpResult = JSON.parse(response.result.content[0].text);
    expect(mcpResult.assessment).toEqual(direct);
  });

  it("shares canonical WorkEvent results across filesystem, CLI, and MCP paths", async () => {
    const root = mkdtempSync(join(tmpdir(), "keyoku-work-event-paths-"));
    initProject({ root, name: "Neutral Project" });
    const event = sealWorkEvent({ schemaVersion: "work-event/v1", id: "milestone-1", kind: "milestone", at: "2026-08-25T16:00:00.000Z", workId: "bounded-change", summary: "A milestone is available.", limitations: [] });
    const path = join(root, "event.json");
    writeFileSync(path, `${JSON.stringify(event)}\n`, "utf8");
    const cliResult = JSON.parse(cli(["pulse", "work-event", "ingest", "--root", root, "--file", path, "--json"]));
    expect(cliResult.result.event).toEqual(event);
    expect(readWorkEvents(root)).toEqual([event]);

    const client = await initializeMcp();
    const response = await client.rpc("tools/call", { name: "pulse_work_event_ingest", arguments: { cwd: root, event } });
    const mcpResult = JSON.parse(response.result.content[0].text);
    expect(mcpResult).toMatchObject({ status: "deduplicated", event });
  });

  it("ships a generic fixture with no named agent product or harness", () => {
    const evidence = readFileSync(join(repositoryRoot, "fixtures", "assurance", "v1", "evidence.json"), "utf8");
    const events = readFileSync(join(repositoryRoot, "fixtures", "assurance", "v1", "work-events.jsonl"), "utf8");
    expect(`${evidence}\n${events}`).not.toMatch(/codex|claude|copilot|cursor|github|processyard|harness/i);
    expect(evaluateEvidence(JSON.parse(evidence))).toMatchObject({ status: "accepted" });
  });
});
