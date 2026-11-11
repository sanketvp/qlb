import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export type HistoricalPoolPayload = 'owner' | 'journal' | 'auth' | 'backup' | 'pool' | 'prePool' | 'sidecar' | 'staging' | 'legacyOwner';
export type HistoricalPoolState = 'VALIDATED' | 'QLB_OWNED';

export interface HistoricalPoolArtifact {
  readonly state: HistoricalPoolState;
  readonly owner?: string;
  readonly journal?: string;
  readonly auth?: string;
  readonly backup?: string;
  readonly pool?: string;
  readonly prePool?: string;
  readonly sidecar?: string;
  readonly staging?: string;
  readonly legacyOwner?: string;
}

const POOL = `{
  "version": 1,
  "accounts": [
    {"id":"acct-a","name":"Account A","credentials":{"type":"oauth","access":"sk-ant-oat-fake-a","refresh":"sk-ant-ort-fake-a","expires":4102444800000}},
    {"id":"acct-b","name":"Account B","credentials":{"type":"oauth","access":"sk-ant-oat-fake-b","refresh":"sk-ant-ort-fake-b","expires":4102444800000}}
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
const POST_OWNER_JOURNAL = `{"accounts":[{"id":"acct-a","provider":"anthropic","label":"Account A","fingerprint":"b74a4a53b9cd03cfb4ec4c0bdb95f3311e8149c20019fa78763043680da2c966"},{"id":"acct-b","provider":"anthropic","label":"Account B","fingerprint":"a8d9ee8957271a4589148096fdddc81360173e506df5ad7e562bcdc5e0016971"}],"qlbAccountIds":["acct-a","acct-b"],"nativeMtime":1794290701351.4492,"poolFilePath":"__POOL_PATH__","ownerFilePath":"__OWNER_PATH__","stagedAt":1794290701385,"authBackupCycle":"6809dd58-5c4b-44fa-abfe-93df5da1794f","rehearse":{"ok":true,"results":[{"id":"acct-a","ok":true},{"id":"acct-b","ok":true}],"validatedAt":1794290701393}}`;
const QLB_OWNED_JOURNAL = `{"accounts":[{"id":"acct-a","provider":"anthropic","label":"Account A","fingerprint":"b74a4a53b9cd03cfb4ec4c0bdb95f3311e8149c20019fa78763043680da2c966"},{"id":"acct-b","provider":"anthropic","label":"Account B","fingerprint":"a8d9ee8957271a4589148096fdddc81360173e506df5ad7e562bcdc5e0016971"}],"qlbAccountIds":["acct-a","acct-b"],"nativeMtime":1794290701351.4492,"poolFilePath":"__POOL_PATH__","ownerFilePath":"__OWNER_PATH__","stagedAt":1794290701385,"authBackupCycle":"6809dd58-5c4b-44fa-abfe-93df5da1794f","poolV2PublicationStarted":true,"rehearse":{"ok":true,"results":[{"id":"acct-a","ok":true},{"id":"acct-b","ok":true}],"validatedAt":1794290701393},"committedAt":1794290701401}`;

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

export const NATIVE_AUTH = `{
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

export const NATIVE_AUTH_WITH_XAI = `{
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

const SIDECAR = `{
  "retiredAt": 1794290701401,
  "fingerprint": {
    "acct-a": "b74a4a53b9cd03cfb4ec4c0bdb95f3311e8149c20019fa78763043680da2c966",
    "acct-b": "a8d9ee8957271a4589148096fdddc81360173e506df5ad7e562bcdc5e0016971"
  },
  "qlbAccountIds": [
    "acct-a",
    "acct-b"
  ]
}
`;

/** Historical recovery and rollback states; payloads are serialized literals, never publication setup. */
export const ANTHROPIC_POOL_HISTORY = {
  postOwnerCrash: { state: 'VALIDATED', owner: OWNER, journal: POST_OWNER_JOURNAL, pool: POOL },
  backupCrash: { state: 'VALIDATED', journal: JOURNAL, auth: NATIVE_AUTH, backup: BACKUP, staging: OWNER, pool: POOL },
  ownerEntryCrash: { state: 'VALIDATED', owner: V2_OWNER, journal: JOURNAL, auth: NATIVE_AUTH, backup: BACKUP, staging: OWNER, pool: POOL },
  placeholderCrash: { state: 'VALIDATED', owner: V2_OWNER, journal: JOURNAL, auth: PLACEHOLDER, backup: BACKUP, staging: OWNER, pool: POOL },
  absentAuth: { state: 'QLB_OWNED', owner: V2_OWNER, journal: QLB_OWNED_JOURNAL, auth: PLACEHOLDER, backup: ABSENT_BACKUP, prePool: POOL },
  postRename: { state: 'QLB_OWNED', owner: V2_OWNER, journal: QLB_OWNED_JOURNAL, auth: PLACEHOLDER, backup: BACKUP, prePool: POOL },
  postFullCommit: { state: 'QLB_OWNED', owner: V2_OWNER, journal: QLB_OWNED_JOURNAL, auth: PLACEHOLDER, backup: BACKUP, prePool: POOL, sidecar: SIDECAR },
  rollbackWithSibling: { state: 'QLB_OWNED', owner: V2_OWNER, journal: QLB_OWNED_JOURNAL, auth: PLACEHOLDER_WITH_XAI, backup: BACKUP.replace('"extra":{"kept":true}', '"metadata":{"kept":true}'), prePool: POOL },
  malformedAuth: { state: 'QLB_OWNED', owner: V2_OWNER, journal: QLB_OWNED_JOURNAL, auth: '{not-json\n', backup: BACKUP, prePool: POOL },
  absentParent: { state: 'QLB_OWNED', owner: V2_OWNER, journal: QLB_OWNED_JOURNAL, backup: BACKUP, prePool: POOL },
  legacyOwner: { state: 'QLB_OWNED', legacyOwner: '{"owner":"qlb","accounts":[{"provider":"anthropic"}]}\n', journal: '{}', auth: NATIVE_AUTH, pool: POOL },
  legacyRollback: { state: 'QLB_OWNED', legacyOwner: '{"owner":"qlb","accounts":[{"provider":"anthropic"}]}\n', journal: '{}', auth: NATIVE_AUTH, backup: BACKUP, prePool: POOL },
  legacyAbsentParent: { state: 'QLB_OWNED', legacyOwner: '{"owner":"qlb","accounts":[{"provider":"anthropic"}]}\n', journal: '{}', prePool: POOL },
} as const satisfies Record<string, HistoricalPoolArtifact>;

export interface HistoricalPoolPaths {
  owner: string;
  pool: string;
  prePool: string;
  sidecar: string;
  staging: string;
  auth: string;
  backup: string;
  legacyOwner?: string;
}

/** Fails closed rather than manufacturing omitted historical state. */
export function installHistoricalPoolArtifact(
  artifact: HistoricalPoolArtifact,
  paths: HistoricalPoolPaths,
  installJournal: (state: HistoricalPoolState, detail: string) => void,
): void {
  const payloads: Record<HistoricalPoolPayload, string | undefined> = {
    owner: artifact.owner,
    journal: artifact.journal,
    auth: artifact.auth,
    backup: artifact.backup,
    pool: artifact.pool,
    prePool: artifact.prePool,
    sidecar: artifact.sidecar,
    staging: artifact.staging,
    legacyOwner: artifact.legacyOwner,
  };
  const locations: Record<Exclude<HistoricalPoolPayload, 'journal' | 'legacyOwner'>, string> = {
    owner: paths.owner, auth: paths.auth, backup: paths.backup, pool: paths.pool, prePool: paths.prePool, sidecar: paths.sidecar, staging: paths.staging,
  };
  for (const [name, location] of Object.entries(locations) as Array<[Exclude<HistoricalPoolPayload, 'journal' | 'legacyOwner'>, string]>) {
    const payload = payloads[name];
    if (payload === undefined) {
      rmSync(location, { force: true });
      continue;
    }
    mkdirSync(dirname(location), { recursive: true, mode: 0o700 });
    writeFileSync(location, payload.replaceAll('__POOL_PATH__', paths.pool).replaceAll('__OWNER_PATH__', paths.owner).replaceAll('__AUTH_PATH__', paths.auth), { mode: 0o600 });
  }
  if (artifact.legacyOwner !== undefined) {
    if (!paths.legacyOwner) throw new Error('historical Anthropic pool artifact is missing legacy owner path');
    mkdirSync(dirname(paths.legacyOwner), { recursive: true, mode: 0o700 });
    writeFileSync(paths.legacyOwner, artifact.legacyOwner, { mode: 0o600 });
  }
  if (artifact.journal !== undefined) installJournal(artifact.state, artifact.journal.replaceAll('__POOL_PATH__', paths.pool).replaceAll('__OWNER_PATH__', paths.owner));
}
