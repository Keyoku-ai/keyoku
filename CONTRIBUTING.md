# Contributing to Keyoku

Thanks for helping make Keyoku better.

## Development setup

```bash
git clone https://github.com/Keyoku-ai/keyoku.git
cd keyoku
npm install
npm run build      # tsup → dist/
npm test           # builds, then runs the full vitest suite (incl. MCP e2e)
npm run typecheck  # tsc --noEmit
```

Node 20+ required. State during manual testing goes to `$KEYOKU_HOME` — set it
to a temp dir (`KEYOKU_HOME=/tmp/keyoku-dev node dist/index.js serve`) so you
don't pollute your real `~/.keyoku`.

## Project layout

- `src/server.ts` — MCP tool surface (the API)
- `src/activity.ts` — pattern detection over the activity stream
- `src/refine.ts` — optional SLM refinement of suggestions
- `src/executor.ts` — bash / mcp_call step execution
- `src/store.ts` — JSON-file persistence under `~/.keyoku`
- `src/index.ts` — CLI (`serve`, `init`, `record`, …)
- `tests/` — unit + end-to-end tests (e2e drives a real MCP stdio session)

## Pull requests

- Every behavior change needs a test. CI (typecheck + full suite) must pass.
- Keep PRs focused; explain *why* in the description, not just what.
- New MCP tools must be added to the tool-surface snapshot in `tests/e2e.test.ts`.

By contributing you agree your contributions are licensed under the MIT license.
