# Bundled skills — harness-portable agent guidance

Keyoku ships its agent know-how as **bundled skills**: harness-neutral markdown
procedures that `keyoku skills install` materializes into whatever coding harness
the project uses. The package is the source of truth; the harness copy is an
install artifact (regenerate on upgrade, never hand-edit).

## Distribution design (implemented by `keyoku skills`)

```
keyoku skills list                 # bundled skills + versions
keyoku skills install [--harness claude|codex|cursor|generic|auto]
```

Harness targets (auto-detected from the repo, overridable):
- **claude** → `.claude/skills/<name>/SKILL.md` (frontmatter added: name, description)
- **codex**  → appended/refreshed section in `AGENTS.md` (delimited markers for idempotent refresh)
- **cursor** → `.cursor/rules/keyoku-<name>.mdc`
- **generic**→ `docs/keyoku-skills/<name>.md` + an index line in `AGENTS.md` if present

The same content is also exposed over the MCP server (resources/prompts), so
MCP-capable harnesses can read skills without any file install at all.

Each skill file here is pure harness-neutral markdown: first line `# <Title>`,
second line a one-sentence description (used as frontmatter/description on
install), then the procedure. No harness-specific paths — reference keyoku by
CLI (`keyoku …`) or MCP tool names only.

## Bundled skills

- `arch-diagram.md` — author accurate, beautiful architecture diagrams as specs
  rendered by `keyoku arch render` / deck architecture sections.
- `demo-evidence.md` — the record → watch → gate demo pipeline.
- `proof-workflow.md` — the contribution flow: outcome → work → directions → gate.
- `deck-authoring.md` — persona decks: agent plans config, `deck build` renders.
