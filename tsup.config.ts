import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "legacy-cli": "src/legacy-cli.ts",
  },
  format: ["esm"],
  target: "node20",
  // Compatibility tests still exercise the v2 optional SLM adapter, but the
  // v3 npm archive neither ships nor installs the Anthropic SDK.
  external: ["@anthropic-ai/sdk"],
  dts: false,
  splitting: false,
  sourcemap: true,
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
});
