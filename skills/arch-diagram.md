# Architecture diagrams
Author accurate, beautiful technical architecture diagrams as declarative specs rendered by `keyoku arch render` — never hand-drawn.

Architecture diagrams are **declarative specs** rendered by keyoku's deterministic
engine, so every diagram shares one visual language and re-renders identically.

## Pipeline
1. **Derive the truth first.** List real components and real edges from code —
   route registrations, service URLs, queue names — not from memory. Verify each
   edge with one search where possible. A beautiful wrong diagram is worse than none.
2. **Write the spec** (YAML; same shape as `architecture.diagram` in `.keyoku/deck.yaml`):

```yaml
nodes:
  - { id: browser,  icon: browser, label: User's browser, sub: entry point }
  - { id: frontend, icon: ui,      label: Web app,  sub: SPA, zone: app }
  - { id: backend,  icon: api,     label: API,      sub: org-scoped, zone: app }
  - { id: db,       icon: db,      label: Database, sub: migrations }
edges:
  - { from: browser, to: frontend }
  - { from: frontend, to: backend, label: auth header }
  - { from: backend, to: db }
zones:
  - { id: app, label: Application }
```

3. **Render**: `keyoku arch render spec.yaml -o out.svg` — or let
   `keyoku deck build` render it inside a deck's architecture section (same engine).
4. **Look at the output** (read the SVG as an image if your harness can): no
   overlapping labels, arrows follow data flow, edge labels legible.

## Authoring rules
- **One icon per node, from the built-in set only** (`keyoku arch icons` lists them;
  core set: browser ui api db gear agent doc shield cloud queue cache storage lock
  chart mail mobile terminal git user webhook). If nothing fits, `gear` + a precise
  label beats a wrong metaphor.
- **Left → right is the request path**; persistence right, async actors off the main
  lane. Author edges in true data-flow direction and the layout follows.
- **6 ± 3 nodes.** More means two diagrams — split by concern.
- **`sub` holds one fact** (port, protocol, table count) — not a sentence.
- **Label an edge only when the mechanism is the point** (auth scheme, event name).
- **Zones sparingly** — one boundary type per diagram (trust, deployment, or team).
- **Persona depth goes in prose, not the picture**: one accurate diagram, per-audience
  `explain:` text (stakeholder: guarantees; developer: mechanics).

## Where specs live
- Deck: `architecture` section of `.keyoku/deck.yaml`.
- Standalone: commit the spec beside the doc; the SVG is a build artifact.
