# Repo map — what's canonical, and what everything else is

There are several directories named `keyoku*` across the workspace, and **two
different packages literally named `keyoku`**. This note removes the ambiguity.

## The one canonical, published package

**This repo (`keyoku-harness/`) is `keyoku` on npm** — the convergence + muscle-memory
harness, MCP-native, with the `keyoku` CLI.

| | |
|---|---|
| npm | [`keyoku`](https://www.npmjs.com/package/keyoku) (the `latest` dist-tag) |
| package name | `keyoku` (see `package.json`) |
| bin | `keyoku` → `dist/index.js` |
| install | `npm install -g keyoku && keyoku init` |
| repo | `github.com/Keyoku-ai/keyoku` |
| site | `keyoku.ai` |

If you are installing, depending on, or contributing to "Keyoku" — this is it.
Everything below is supporting or historical and is **not** what `npm i keyoku`
gives you.

## Supporting components (not this npm package)

- **`keyoku-engine/`** — the optional Go backend for teams: knowledge graph,
  semantic search, memory decay, cross-device sync. The harness runs fully
  standalone without it; set `KEYOKU_ENGINE_URL` to connect one.
  Repo: `github.com/Keyoku-ai/keyoku-engine`.
- **`keyoku-site/`** — the marketing site for `keyoku.ai` (deployed separately).

## Historical / sibling (do not confuse with the published package)

- **`../Keyoku Harness/keyoku/`** — an **earlier, private** package *also* named
  `keyoku` (v1.x), the original **AI-memory SDK** (auto-recall / auto-capture /
  heartbeat) from before the harness became the product. It is **not** published as
  the current `keyoku` and is not what this repo builds. Treat it as legacy unless
  you are specifically working on the memory SDK lineage.
- **`keyoku-node/` (`@keyoku/sdk`), `keyoku-python/`, `keyoku-embedded/`,
  `keyoku-bot/`, `keyoku-dashboard/`, `keyoku-git*`, `keyoku-infra/`,
  `keyoku-demo/`** — experiments, SDKs, deploy infra, and demos in the broader
  Keyoku family. None of them is the published `keyoku` CLI.

## Local working trees — the canonical clone

Two local clones of **this same repo** exist on the maintainer's machine. Editing
the wrong one ships nothing. The canonical one is:

> **`~/Development/Keyoku/keyoku-harness`** — this is what the **live Claude Code
> MCP server runs** (`~/.claude.json` points at its `dist/index.js`). Edit here,
> `npm run build`, and the next session picks it up.

The other clone — `~/Development/Keyoku Harness/keyoku-harness` — is a second
checkout used historically for `keyoku-site` deploys. To remove the foot-gun,
archive or delete it and keep a single working copy. (Both push to the same
GitHub remote, so no history is lost.)

## Rule of thumb

> When someone says "Keyoku," they mean **this package** (`keyoku-harness` →
> npm `keyoku`). The convergence loop and muscle memory live here. Anything else
> is a satellite — name it explicitly (`keyoku-engine`, the memory SDK, the site)
> to avoid the collision.
