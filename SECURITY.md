# Security policy

## Reporting a vulnerability

Do not include secrets, customer evidence, or exploit material in a public
issue.

This integration candidate does not yet have a verified private vulnerability
intake. Public release is blocked until the owner enables GitHub private
vulnerability reporting or designates and verifies a monitored security
contact. Final reporting instructions and response expectations must describe
that exact intake rather than an unverified mailbox.

## Supported versions

The public repository and npm `latest` tag still contain v2. The v3 candidate
is unreleased and receives fixes only on its reviewed integration line until a
replacement release is approved.

## v3 execution model — read this before evaluating

Keyoku v3 is a local assurance tool. Be aware of what it does by design:

- **Repository outcome probes are trusted code.** Review an unfamiliar outcome
  contract exactly as you would review project test scripts from an untrusted
  fork. The release candidate executes command probes in disposable source
  snapshots, but does not claim hostile-command containment from an OS sandbox.
- **Human authority is out of band.** The narrow v3 agent-facing CLI and MCP
  surfaces cannot fabricate review acceptance, connector approval, or shell
  workflows. Acceptance binds an identified human to one exact Factfile
  digest and source identity; it is not yet externally signed.
- **Factfiles can contain sensitive data.** Credential-shaped evidence values
  are redacted and portable artifacts are path- and signature-checked, but
  this is not artifact-wide DLP. Inspect every export before sharing it.
- **Pulse never silently sends.** Fixture and adapter-attested checkpoints are
  nondispatchable. A local checkpoint is planned only after current Factfile,
  source, and artifact bytes are reverified. Delivery requires separately
  authorized channel code and a recorded successful receipt.
- **No telemetry is enabled by default.** The local v3 surface does not require
  Engine, an account, an LLM key, or a hosted control plane.

## v2 compatibility

The v2 activity, connector, memory, workflow, and shell-execution surfaces are
not registered or shipped by the narrow v3 entrypoint. Existing v2 users must
continue to treat approved workflows and connector calls as local code running
with their user privileges. See the v2 release documentation for that retained
compatibility line.
