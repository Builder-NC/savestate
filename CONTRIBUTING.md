# Contributing to SaveState

Thanks for your interest in contributing to SaveState! 🎉

SaveState is encrypted backup and restore for AI agents — "Time Machine for AI." We welcome contributions from the community.

## Quick Start

```bash
# Clone the repo
git clone https://github.com/savestatedev/savestate.git
cd savestate

# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Link for local development
npm link
```

## Development Setup

### Prerequisites
- Node.js 18+ (20+ recommended)
- npm 9+
- Git

### Environment Variables (Optional)
For full functionality, you may want to set:
```bash
export SAVESTATE_API_KEY=your_api_key  # For cloud features
```

### Project Structure
```
savestate/
├── src/
│   ├── cli.ts           # Main CLI entry point
│   ├── commands/        # CLI commands (init, snapshot, restore, etc.)
│   ├── adapters/        # Platform adapters (OpenClaw, OpenAI, Claude, etc.)
│   ├── crypto/          # Encryption (AES-256-GCM, Argon2id)
│   └── storage/         # Storage backends (local, S3, R2)
├── tests/               # Test files
└── docs/                # Documentation
```

## How to Contribute

### Reporting Bugs
1. Check [existing issues](https://github.com/savestatedev/savestate/issues) first
2. Create a new issue with:
   - SaveState version (`savestate --version`)
   - Node.js version (`node --version`)
   - OS and version
   - Steps to reproduce
   - Expected vs actual behavior

### Suggesting Features
Open an issue with the `enhancement` label. Include:
- Use case / problem you're solving
- Proposed solution
- Alternatives you've considered

### Pull Requests

1. **Fork & clone** the repo
2. **Create a branch** from `main`:
   ```bash
   git checkout -b feature/your-feature-name
   # or
   git checkout -b fix/issue-number-description
   ```
3. **Make your changes**
4. **Test your changes**:
   ```bash
   npm test
   npm run build
   ```
5. **Commit** with a clear message:
   ```bash
   git commit -m "feat: add support for X"
   # or
   git commit -m "fix: resolve issue with Y"
   ```
6. **Push** and open a PR against `main`

### Commit Message Format
We use [Conventional Commits](https://www.conventionalcommits.org/):
- `feat:` New feature
- `fix:` Bug fix
- `docs:` Documentation only
- `test:` Adding/updating tests
- `chore:` Maintenance tasks
- `refactor:` Code change that neither fixes a bug nor adds a feature

### Code Style
- TypeScript strict mode
- 2-space indentation
- Single quotes for strings
- Trailing commas in multi-line
- Run `npm run lint` before committing (if available)

## Good First Issues

Looking for somewhere to start? Check issues labeled [`good first issue`](https://github.com/savestatedev/savestate/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22).

## Adding Platform Adapters

One of the most valuable contributions is adding support for new AI platforms. See `src/adapters/` for examples. A good adapter:

1. Implements the `Adapter` interface
2. Handles platform-specific file locations
3. Includes detection logic for the platform
4. Has tests covering snapshot and restore

## Security

If you discover a security vulnerability, please email security@savestate.dev instead of opening a public issue.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.

## Questions?

- Open a [discussion](https://github.com/savestatedev/savestate/discussions) (if enabled)
- Check the [README](README.md)
- Reach out in issues

---

Thank you for helping make SaveState better! 🙏
