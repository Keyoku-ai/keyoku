# Publishing Keyoku v3

This repository is an unpublished v3 candidate. npm `latest` remains on the v2
release line. A passing build or preflight is evidence for a candidate, not
authorization to tag, push, publish, or move a dist-tag.

## Candidate sequence

1. Freeze exact candidate revisions for `keyoku`, `keyoku-engine`, and
   `keyoku-site` without changing the existing public release.
2. Run typecheck, full tests, public-surface inventory checks, security gates,
   clean archive install, generated-output execution, browser acceptance, and
   the declared support matrix against those exact revisions.
3. Generate release notes, migration guidance, checksums, SBOM/provenance where
   supported, rollback instructions, and a revision-bound evidence manifest.
4. Obtain the owner's explicit approval for that exact candidate and resolve
   any licensing or repository-posture decision.
5. Publish an alpha to the `next` dist-tag. Do not move `latest`.
6. Verify clean installation with `npm install keyoku@next`, the bounded CLI and
   MCP inventories, `proof demo`, Factfile stale rejection, and Pulse replay.
7. Only after alpha acceptance, separately approve a stable v3 tag and any
   `latest` dist-tag change.

## Rollback

The stable rollback boundary is explicit:

```bash
npm install -g keyoku@2
```

Do not remove the v2 package line or overwrite an existing version. npm package
versions are immutable; a bad v3 candidate should be deprecated or superseded,
not silently replaced.

## Authentication and provenance

Trusted Publishing with npm OIDC is preferred over a long-lived token. The
release workflow requests `id-token: write`, but credentials do not grant
product approval. Publication automation must preserve the chosen dist-tag and
must fail visibly when publish did not occur.

Never run `npm publish`, push a release tag, or change `latest` merely because
this document or `npm run preflight` is present. Those are separately approved
external actions.
