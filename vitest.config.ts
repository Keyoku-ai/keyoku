import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // The Omnigent convergence loop paces rounds with a real sleep in prod
    // (default 5s); zero it so the suite stays fast. Pacing itself is verified
    // by injecting waitForAgent directly in omnigent-guardrails.test.ts.
    env: { KEYOKU_CONVERGE_POLL_MS: "0" },
    // Test files spin up MCP stdio servers and share ~/.keyoku state; run them
    // serially so the suite is a deterministic convergence probe (no parallel races).
    fileParallelism: false,
  },
});
