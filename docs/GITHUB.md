# GitHub integration

Keyoku’s first distribution surface is a normal GitHub Check, reviewer-first job summary, and downloadable Factfile artifact. It does not require a GitHub App or hosted Keyoku account.

Install it from any Git repository in one command:

```bash
keyoku proof init
```

After a stable `v3` tag exists, the Marketplace-compatible composite action can
be used directly after installing project dependencies:

```yaml
- uses: actions/checkout@v4
  with:
    fetch-depth: 0
- uses: Keyoku-ai/keyoku@v3 # available only after the stable v3 release
  with:
    outcome: review-ready-change
    base: ${{ github.event.pull_request.base.sha }}
```

The action writes the native job summary, exposes `contribution-id`, `state`, and `factfile` outputs, and uploads the portable Factfile bundle. It requests no repository write permission.

Keyoku detects Node.js, Python, Rust, Go, or a generic Git project, creates a starter outcome contract, and writes `.github/workflows/keyoku-proof.yml`. Review the generated contract before treating it as definition of done. The workflow:

1. Checks out the proposed revision.
2. Installs the detected project dependencies.
3. Opens an ephemeral contribution attributed to GitHub Actions and binds it to the pull request base SHA.
4. Runs the repository-owned outcome contract.
5. Adds compact `factfile.github.md` to the native GitHub job summary.
6. Uploads JSON, GitHub Markdown, detailed Markdown, and HTML Factfiles as one artifact.
7. Fails the required check when machine evidence gaps or an explicit human block remain.

`human_review_required` does not fail the machine Check: it means the declared observations passed and normal GitHub human review still owns the decision. The summary makes that boundary visible.

Use GitHub's existing review controls for PR acceptance. For local agent steering, open the contribution id printed by `proof run`:

```bash
keyoku proof serve <contribution-id>
```

The local session keeps agent work, genuine blockers, attention signals, and proof separate. Human choices become durable MCP instructions; GitHub remains the source of truth for code review and merge.

In GitHub:

- **Approve** when the requested outcome is satisfied by the current exact revision.
- **Request changes** with the next concrete instruction when it is not.
- The agent or developer pushes another iteration; Keyoku automatically produces a new SHA-bound Factfile.

This keeps the first release GitHub-native without requiring a privileged Keyoku App or a second conversation UI.

## Security boundary

Outcome probes execute commands from the checked-out repository. Treat them like test scripts. The example workflow intentionally grants only `contents: read`; it does not give untrusted pull-request code a token that can comment, merge, publish, or modify the repository.

An automatic pull-request comment would require a separate privileged workflow that only reads a previously generated artifact and validates its digest. Do not combine untrusted probe execution with `pull-requests: write` merely for a nicer comment.

## Branch protection

After the workflow has run once, make `Keyoku proof / Keyoku / outcome proof` a required status check in the repository’s branch rules. This makes the outcome contract the contribution gate while preserving GitHub as the source-code host.

## Public credit

The artifact records actors, harness/model provenance, exact source scope, and evidence. A project may also commit accepted Factfiles or link the artifact from a release. Avoid publishing raw transcripts, secrets, customer data, or unrelated source output.
