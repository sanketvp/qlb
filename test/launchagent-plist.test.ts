import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { describe, it } from 'node:test';

import { renderAutoLaunchAgent, runAutoCommand } from '../src/commands/auto';
import { defaultConfig } from '../src/config';
import { discoverCommands, resolveCommand, type CommandContext } from '../src/registry';

const plistPath = join(__dirname, '..', '..', 'scripts', 'launchagents', 'com.modus.qlb-auto.plist');
const agentName = 'com.modus.qlb-auto.plist';

function stringValues(block: string): string[] {
  return [...block.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => match[1]!);
}

function valueAfterKey(plist: string, key: string): string {
  const match = plist.match(new RegExp(`<key>${key}</key>\\s*(<string>[^<]*</string>|<integer>\\d+</integer>|<true/>|<false/>)`));
  assert.ok(match, `missing ${key}`);
  return match[1]!;
}

function programArguments(plist: string): string[] {
  const match = plist.match(/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/);
  assert.ok(match, 'missing ProgramArguments');
  return stringValues(match[1]!);
}

function keepAlive(plist: string): string {
  const match = plist.match(/<key>KeepAlive<\/key>\s*<dict>([\s\S]*?)<\/dict>/);
  assert.ok(match, 'missing KeepAlive dictionary');
  return match[1]!;
}

function assertLaunchAgent(plist: string, nodePath: string, home: string, cliPath: string): void {
  const args = programArguments(plist);
  assert.deepEqual(args, [nodePath, cliPath, 'auto']);
  assert.ok(resolveCommand(args.slice(2), discoverCommands()), 'plist command must be registered');
  assert.equal(valueAfterKey(plist, 'RunAtLoad'), '<true/>');
  assert.match(keepAlive(plist), /<key>SuccessfulExit<\/key>\s*<false\/>/);
  assert.doesNotMatch(keepAlive(plist), /<true\/>/);
  assert.equal(valueAfterKey(plist, 'ThrottleInterval'), '<integer>60</integer>');
  assert.equal(valueAfterKey(plist, 'ExitTimeOut'), '<integer>60</integer>');
  assert.equal(plist.includes('~'), false);
  assert.equal(plist.includes('QLB_TEST_MODE'), false);
  for (const path of [...args.slice(0, 2), valueAfterKey(plist, 'StandardOutPath').slice(8, -9), valueAfterKey(plist, 'StandardErrorPath').slice(8, -9)]) {
    assert.ok(isAbsolute(path), `expected absolute path: ${path}`);
  }
}

describe('QLB auto LaunchAgent template (AC45)', () => {
  it('matches the renderer placeholder output and declares the auto agent restart policy', () => {
    const template = readFileSync(plistPath, 'utf8');
    const placeholderHome = '/Users/REPLACE_WITH_YOUR_USERNAME';
    const rendered = renderAutoLaunchAgent(
      '/usr/local/bin/node', placeholderHome, join(placeholderHome, '.qlb', 'app', 'current', 'dist', 'cli.js'),
    );
    assert.equal(template, rendered);
    assert.deepEqual(programArguments(template).slice(2), ['auto']);
    assert.match(keepAlive(template), /<key>SuccessfulExit<\/key>\s*<false\/>/);
    assert.equal(valueAfterKey(template, 'ThrottleInterval'), '<integer>60</integer>');
    assert.equal(valueAfterKey(template, 'ExitTimeOut'), '<integer>60</integer>');
    if (existsSync('/usr/bin/plutil')) {
      assert.match(execFileSync('/usr/bin/plutil', ['-lint', plistPath], { encoding: 'utf8' }), /OK/);
    } else {
      console.log('skipping template plutil -lint: /usr/bin/plutil is unavailable');
    }
  });

  it('renders a valid plist with absolute production paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-launchagent-render-'));
    const home = join(root, 'home');
    const nodePath = process.execPath;
    const cliPath = join(home, '.qlb', 'app', 'current', 'dist', 'cli.js');
    const rendered = renderAutoLaunchAgent(nodePath, home, cliPath);
    const renderedPath = join(root, agentName);
    try {
      writeFileSync(renderedPath, rendered);
      if (existsSync('/usr/bin/plutil')) {
        assert.match(execFileSync('/usr/bin/plutil', ['-lint', renderedPath], { encoding: 'utf8' }), /OK/);
      } else {
        console.log('skipping plutil -lint: /usr/bin/plutil is unavailable');
      }
      assertLaunchAgent(rendered, nodePath, home, cliPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('writes the rendered agent below QLB_HOME in test mode', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-launchagent-install-'));
    const home = join(root, 'home');
    const stdout: string[] = [];
    const ctx: CommandContext = {
      stdout: (line) => stdout.push(line), stderr: () => undefined,
      env: { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home }, config: defaultConfig(home),
      loadConfig: () => defaultConfig(home), home,
      registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    const target = join(home, 'Library', 'LaunchAgents', agentName);
    try {
      assert.equal(await runAutoCommand(['install-agent'], ctx), 0);
      assert.equal(stdout[0], `installed ${target}`);
      const rendered = readFileSync(target, 'utf8');
      assertLaunchAgent(rendered, process.execPath, home, join(home, 'app', 'current', 'dist', 'cli.js'));
      assert.equal(statSync(join(home, '.qlb')).mode & 0o777, 0o700);
      assert.equal(statSync(join(home, '.qlb', 'auto.log')).mode & 0o777, 0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('tightens an existing auto.log to 0600 during installation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-launchagent-existing-log-'));
    const home = join(root, 'home');
    const logPath = join(home, '.qlb', 'auto.log');
    const ctx: CommandContext = {
      stdout: () => undefined, stderr: () => undefined,
      env: { QLB_TEST_MODE: '1', QLB_HOME: home, HOME: home }, config: defaultConfig(home),
      loadConfig: () => defaultConfig(home), home,
      registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    try {
      mkdirSync(join(home, '.qlb'), { recursive: true, mode: 0o700 });
      writeFileSync(logPath, 'old log');
      chmodSync(logPath, 0o644);
      assert.equal(statSync(logPath).mode & 0o777, 0o644);
      assert.equal(await runAutoCommand(['install-agent'], ctx), 0);
      assert.equal(statSync(logPath).mode & 0o777, 0o600);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses test mode without QLB_HOME before writing anything', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qlb-launchagent-no-test-home-'));
    const home = join(root, 'home');
    const stderr: string[] = [];
    const ctx: CommandContext = {
      stdout: () => undefined, stderr: (line) => stderr.push(line),
      env: { QLB_TEST_MODE: '1', HOME: home }, config: defaultConfig(home),
      loadConfig: () => defaultConfig(home), home,
      registerSecret: () => undefined, deliverSecret: () => undefined, knownSecrets: () => [],
    };
    try {
      assert.equal(await runAutoCommand(['install-agent'], ctx), 2);
      assert.match(stderr.join('\n'), /QLB_HOME is required when QLB_TEST_MODE=1/);
      assert.equal(existsSync(home), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
