# Keyoku archive

This directory preserves code and product documents removed from the active build during the continuous-contribution-gate pivot. Archived files are retained for history and selective reuse; they are excluded from TypeScript compilation, npm packaging, tests, CLI help, and MCP registration.

Archiving rule:

1. Prove the code belongs only to an abandoned product surface.
2. Move implementation and dedicated tests together.
3. Remove all active imports, commands, tools, presets, and promises.
4. Keep a recovery note and run the complete active test suite.
5. Never archive a shared primitive merely because one old integration used it.

See each subdirectory for scope and recovery instructions.

- `legacy-omnigent/` — abandoned fleet-runner runtime and dedicated tests.
- `legacy-positioning/` — abandoned Outcome Engine positioning.
- `experimental-control-plane/` — recoverable live briefing, steering, presence, and generative-view prototype removed from the proof-first V1 launch path.
