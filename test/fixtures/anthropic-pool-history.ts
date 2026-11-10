import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type HistoricalPoolPayload = 'owner' | 'journal' | 'auth' | 'backup' | 'pool' | 'prePool' | 'staging' | 'legacyOwner';

export interface HistoricalPoolArtifact {
  readonly required: readonly HistoricalPoolPayload[];
  readonly owner?: string;
  readonly journal?: string;
  readonly auth?: string;
  readonly backup?: string;
  readonly pool?: string;
  readonly prePool?: string;
  readonly staging?: string;
  readonly legacyOwner?: string;
  readonly absent?: readonly Exclude<HistoricalPoolPayload, 'journal' | 'legacyOwner'>[];
}

const POOL = `{
  "version": 1,
  "accounts": [
    {"id":"acct-a","provider":"anthropic","label":"Account A","grant":{"type":"oauth","access":"sk-ant-oat-fake-a","refresh":"sk-ant-ort-fake-a","expires":4102444800000}},
    {"id":"acct-b","provider":"anthropic","label":"Account B","grant":{"type":"oauth","access":"sk-ant-oat-fake-b","refresh":"sk-ant-ort-fake-b","expires":4102444800000}}
  ],
  "activeIndex": 0,
  "defaultCooldownMs": 10800000,
  "rotation": "round-robin"
}
`;

const OWNER = `{
  "owner": "qlb",
  "stagedAt": 1794290701385,
  "committedAt": null,
  "exportSeq": 0,
  "qlbAccountIds": ["acct-a", "acct-b"],
  "stores": ["pi-pool"],
  "accounts": [
    {"id":"acct-a","provider":"anthropic","label":"Account A","fingerprint":"b74a4a53b9cd03cfb4ec4c0bdb95f3311e8149c20019fa78763043680da2c966"},
    {"id":"acct-b","provider":"anthropic","label":"Account B","fingerprint":"a8d9ee8957271a4589148096fdddc81360173e506df5ad7e562bcdc5e0016971"}
  ]
}
`;

const JOURNAL = `{"accounts":[{"id":"acct-a","provider":"anthropic","label":"Account A","fingerprint":"b74a4a53b9cd03cfb4ec4c0bdb95f3311e8149c20019fa78763043680da2c966"},{"id":"acct-b","provider":"anthropic","label":"Account B","fingerprint":"a8d9ee8957271a4589148096fdddc81360173e506df5ad7e562bcdc5e0016971"}],"qlbAccountIds":["acct-a","acct-b"],"nativeMtime":1794290701351.4492,"poolFilePath":"__POOL_PATH__","ownerFilePath":"__OWNER_PATH__","stagedAt":1794290701385,"authBackupCycle":"6809dd58-5c4b-44fa-abfe-93df5da1794f","poolV2PublicationStarted":true,"rehearse":{"ok":true,"results":[{"id":"acct-a","ok":true},{"id":"acct-b","ok":true}],"validatedAt":1794290701393}}`;

const V2_OWNER = `{
  "providers": {
    "anthropic": {"mode":"qlb","since":1794290701401}
  }
}
`;

const PLACEHOLDER = `{
  "anthropic": {"type":"oauth","access":"qlb-managed","refresh":"","expires":4102444800000}
}
`;

const NATIVE_AUTH = `{
  "anthropic": {
    "type": "oauth",
    "access": "native-access",
    "refresh": "native-refresh",
    "expires": 1,
    "extra": {
      "kept": true
    }
  }
}
`;

const NATIVE_AUTH_WITH_XAI = `{
  "anthropic": {
    "type": "oauth",
    "access": "native-access",
    "refresh": "native-refresh",
    "expires": 1,
    "metadata": {
      "kept": true
    }
  },
  "xai": {
    "type": "oauth",
    "access": "other-access",
    "refresh": "other-refresh",
    "expires": 2
  }
}
`;

const PLACEHOLDER_WITH_XAI = `{
  "anthropic": {"type":"oauth","access":"qlb-managed","refresh":"","expires":4102444800000},
  "xai": {"type":"oauth","access":"other-access","refresh":"other-refresh","expires":2}
}
`;

const ABSENT_BACKUP = `{
  "version": 1,
  "authPath": "__AUTH_PATH__",
  "key": "anthropic",
  "cycleId": "6809dd58-5c4b-44fa-abfe-93df5da1794f",
  "filePresent": false,
  "entryPresent": false
}
`;

const BACKUP = `{
  "version": 1,
  "authPath": "__AUTH_PATH__",
  "key": "anthropic",
  "cycleId": "6809dd58-5c4b-44fa-abfe-93df5da1794f",
  "filePresent": true,
  "entryPresent": true,
  "entry": {"type":"oauth","access":"native-access","refresh":"native-refresh","expires":1,"extra":{"kept":true}}
}
`;

/** Captured recovery and rollback states; payloads are serialized literals, never publication setup. */
export const ANTHROPIC_POOL_HISTORY = {
  postOwnerCrash: { required: ['owner', 'journal', 'pool'], owner: OWNER, journal: JOURNAL.replace(',"poolV2PublicationStarted":true', ''), pool: POOL },
  backupCrash: { required: ['journal', 'auth', 'backup', 'staging', 'pool'], journal: JOURNAL, auth: NATIVE_AUTH, backup: BACKUP, staging: OWNER, pool: POOL },
  ownerEntryCrash: { required: ['owner', 'journal', 'auth', 'backup', 'staging', 'pool'], owner: V2_OWNER, journal: JOURNAL, auth: NATIVE_AUTH, backup: BACKUP, staging: OWNER, pool: POOL },
  placeholderCrash: { required: ['owner', 'journal', 'auth', 'backup', 'staging', 'pool'], owner: V2_OWNER, journal: JOURNAL, auth: PLACEHOLDER, backup: BACKUP, staging: OWNER, pool: POOL },
  absentAuth: { required: ['owner', 'journal', 'auth', 'backup', 'prePool'], owner: V2_OWNER, journal: JOURNAL, auth: PLACEHOLDER, backup: ABSENT_BACKUP, prePool: POOL },
  postRename: { required: ['owner', 'journal', 'auth', 'backup', 'prePool'], owner: V2_OWNER, journal: JOURNAL, auth: PLACEHOLDER, backup: BACKUP, prePool: POOL, absent: ['pool'] },
  rollback: { required: ['owner', 'journal', 'auth', 'backup', 'prePool'], owner: V2_OWNER, journal: JOURNAL, auth: PLACEHOLDER, backup: BACKUP, prePool: POOL, absent: ['pool'] },
  rollbackWithSibling: { required: ['owner', 'journal', 'auth', 'backup', 'prePool'], owner: V2_OWNER, journal: JOURNAL, auth: PLACEHOLDER_WITH_XAI, backup: BACKUP.replace('"extra":{"kept":true}', '"metadata":{"kept":true}'), prePool: POOL },
  malformedAuth: { required: ['owner', 'journal', 'auth', 'backup', 'prePool'], owner: V2_OWNER, journal: JOURNAL, auth: '{not-json\n', backup: BACKUP, prePool: POOL, absent: ['pool'] },
  absentParent: { required: ['owner', 'journal', 'backup', 'prePool'], owner: V2_OWNER, journal: JOURNAL, backup: BACKUP, prePool: POOL },
  legacyOwner: { required: ['legacyOwner', 'journal', 'auth', 'pool'], legacyOwner: '{"owner":"qlb","accounts":[{"provider":"anthropic"}]}\n', journal: JOURNAL, auth: NATIVE_AUTH, pool: POOL },
  customOwnerRace: { required: ['owner', 'legacyOwner', 'journal', 'auth', 'backup', 'pool'], owner: V2_OWNER, legacyOwner: '{"owner":"qlb","accounts":[{"provider":"anthropic"}]}\n', journal: JOURNAL, auth: PLACEHOLDER, backup: BACKUP, pool: POOL },
} as const satisfies Record<string, HistoricalPoolArtifact>;

export interface HistoricalPoolPaths {
  owner: string;
  pool: string;
  prePool: string;
  staging: string;
  auth: string;
  backup: string;
  legacyOwner?: string;
}

/** Fails closed rather than manufacturing omitted historical state. */
export function installHistoricalPoolArtifact(
  artifact: HistoricalPoolArtifact,
  paths: HistoricalPoolPaths,
  installJournal: (detail: string) => void,
): void {
  const payloads: Record<HistoricalPoolPayload, string | undefined> = {
    owner: artifact.owner,
    journal: artifact.journal,
    auth: artifact.auth,
    backup: artifact.backup,
    pool: artifact.pool,
    prePool: artifact.prePool,
    staging: artifact.staging,
    legacyOwner: artifact.legacyOwner,
  };
  for (const required of artifact.required) {
    if (typeof payloads[required] !== 'string') throw new Error(`historical Anthropic pool artifact is missing required ${required} payload`);
    if (required === 'legacyOwner' && !paths.legacyOwner) throw new Error('historical Anthropic pool artifact is missing legacy owner path');
  }
  const locations: Record<Exclude<HistoricalPoolPayload, 'journal' | 'legacyOwner'>, string> = {
    owner: paths.owner, auth: paths.auth, backup: paths.backup, pool: paths.pool, prePool: paths.prePool, staging: paths.staging,
  };
  for (const [name, location] of Object.entries(locations) as Array<[Exclude<HistoricalPoolPayload, 'journal' | 'legacyOwner'>, string]>) {
    const payload = payloads[name];
    if (payload === undefined) continue;
    mkdirSync(dirname(location), { recursive: true, mode: 0o700 });
    writeFileSync(location, payload.replaceAll('__POOL_PATH__', paths.pool).replaceAll('__OWNER_PATH__', paths.owner).replaceAll('__AUTH_PATH__', paths.auth), { mode: 0o600 });
  }
  for (const absent of artifact.absent ?? []) rmSync(locations[absent], { force: true });
  if (artifact.legacyOwner !== undefined && paths.legacyOwner) {
    mkdirSync(dirname(paths.legacyOwner), { recursive: true, mode: 0o700 });
    writeFileSync(paths.legacyOwner, artifact.legacyOwner, { mode: 0o600 });
  }
  if (artifact.journal !== undefined) installJournal(artifact.journal.replaceAll('__POOL_PATH__', paths.pool).replaceAll('__OWNER_PATH__', paths.owner));
}
