# Deck authoring
Produce persona-targeted evidence decks: the coding agent plans `.keyoku/deck.yaml`, `keyoku deck build` renders deterministically.

## Division of labor
- **Agent (you)**: author the CONFIG — audience, section order, copy, frame choices,
  annotations, architecture spec. `keyoku deck plan "<natural prompt>"` does this
  from a prompt; hand-editing deck.yaml is equally valid.
- **Keyoku**: render. Same config → same deck, any project. Never hand-assemble the
  HTML; if the renderer lacks a section type you need, that's a generator gap to
  raise, not a reason to freehand.

## Personas
- `stakeholder`: video first, big visuals, short status (verdict + counts + pending
  decisions), concepts explained in plain language.
- `developer`: original change request, requirements → delivered mapping with
  evidence keys, annotated before/after pairs, FULL status (every criterion with its
  reproduce command), architecture mechanics. Demo video only if it adds something.
- Persona controls inclusion AND order via `personas.<name>.sections`.

## Content rules
- Captions state what the viewer is seeing plus the number that matters.
- Before/after pairs need REAL "before" captures (previous deploy/image), annotated
  with %-box markers (same shape as Factfile artifact annotations).
- Quote YAML values containing `#` (a bare `PR #12` starts a comment mid-flow-map).
- One screen per slide; horizontal navigation; tabs expose every section.
- End with links: PRs, the other persona's deck, the Factfile.

## Mandatory visual review — no publish without it
Before publishing ANY deck or diagram, LOOK at every image as a viewer will see
it — open the built HTML (or read each slide image) and check each frame IN ITS
FINAL CROP/SIZE, not the raw capture. The classic failure: a raw frame is fine
but the deck's crop slices off a popover, or a caption's subject sits in the
cropped region. Check: nothing meaningful cut off, no clipped tooltips/labels,
text in diagrams fits its boxes, both themes legible. If a frame fails, fix at
the source (re-capture, per-frame `crop: false`, shorter labels) — never ship
and hope.

## Publishing
Local HTML always; then offer the harness's publishing channel (e.g. an artifact)
rather than assuming one. Keep artifact URLs stable across re-publishes.
