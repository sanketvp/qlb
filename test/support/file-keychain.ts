import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { CredentialBackend } from '../../src/credential-backends';

/** Test-only, atomic file-backed Keychain shape for cross-process fixtures. */
export class FileKeychain implements CredentialBackend {
  readonly kind = 'test-memory' as const;

  constructor(private readonly path: string) {}

  async set(service: string, account: string, jsonValue: string): Promise<void> {
    this.setSync(service, account, jsonValue);
  }

  async get(service: string, account: string): Promise<string> {
    return this.getSync(service, account);
  }

  async delete(service: string, account: string): Promise<void> {
    this.deleteSync(service, account);
  }

  setSync(service: string, account: string, jsonValue: string): void {
    const items = this.read();
    items[this.key(service, account)] = jsonValue;
    this.write(items);
  }

  getSync(service: string, account: string): string {
    const value = this.read()[this.key(service, account)];
    if (typeof value !== 'string') throw new Error('fixture credential unavailable');
    return value;
  }

  deleteSync(service: string, account: string): void {
    const items = this.read();
    const key = this.key(service, account);
    if (!(key in items)) throw new Error('fixture credential unavailable');
    delete items[key];
    this.write(items);
  }

  private key(service: string, account: string): string {
    return `${service}\0${account}`;
  }

  private read(): Record<string, string> {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid');
      return parsed as Record<string, string>;
    } catch {
      return {};
    }
  }

  private write(items: Record<string, string>): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(temporary, JSON.stringify(items), { mode: 0o600 });
    renameSync(temporary, this.path);
  }
}
