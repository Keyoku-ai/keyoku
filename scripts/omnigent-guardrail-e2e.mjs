#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseUrl = (process.env.OMNIGENT_SERVER_URL || "http://127.0.0.1:6767").replace(/\/+$/, "");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function httpJson(path, init) {
  const res = await fetch(`${baseUrl}${path}`, init);
  const text = await res.text();
  let body = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = text;
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${path}: ${typeof body === "string" ? body : JSON.stringify(body)}`);
  }
  return body;
}

function parseConnectorJson(result, label) {
  if (result.isError) throw new Error(`${label}: ${result.text}`);
  try {
    return JSON.parse(result.text);
  } catch {
    throw new Error(`${label}: non-JSON response ${result.text}`);
  }
}

function policyList(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.policies)) return payload.policies;
  return [];
}

async function listSessionPolicies(connectors, sessionId) {
  return policyList(
    parseConnectorJson(
      await connectors.callTool("omnigent", "list_policies_v1_sessions__session_id__policies_get", {
        session_id: sessionId,
      }),
      "list policies",
    ),
  );
}

async function main() {
  const home = await mkdtemp(join(tmpdir(), "keyoku-omnigent-e2e-"));
  process.env.KEYOKU_HOME = home;
  process.env.OMNIGENT_SERVER_URL = baseUrl;

  const {
    CONNECTOR_PRESETS,
    ConnectorManager,
    Store,
    driveToConvergence,
  } = await import(new URL("../dist/index.js", import.meta.url));

  const store = new Store(home);
  const connectors = new ConnectorManager(store);
  let sessionId = "";

  try {
    const transport = CONNECTOR_PRESETS.omnigent.buildTransport();
    await connectors.add({
      name: "omnigent",
      description: CONNECTOR_PRESETS.omnigent.description,
      transport,
      autonomy: "autonomous",
      addedAt: new Date().toISOString(),
    });

    const agents = await httpJson("/v1/agents?limit=1000");
    const agent =
      agents.data?.find((item) => item.harness === "codex-native") ??
      agents.data?.[0];
    assert(agent?.id, "no Omnigent built-in agent is available");

    const session = await httpJson("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: agent.id, title: "keyoku guardrail e2e" }),
    });
    sessionId = session.id;
    assert(sessionId, "create session returned no id");

    let sawGateWhileUnmet = false;
    let assessCalls = 0;
    const result = await driveToConvergence({
      connectors,
      sessionId,
      goalSlug: "e2e-guardrail",
      maxRounds: 2,
      assess: async () => {
        assessCalls += 1;
        return assessCalls === 1
          ? { converged: false, unmet: ["[c1] synthetic criterion still failing"] }
          : { converged: true, unmet: [] };
      },
      postMessage: async (text) => {
        assert(text.includes("Still not done"), "continuation message was not posted while unmet");
        const policies = await listSessionPolicies(connectors, sessionId);
        sawGateWhileUnmet = policies.some((policy) => policy.name === "keyoku-convergence-gate-e2e-guardrail");
      },
    });

    assert(result.converged === true, "driveToConvergence did not converge");
    assert(result.rounds === 2, `expected 2 rounds, got ${result.rounds}`);
    assert(sawGateWhileUnmet, "convergence gate was not present while criteria were unmet");

    const after = await listSessionPolicies(connectors, sessionId);
    assert(
      !after.some((policy) => policy.name === "keyoku-convergence-gate-e2e-guardrail"),
      "convergence gate remained after convergence",
    );

    console.log("PASS omnigent guardrail e2e");
  } finally {
    await connectors.closeAll().catch(() => {});
    if (sessionId) {
      await fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" }).catch(() => {});
    }
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(`FAIL omnigent guardrail e2e: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
