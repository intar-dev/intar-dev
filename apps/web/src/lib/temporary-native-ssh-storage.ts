import type { SshEd25519KeyPair } from "./ssh-ed25519";

export const TEMPORARY_NATIVE_SSH_STORAGE_PREFIX =
  "intar.native-ssh.temporary.v1:";

const TEMPORARY_NATIVE_SSH_RECORD_VERSION = 1;
const PROVISIONAL_TEMPORARY_NATIVE_SSH_KEY_TTL_MS = 5 * 60_000;
const MAXIMUM_TIMER_DELAY_MS = 2_147_483_647;
const temporaryNativeSshKeyExpiryTimers = new Map<
  string,
  ReturnType<typeof globalThis.setTimeout>
>();

interface TemporaryNativeSshKeyRecord extends SshEd25519KeyPair {
  version: typeof TEMPORARY_NATIVE_SSH_RECORD_VERSION;
  requestScope: string;
  expiresAt: number;
  downloadedAt: number | null;
}

export function buildTemporaryNativeSshRequestScope(input: {
  userId: string;
  url: string;
  bodyJson: string;
}): string {
  const userId = input.userId.trim();
  if (!userId) {
    throw new Error("temporary native SSH storage requires a user ID");
  }
  if (!input.url) {
    throw new Error("temporary native SSH storage requires a request URL");
  }

  // The user identity is part of the scope. A later account in the same tab
  // cannot reuse the prior account's temporary private key.
  return JSON.stringify({
    version: TEMPORARY_NATIVE_SSH_RECORD_VERSION,
    userId,
    url: input.url,
    bodyJson: input.bodyJson,
  });
}

export function loadTemporaryNativeSshKey(
  requestScope: string,
): SshEd25519KeyPair | undefined {
  const storage = getSessionStorage();
  if (!storage) return undefined;

  const storageKey = temporaryNativeSshStorageKey(requestScope);
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) {
      cancelTemporaryNativeSshKeyExpiry(storageKey);
      return undefined;
    }

    const record = parseTemporaryNativeSshKeyRecord(raw, requestScope);
    if (!record || record.expiresAt <= Date.now()) {
      clearTemporaryNativeSshKey(requestScope);
      return undefined;
    }

    scheduleTemporaryNativeSshKeyExpiry(requestScope, record.expiresAt);
    return {
      publicKeyOpenssh: record.publicKeyOpenssh,
      privateKeyOpenssh: record.privateKeyOpenssh,
    };
  } catch {
    clearTemporaryNativeSshKey(requestScope);
    return undefined;
  }
}

export function saveProvisionalTemporaryNativeSshKey(
  requestScope: string,
  keyPair: SshEd25519KeyPair,
): boolean {
  const provisionalExpiresAt =
    Date.now() + PROVISIONAL_TEMPORARY_NATIVE_SSH_KEY_TTL_MS;
  const storage = getSessionStorage();
  const existing = storage
    ? existingTemporaryNativeSshKeyRecord(storage, requestScope)
    : undefined;
  return saveTemporaryNativeSshKey({
    requestScope,
    keyPair,
    expiresAt:
      existing?.publicKeyOpenssh === keyPair.publicKeyOpenssh
        ? Math.max(existing.expiresAt, provisionalExpiresAt)
        : provisionalExpiresAt,
  });
}

export function saveTemporaryNativeSshKey(input: {
  requestScope: string;
  keyPair: SshEd25519KeyPair;
  expiresAt: number;
}): boolean {
  if (
    !isValidTemporaryNativeSshKeyPair(input.keyPair) ||
    !Number.isFinite(input.expiresAt) ||
    input.expiresAt <= Date.now()
  ) {
    clearTemporaryNativeSshKey(input.requestScope);
    return false;
  }

  const storage = getSessionStorage();
  if (!storage) return false;

  const record: TemporaryNativeSshKeyRecord = {
    version: TEMPORARY_NATIVE_SSH_RECORD_VERSION,
    requestScope: input.requestScope,
    expiresAt: input.expiresAt,
    publicKeyOpenssh: input.keyPair.publicKeyOpenssh,
    privateKeyOpenssh: input.keyPair.privateKeyOpenssh,
    downloadedAt: existingDownloadAcknowledgement(
      storage,
      input.requestScope,
      input.keyPair.publicKeyOpenssh,
    ),
  };
  const storageKey = temporaryNativeSshStorageKey(input.requestScope);

  try {
    storage.setItem(storageKey, JSON.stringify(record));
    scheduleTemporaryNativeSshKeyExpiry(input.requestScope, input.expiresAt);
    return true;
  } catch {
    // The native route still works when session storage is disabled. It only
    // loses persistence across a refresh in this browser context.
    return false;
  }
}

export function temporaryNativeSshKeyWasDownloaded(
  requestScope: string,
): boolean {
  const storage = getSessionStorage();
  if (!storage) return false;
  try {
    const raw = storage.getItem(temporaryNativeSshStorageKey(requestScope));
    const record = raw
      ? parseTemporaryNativeSshKeyRecord(raw, requestScope)
      : undefined;
    return Boolean(record?.downloadedAt);
  } catch {
    return false;
  }
}

export function markTemporaryNativeSshKeyDownloaded(
  requestScope: string,
): boolean {
  const storage = getSessionStorage();
  if (!storage) return false;
  const storageKey = temporaryNativeSshStorageKey(requestScope);
  try {
    const raw = storage.getItem(storageKey);
    const record = raw
      ? parseTemporaryNativeSshKeyRecord(raw, requestScope)
      : undefined;
    if (!record || record.expiresAt <= Date.now()) return false;
    storage.setItem(
      storageKey,
      JSON.stringify({ ...record, downloadedAt: Date.now() }),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearTemporaryNativeSshKey(requestScope: string): void {
  const storageKey = temporaryNativeSshStorageKey(requestScope);
  cancelTemporaryNativeSshKeyExpiry(storageKey);

  const storage = getSessionStorage();
  if (!storage) return;
  try {
    storage.removeItem(storageKey);
  } catch {
    // Storage can be blocked in restrictive browser contexts.
  }
}

export function clearAllTemporaryNativeSshKeys(): void {
  for (const storageKey of [...temporaryNativeSshKeyExpiryTimers.keys()]) {
    if (storageKey.startsWith(TEMPORARY_NATIVE_SSH_STORAGE_PREFIX)) {
      cancelTemporaryNativeSshKeyExpiry(storageKey);
    }
  }

  const storage = getSessionStorage();
  if (!storage) return;

  const storageKeys: string[] = [];
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const storageKey = storage.key(index);
      if (storageKey?.startsWith(TEMPORARY_NATIVE_SSH_STORAGE_PREFIX)) {
        storageKeys.push(storageKey);
      }
    }
  } catch {
    return;
  }

  for (const storageKey of storageKeys) {
    try {
      storage.removeItem(storageKey);
    } catch {
      // Try every matching key even if one removal is denied.
    }
  }
}

function temporaryNativeSshStorageKey(requestScope: string): string {
  return `${TEMPORARY_NATIVE_SSH_STORAGE_PREFIX}${encodeURIComponent(requestScope)}`;
}

function scheduleTemporaryNativeSshKeyExpiry(
  requestScope: string,
  expiresAt: number,
): void {
  if (typeof window === "undefined") return;

  const storageKey = temporaryNativeSshStorageKey(requestScope);
  cancelTemporaryNativeSshKeyExpiry(storageKey);

  const delay = Math.max(0, expiresAt - Date.now());
  const timer = globalThis.setTimeout(
    () => {
      temporaryNativeSshKeyExpiryTimers.delete(storageKey);
      if (delay > MAXIMUM_TIMER_DELAY_MS) {
        scheduleTemporaryNativeSshKeyExpiry(requestScope, expiresAt);
        return;
      }
      expireTemporaryNativeSshKey(requestScope, expiresAt);
    },
    Math.min(delay, MAXIMUM_TIMER_DELAY_MS),
  );
  temporaryNativeSshKeyExpiryTimers.set(storageKey, timer);
}

function expireTemporaryNativeSshKey(
  requestScope: string,
  expectedExpiresAt: number,
): void {
  const storage = getSessionStorage();
  if (!storage) return;

  const storageKey = temporaryNativeSshStorageKey(requestScope);
  try {
    const raw = storage.getItem(storageKey);
    const record = raw
      ? parseTemporaryNativeSshKeyRecord(raw, requestScope)
      : undefined;
    if (!record || record.expiresAt <= Date.now()) {
      storage.removeItem(storageKey);
      return;
    }

    // A newer response can extend this key while an earlier timer is queued.
    // Do not remove the newer record.
    if (record.expiresAt !== expectedExpiresAt) {
      scheduleTemporaryNativeSshKeyExpiry(requestScope, record.expiresAt);
    }
  } catch {
    // Storage can be blocked after a timer has already been scheduled.
  }
}

function cancelTemporaryNativeSshKeyExpiry(storageKey: string): void {
  const timer = temporaryNativeSshKeyExpiryTimers.get(storageKey);
  if (timer === undefined) return;
  globalThis.clearTimeout(timer);
  temporaryNativeSshKeyExpiryTimers.delete(storageKey);
}

function getSessionStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function parseTemporaryNativeSshKeyRecord(
  raw: string,
  requestScope: string,
): TemporaryNativeSshKeyRecord | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value)) return undefined;
    if (
      value.version !== TEMPORARY_NATIVE_SSH_RECORD_VERSION ||
      value.requestScope !== requestScope ||
      typeof value.expiresAt !== "number" ||
      !Number.isFinite(value.expiresAt) ||
      !isValidTemporaryNativeSshKeyPair(value)
    ) {
      return undefined;
    }
    return {
      version: TEMPORARY_NATIVE_SSH_RECORD_VERSION,
      requestScope,
      expiresAt: value.expiresAt,
      publicKeyOpenssh: value.publicKeyOpenssh,
      privateKeyOpenssh: value.privateKeyOpenssh,
      downloadedAt:
        typeof value.downloadedAt === "number" &&
        Number.isFinite(value.downloadedAt)
          ? value.downloadedAt
          : null,
    };
  } catch {
    return undefined;
  }
}

function existingDownloadAcknowledgement(
  storage: Storage,
  requestScope: string,
  publicKeyOpenssh: string,
): number | null {
  const existing = existingTemporaryNativeSshKeyRecord(storage, requestScope);
  return existing?.publicKeyOpenssh === publicKeyOpenssh
    ? existing.downloadedAt
    : null;
}

function existingTemporaryNativeSshKeyRecord(
  storage: Storage,
  requestScope: string,
): TemporaryNativeSshKeyRecord | undefined {
  try {
    const raw = storage.getItem(temporaryNativeSshStorageKey(requestScope));
    return raw ? parseTemporaryNativeSshKeyRecord(raw, requestScope) : undefined;
  } catch {
    return undefined;
  }
}

function isValidTemporaryNativeSshKeyPair(
  value: unknown,
): value is SshEd25519KeyPair {
  return (
    isRecord(value) &&
    typeof value.publicKeyOpenssh === "string" &&
    value.publicKeyOpenssh.startsWith("ssh-ed25519 ") &&
    typeof value.privateKeyOpenssh === "string" &&
    value.privateKeyOpenssh.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----") &&
    value.privateKeyOpenssh.includes("-----END OPENSSH PRIVATE KEY-----")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
