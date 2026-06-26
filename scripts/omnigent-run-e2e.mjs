#!/usr/bin/env node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const baseUrl = (process.env.OMNIGENT_SERVER_URL || "http://127.0.0.1:6767").replace(/\/+$/, "");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function cleanupSession(sessionId) {
  if (!sessionId) return;
  await fetch(`${baseUrl}/v1/sessions/${encodeURIComponent(sessionId)}`, {
    method: "DELETE",
  }).catch(() => {});
}

async function main() {
  const home = await mkdtemp(join(tmpdir(), "keyoku-omnigent-run-e2e-"));
  process.env.KEYOKU_HOME = home;
  process.env.OMNIGENT_SERVER_URL = baseUrl;

  const {
    ConnectorManager,
    Harness,
    Store,
    runGoalOnOmnigent,
  } = await import(new URL("../dist/index.js", import.meta.url));

  const store = new Store(home);
  const connectors = new ConnectorManager(store);
  let dispatchPrompt = "";
  const dispatchSlm = {
    name: "e2e-dispatch",
    model: "fixed-json",
    async complete(prompt) {
      dispatchPrompt = prompt;
      return JSON.stringify({
        agent: "codex-native-ui",
        rationale: "codex-native-ui fits this narrow already-converged verification run because it is optimized for implementation and test feedback loops.",
      });
    },
  };
  const engine = new Harness(store, connectors, dispatchSlm);
  let sessionId = "";

  try {
    const goal = engine.createGoal({
      objective: "Omnigent run e2e goal is already converged",
      slug: "omnigent-run-e2e",
      autonomy: "autonomous",
      criteria: [
        {
          description: "node exits zero",
          probe: {
            kind: "command",
            run: 'node -e "process.exit(0)"',
            parse: "text",
          },
          assert: { path: "exitCode", op: "eq", value: 0 },
        },
      ],
    });

    const result = await runGoalOnOmnigent({
      engine,
      connectors,
      goalSlug: goal.slug,
      maxRounds: 1,
    });
    sessionId = result.sessionId;

    assert(result.converged === true, "expected converged=true");
    assert(result.rounds === 1, `expected 1 round, got ${result.rounds}`);
    assert(typeof result.sessionId === "string" && result.sessionId.length > 0, "missing session id");
    assert(dispatchPrompt.includes("Candidate agents:"), "dispatch model was not called");
    assert(result.dispatch?.agent === "codex-native-ui", `unexpected dispatch agent: ${JSON.stringify(result.dispatch)}`);
    assert(typeof result.dispatch?.rationale === "string" && result.dispatch.rationale.length > 0, "missing dispatch rationale");
    assert(result.dispatch.degraded !== true, "dispatch unexpectedly degraded");

    console.log(`PASS omnigent run e2e session=${result.sessionId} agent=${result.dispatch.agent} rationale="${result.dispatch.rationale}"`);
  } finally {
    await connectors.closeAll().catch(() => {});
    await cleanupSession(sessionId);
    await rm(home, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(`FAIL omnigent run e2e: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
