# Publishing

Releases are tag-driven. Pushing a `v*` tag runs `.github/workflows/release.yml`,
which typechecks, tests, runs the muscle-memory eval (a hard quality gate), and
then publishes to npm. The workflow is **idempotent** — it skips a version that is
already on npm — and it **never reports a false success**: if no publish auth is
configured it emits a loud warning and exits 0 rather than pretending it shipped.

## Cut a release

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. Commit, then tag and push:
   ```bash
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```
3. Watch the **Release** workflow. Green + "Published keyoku@X.Y.Z with provenance"
   means done.

## One-time auth setup (the only manual gap)

The workflow code is complete; npm just needs to trust it. Pick **one**:

### Option A — Trusted Publishing (recommended: tokenless + provenance)

No secret to manage. On npmjs.com:

> package **`keyoku`** → **Settings** → **Trusted Publishing** → add publisher:
> repository **`Keyoku-ai/keyoku`**, workflow **`release.yml`**.

The workflow already requests the OIDC token (`permissions: id-token: write`) and
upgrades npm to a version that supports OIDC, so once this is added the next tag
publishes automatically with provenance.

### Option B — `NPM_TOKEN` secret (fallback)

Create an **Automation** access token on npmjs.com and add it as the repo secret
`NPM_TOKEN` (Settings → Secrets and variables → Actions). The workflow already
wires `NODE_AUTH_TOKEN` from it.

## Manual fallback

Until A or B is configured, publish from an authenticated maintainer machine:

```bash
npm run build
npm publish --access public
```

This is safe to run anytime — npm rejects a re-publish of an existing version,
matching the workflow's idempotency.
