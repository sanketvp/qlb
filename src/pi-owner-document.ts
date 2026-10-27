// Shared owner-file schema for the Pi gate and standalone qlb-pi extension.
// Keep this module dependency-free: `qlb pi deploy` copies it beside redact.ts.

export const PI_GATE_PROVIDERS = ['anthropic', 'openai-codex', 'xai', 'kimi-coding', 'openrouter'] as const;
export type PiGateProvider = (typeof PI_GATE_PROVIDERS)[number];

function ownerFileMalformed(): Error {
  return new Error('owner-file-malformed');
}

/** Whether a v2 entry claims a provider for QLB. */
export function isPiQlbOwnerEntry(entry: unknown): boolean {
  return !!entry && typeof entry === 'object' && !Array.isArray(entry)
    && (entry as Record<string, unknown>).mode === 'qlb';
}

/** Validates every shared owner-file shape accepted by the Pi gate. */
export function validatePiOwnerDocument(document: unknown): Record<string, unknown> {
  if (!document || typeof document !== 'object' || Array.isArray(document)) {
    throw ownerFileMalformed();
  }
  const owner = document as Record<string, unknown>;
  let recognized = false;
  if ('providers' in owner) {
    recognized = true;
    const providers = owner.providers;
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
      throw ownerFileMalformed();
    }
    for (const [provider, entry] of Object.entries(providers as Record<string, unknown>)) {
      const config = entry as Record<string, unknown>;
      const since = config.since;
      if (!(PI_GATE_PROVIDERS as readonly string[]).includes(provider)
        || !isPiQlbOwnerEntry(entry)
        || typeof since !== 'number'
        || !Number.isFinite(since)
        || since < 0) {
        throw ownerFileMalformed();
      }
    }
  }
  if ('owner' in owner || 'accounts' in owner) {
    recognized = true;
    if (typeof owner.owner !== 'string' || !Array.isArray(owner.accounts)) {
      throw ownerFileMalformed();
    }
  }
  if (!recognized) throw ownerFileMalformed();
  return owner;
}
