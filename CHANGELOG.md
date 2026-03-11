# Changelog

All notable changes to keyoku will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [2.0.0] - 2025-03-10

### Added
- Full heartbeat system with extended signals (sentiment, relationships, knowledge gaps, patterns)
- Incremental capture mode (per-message memory extraction)
- LLM analysis support for heartbeat context
- Self-contained OpenClaw plugin with lifecycle management
- Migration from Sentai branding to Keyoku

### Packages
- `@keyoku/types` v2.0.0 — Shared TypeScript type definitions
- `@keyoku/memory` v2.0.0 — HTTP client for keyoku-engine
- `@keyoku/openclaw` v2.0.0 — OpenClaw plugin with auto-recall, auto-capture, and heartbeat

## [1.0.0] - 2025-02-15

### Added
- Initial release
- `@keyoku/types` — Memory, SearchResult, HeartbeatResult types
- `@keyoku/memory` — KeyokuClient with full CRUD, search, heartbeat, and scheduling
- `@keyoku/openclaw` — OpenClaw plugin with 7 tools, lifecycle hooks, and CLI integration
