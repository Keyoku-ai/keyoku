# Contributing to keyoku

Thank you for your interest in contributing! This guide will help you get started.

## Reporting Bugs

Open a [GitHub Issue](https://github.com/keyoku-ai/keyoku/issues/new?template=bug_report.md) with:

- A clear description of the bug
- Steps to reproduce
- Expected vs actual behavior
- Node.js version and OS

## Suggesting Features

Open a [feature request](https://github.com/keyoku-ai/keyoku/issues/new?template=feature_request.md) describing:

- The problem you're trying to solve
- Your proposed solution
- Any alternatives you've considered

## Development Setup

```bash
# Clone the repo
git clone https://github.com/keyoku-ai/keyoku.git
cd keyoku

# Install dependencies
npm install

# Build all packages
npm run build

# Run tests
npm test
```

Requires Node.js 20+.

## Project Structure

```
packages/
├── types/     — Shared TypeScript type definitions
├── memory/    — HTTP client for keyoku-engine
└── openclaw/  — OpenClaw plugin for persistent memory
```

## Pull Request Process

1. Fork the repository
2. Create a feature branch (`git checkout -b feat/my-feature`)
3. Make your changes
4. Run `npm run build` and `npm test` to verify
5. Commit with a descriptive message (see below)
6. Push to your fork and open a PR

## Commit Messages

Use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(memory): add batch search support
fix(openclaw): handle empty heartbeat response
docs: update quick start guide
test(types): add type validation tests
chore: update dependencies
```

## Code Style

- Use TypeScript strict mode
- Follow existing patterns in the codebase
- Add tests for new functionality
- Keep functions focused and well-named

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
