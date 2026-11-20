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

Run the build, `npm run typecheck:pi`, and the full test suite before opening a pull request. CI (`.github/workflows/ci.yml`, Node.js 22) installs dependencies, installs the pinned `@earendil-works/pi-coding-agent`, then runs `npm run build`, `npm run typecheck:pi`, and `npm test`. It re-runs `dist-test/test/keychain-client.test.js` and requires both `skipped 0` and `fail 0`, and re-runs `dist-test/test/qlb-pi-*.test.js` and requires `skipped 0`. Keep those suites free of skipped tests.

Keep TypeScript strict, use the existing two-space indentation and semicolon style, prefer Node built-ins over new dependencies, and keep credential access read-only unless a migration command explicitly owns the write.

## Provider integrations

Add a **built-in adapter** under `src/adapters/` when it is intended to ship with QLB. Implement the `Adapter` interface from `src/types.ts`, contain all errors as snapshots, register it in `src/adapters/index.ts`, and add focused tests with fake credentials and mocked network behavior.

For private, experimental, or third-party providers, write a plugin instead. Plugins require no QLB source changes and live in `~/.qlb/plugins/`; see [docs/plugins.md](docs/plugins.md).

Never commit real credentials, account addresses, machine-specific absolute paths, or generated `dist` output.
