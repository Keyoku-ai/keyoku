# Changelog

All notable changes to keyoku will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.3.0] - 2026-03-13

### Changed
- **Keyoku-driven heartbeat** — heartbeat logic moved from OpenClaw plugin to keyoku-engine's watcher; plugin now uses `before_prompt_build` hook for lightweight context injection instead of managing its own heartbeat loop
- Bumped all packages to v1.3.0

### Added
- Heartbeat setup, migration, and service unit tests
- Natural language format for context injection
- ESLint + Prettier configuration with type safety fixes

### Fixed
- Auto-capture pipeline, entity ID resolution, and client timeout handling
- Workspace dependency version sync

## [1.0.0] - 2025-03-10

### Added
- Full heartbeat system with extended signals (sentiment, relationships, knowledge gaps, patterns)
- Incremental capture mode (per-message memory extraction)
- LLM analysis support for heartbeat context
- Self-contained OpenClaw plugin with lifecycle management
- `@keyoku/types` v1.0.0 — Shared TypeScript type definitions
- `@keyoku/memory` v1.0.0 — HTTP client for keyoku-engine
- `@keyoku/openclaw` v1.0.0 — OpenClaw plugin with auto-recall, auto-capture, and heartbeat
