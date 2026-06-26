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
  const engine = new Harness(store, connectors, null);
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

    console.log(`PASS omnigent run e2e session=${result.sessionId}`);
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
