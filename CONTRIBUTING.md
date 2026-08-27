# Contributing to Keyoku

Thanks for helping make agent-assisted software easier to review. Keyoku is a
generic, agent-neutral proof harness: contributors should not need a particular
model, coding agent, hosted account, or memory service.

## Development setup

```bash
git clone https://github.com/Keyoku-ai/keyoku.git
cd keyoku
npm install
npm run typecheck
npm test
```

Node 20+ is required. Use `npm run preflight` before opening a pull request.

## Prove the outcome you changed

The repository dogfoods Keyoku. Pick the smallest outcome that describes your
change, customize it when the definition of done changes, and generate a fresh
Factfile for the exact revision under review:

```bash
npm run build
node dist/index.js outcome list
node dist/index.js proof run <outcome-id>
```

If no existing outcome fits, create a repository-owned contract with
`node dist/index.js proof init`, then edit the generated YAML. A strong outcome:

- describes one reviewer-sized result rather than an agent task;
- pairs every automated claim with why the evidence matters;
- asks a human only for decisions that cannot be reduced to a command;
- declares a path scope when the intended review boundary is known; and
- never treats an agent's confidence or a zero exit code as sufficient explanation.

Screenshots, traces, reports, videos, and logs may support a claim. Keep them
small, redact private data, and attach only evidence that teaches a reviewer
something about the result.

## Project layout

- `src/contribution.ts` — outcome evaluation, revision binding, and Factfile renderers
- `src/architecture.ts` — deterministic architecture projection
- `src/project-profile.ts` — one-command project and GitHub workflow setup
- `src/index.ts` — CLI surface
- `src/server.ts` — agent-neutral MCP tools
- `.keyoku/` — this repository's versioned outcomes and project policy
- `docs/FACTFILE-STANDARD.md` — portable receipt contract
- `archive/` — retired implementations, excluded from the launch surface
- `tests/` — unit and end-to-end verification

## Pull requests

- Keep one coherent outcome per PR; use stacked PRs for independent outcomes.
- Add tests for behavior changes and keep typecheck plus the full suite green.
- Include the generated GitHub summary or Factfile artifact for reviewer context.
- Use native GitHub review for the accountable decision: approve the exact
  revision, or request changes with a concrete next instruction.
- Update MCP tool-surface assertions in `tests/e2e.test.ts` when tools change.
- Never commit credentials, private prompts, customer data, local runtime state,
  or internal product/market working papers.

By contributing, you agree your contributions are licensed under the MIT license.
