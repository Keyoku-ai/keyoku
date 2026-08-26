# Keyoku repository map

Keyoku v3 is one product split across three repositories. This integration
branch is a local release candidate; it is not the published replacement yet.

| Repository | Candidate responsibility | Current publication boundary |
|---|---|---|
| `keyoku` (this repository) | MIT CLI, Factfile and Pulse schemas, local verifier, planner, renderers, GitHub workflow, and bounded MCP adapters | npm `latest` remains on the v2 release line; no v3 package has been published |
| `keyoku-engine` | Optional durable Factfile/Pulse SQLite registry and API | Optional; not required for local proof or Pulse |
| `keyoku-site` | Authoritative product and documentation website | Replacement remains private until the exact candidate is approved |

The v3 package contract is:

```text
package: keyoku
binary:  keyoku -> dist/index.js
install candidate: npm install -g keyoku@next
first command: keyoku proof init
rollback after a future alpha: npm install -g keyoku@2
```

Do not use that install candidate as a claim that `next` exists today. Source
evaluation uses `npm ci`, `npm run build`, and `npm link` from this repository.

The v2 goal, workflow, connector, activity, memory, and execution implementation
remains compatibility source. It is not registered by the v3 MCP server and its
test-only build is excluded from the npm package archive. See
[PUBLIC-SURFACE.md](PUBLIC-SURFACE.md) for the checked public inventory.

The optional Engine does not make Keyoku an agent runner. Coding harnesses own
agent execution; Keyoku owns bounded evidence, human attention, exact-source
Factfiles, and trusted progress projections.
