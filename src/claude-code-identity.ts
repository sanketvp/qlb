import { execFileSync } from 'node:child_process';
import type { IncomingHttpHeaders } from 'node:http';

/**
 * Claude Code identity for OAuth-credentialed Anthropic requests.
 *
 * QLB always forwards a Claude *subscription* (OAuth) bearer to api.anthropic.com. Anthropic
 * only honors that bearer when the request also carries the Claude Code client identity:
 * the `oauth-2025-04-20` + `claude-code-20250219` betas, a `claude-code/<ver>` user-agent,
 * `x-app: cli`, and the "You are Claude Code" system prefix. A bare bearer is answered with
 * `429 rate_limit_error "Error"` regardless of actual quota.
 *
 * Claude Code itself sends all of this. Generic Anthropic-Messages clients pointed at the
 * proxy (Hermes named-custom providers, curl, SDKs) treat 127.0.0.1 as a third-party endpoint
 * and send none of it — so the proxy guarantees the identity here. Every transform is
 * idempotent: a client that already sends the identity is forwarded unchanged.
 */

export const OAUTH_BETAS = ['oauth-2025-04-20', 'claude-code-20250219'] as const;
export const CLAUDE_CODE_SYSTEM_PREFIX =
  "You are Claude Code, Anthropic's official CLI for Claude.";
const CLAUDE_CODE_VERSION_FALLBACK = '2.1.278';

let versionCache: string | undefined;

/** Candidate `claude` binaries: PATH first, then the usual install locations (launchd has a bare PATH). */
function claudeCandidates(): string[] {
  const home = process.env.HOME ?? '';
  return [
    'claude',
    `${home}/.local/bin/claude`,
    `${home}/.claude/local/claude`,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
}

/** `claude --version` → "2.1.278"; static fallback when the CLI is absent. Cached per process. */
export function claudeCodeVersion(): string {
  if (versionCache) return versionCache;
  const override = process.env.QLB_CLAUDE_CODE_VERSION;
  if (override && /^\d+\.\d+\.\d+/.test(override)) {
    versionCache = override;
    return versionCache;
  }
  for (const bin of claudeCandidates()) {
    try {
      const out = execFileSync(bin, ['--version'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const first = out.trim().split(/\s+/)[0] ?? '';
      if (/^\d+\.\d+\.\d+/.test(first)) {
        versionCache = first;
        return versionCache;
      }
    } catch {
      // not installed at this location — try the next.
    }
  }
  versionCache = CLAUDE_CODE_VERSION_FALLBACK;
  return versionCache;
}

function headerValue(h: IncomingHttpHeaders, name: string): string | undefined {
  const v = h[name];
  if (Array.isArray(v)) return v[0];
  return typeof v === 'string' ? v : undefined;
}

/**
 * Headers that must be set on the upstream request. `anthropic-beta` is the UNION of the
 * client's betas and the OAuth betas (the client's interleaved-thinking / tool-streaming
 * betas must survive); user-agent / x-app are only added when the client is not already
 * identifying as Claude Code.
 */
export function claudeCodeIdentityHeaders(client: IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  const existing = (headerValue(client, 'anthropic-beta') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const merged: string[] = [];
  for (const b of [...existing, ...OAUTH_BETAS]) {
    if (!merged.includes(b)) merged.push(b);
  }
  out['anthropic-beta'] = merged.join(',');

  const ua = headerValue(client, 'user-agent') ?? '';
  if (!/^claude-code\//i.test(ua)) {
    out['user-agent'] = `claude-code/${claudeCodeVersion()} (external, cli)`;
  }
  if (!headerValue(client, 'x-app')) {
    out['x-app'] = 'cli';
  }
  return out;
}

type SystemBlock = { type: string; text?: string; [k: string]: unknown };

function isPrefixBlock(b: unknown): boolean {
  return (
    !!b &&
    typeof b === 'object' &&
    (b as SystemBlock).type === 'text' &&
    typeof (b as SystemBlock).text === 'string' &&
    ((b as SystemBlock).text as string).startsWith(CLAUDE_CODE_SYSTEM_PREFIX)
  );
}

/**
 * Ensure `body.system` starts with the Claude Code prefix block. Mutates `body` in place and
 * returns whether anything changed. String systems become a block list; an existing prefix
 * (Claude Code, Hermes-OAuth, pi) is left untouched.
 */
export function ensureClaudeCodeSystemPrefix(body: Record<string, unknown>): boolean {
  const prefixBlock: SystemBlock = { type: 'text', text: CLAUDE_CODE_SYSTEM_PREFIX };
  const sys = body.system;
  if (sys === undefined || sys === null) {
    body.system = [prefixBlock];
    return true;
  }
  if (typeof sys === 'string') {
    if (sys.startsWith(CLAUDE_CODE_SYSTEM_PREFIX)) return false;
    body.system = sys.length > 0 ? [prefixBlock, { type: 'text', text: sys }] : [prefixBlock];
    return true;
  }
  if (Array.isArray(sys)) {
    if (sys.length > 0 && isPrefixBlock(sys[0])) return false;
    body.system = [prefixBlock, ...sys];
    return true;
  }
  // Unknown shape — leave it alone; upstream will report the schema error.
  return false;
}
