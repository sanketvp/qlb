# Contributing

## Development setup

QLB requires Node.js 22 or newer.

```bash
npm install
npm run build
npm test
```

Please run both the build and full test suite before opening a pull request. Keep TypeScript strict, use the existing two-space indentation and semicolon style, prefer Node built-ins over new dependencies, and keep credential access read-only unless a migration command explicitly owns the write.

## Provider integrations

Add a **built-in adapter** under `src/adapters/` when it is intended to ship with QLB. Implement the `Adapter` interface from `src/types.ts`, contain all errors as snapshots, register it in `src/adapters/index.ts`, and add focused tests with fake credentials and mocked network behavior.

For private, experimental, or third-party providers, write a plugin instead. Plugins require no QLB source changes and live in `~/.qlb/plugins/`; see [docs/plugins.md](docs/plugins.md).

Never commit real credentials, account addresses, machine-specific absolute paths, or generated `dist` output.
