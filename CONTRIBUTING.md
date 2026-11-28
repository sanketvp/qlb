# Contributing

## Development setup

QLB requires Node.js 22 or newer.

```bash
npm ci
npm run build
npm run typecheck:pi
npm test
node dist/cli.js release install
qlb pi deploy
```

`npm test` rebuilds, compiles `tsconfig.test.json` into `dist-test/`, and runs `node --test dist-test/test/*.test.js` with `QLB_TEST_MODE=1` and a temporary `QLB_HOME`. `npm run typecheck:pi` typechecks this package and then the Pi extension against the Pi you run (`QLB_PI_PACKAGE_ROOT` when `pi` is a wrapper QLB cannot trace).

`node dist/cli.js release install` publishes a clean `HEAD` to `~/.qlb/app/current`. A dirty worktree fails with `qlb release: source tree is dirty` (exit 1). A `--sha` that does not match the compiled build stamp exits 3 (`src/commands/release.ts`). `qlb pi deploy` copies that release's `extensions/qlb-pi` to `~/.pi/agent/extensions/qlb-pi` so `pi:extension` and `pi:extension-drift` can pass. Skip the last two commands when you are not publishing a release tree.

Run the build, `npm run typecheck:pi`, and the full test suite before opening a pull request. For a full local run, use the Pi version whose `exclude_tests` entry is empty in the [CI matrix](.github/workflows/ci.yml).

Keep TypeScript strict, use the existing two-space indentation and semicolon style, prefer Node built-ins over new dependencies, and keep credential access read-only unless a migration command explicitly owns the write.

## Provider integrations

Add a **built-in adapter** under `src/adapters/` when it is intended to ship with QLB. Implement the `Adapter` interface from `src/types.ts`, contain all errors as snapshots, register it in `src/adapters/index.ts`, and add focused tests with fake credentials and mocked network behavior.

For private, experimental, or third-party providers, write a plugin instead. Plugins require no QLB source changes and live in `~/.qlb/plugins/`; see [docs/plugins.md](docs/plugins.md).

Never commit real credentials, account addresses, machine-specific absolute paths, or generated `dist` output.
