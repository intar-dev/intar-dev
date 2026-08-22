#!/usr/bin/env bun

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CloudflareD1RestClient,
  type D1Statement,
  type D1StatementResult,
  type D1Value,
  type D1WriteClient,
} from "./d1-rest-client";

const ENVELOPE_VERSION = "v1";
const AAD_PREFIX = "intar:oidc-sso-secret:v1";
const PAGE_SIZE = 100;
const MAX_CONFIG_BYTES = 64 * 1024;
const MAX_CLIENT_SECRET_BYTES = 4 * 1024;
const MAX_CIPHERTEXT_BYTES = 8 * 1024;
const MAX_ID_BYTES = 1024;

const READ_OIDC_PROVIDERS_SQL = `
  SELECT id, provider_id, organization_id, oidc_config,
         oidc_client_secret_ciphertext
  FROM sso_provider
  WHERE oidc_config IS NOT NULL
    AND id > ?
  ORDER BY id
  LIMIT ?`;

const WRITE_CIPHERTEXT_SQL = `
  UPDATE sso_provider
  SET oidc_client_secret_ciphertext = ?
  WHERE id = ?
    AND provider_id = ?
    AND organization_id IS ?
    AND oidc_config = ?
    AND oidc_client_secret_ciphertext IS NULL`;

const REMOVE_PLAINTEXT_SQL = `
  UPDATE sso_provider
  SET oidc_config = ?
  WHERE id = ?
    AND provider_id = ?
    AND organization_id IS ?
    AND oidc_config = ?
    AND oidc_client_secret_ciphertext = ?`;

export const OIDC_SECRET_MIGRATION_CONFIRMATIONS = {
  plan: "PLAN OIDC SECRET MIGRATION",
  backfill: "BACKFILL OIDC SECRET MIGRATION",
  cleanup: "CLEANUP OIDC SECRET MIGRATION",
} as const;

export type OidcSecretMigrationOperation =
  keyof typeof OIDC_SECRET_MIGRATION_CONFIRMATIONS;

export type OidcSecretMigrationStatus =
  | "ready"
  | "completed"
  | "blocked"
  | "incomplete";

export interface OidcSecretMigrationCounts {
  readonly scanned: number;
  readonly plaintextPresent: number;
  readonly ciphertextPresent: number;
  readonly ciphertextValid: number;
  readonly ciphertextInvalid: number;
  readonly plaintextOnly: number;
  readonly dualWritten: number;
  readonly ciphertextOnly: number;
  readonly missingSecretMaterial: number;
  readonly configInvalid: number;
  readonly secretMismatch: number;
  readonly writesApplied: number;
  readonly casConflicts: number;
}

export interface OidcSecretMigrationEvidence {
  readonly version: 1;
  readonly operation: OidcSecretMigrationOperation;
  readonly status: OidcSecretMigrationStatus;
  readonly counts: OidcSecretMigrationCounts;
}

export interface OidcSecretMigrationCliOptions {
  readonly operation: OidcSecretMigrationOperation;
  readonly countsOutputPath: string;
}

interface OidcProviderRow {
  readonly id: string;
  readonly providerId: string;
  readonly organizationId: string | null;
  readonly oidcConfig: string;
  readonly ciphertext: string | null;
}

interface OidcProviderAnalysis {
  readonly row: OidcProviderRow;
  readonly config: Record<string, unknown> | null;
  readonly plaintext: string | null;
  readonly ciphertextState: "missing" | "valid" | "invalid";
  readonly ciphertextPlaintext: string | null;
  readonly dualWriteMatches: boolean;
}

interface MigrationAnalysis {
  readonly rows: readonly OidcProviderAnalysis[];
  readonly counts: OidcSecretMigrationCounts;
}

interface EnvironmentSettings {
  readonly accountId: string;
  readonly databaseId: string;
  readonly token: string;
  readonly encryptionKey: string;
}

class OidcSecretMigrationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OidcSecretMigrationError";
  }
}

/**
 * Parses the deliberately small CLI surface. Credentials and key material are
 * only read from the environment, never command line arguments.
 */
export function parseOidcSecretMigrationArguments(
  args: readonly string[],
): OidcSecretMigrationCliOptions {
  let operation: OidcSecretMigrationOperation | undefined;
  let countsOutputPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new OidcSecretMigrationError(
        "oidc_secret_migration_usage_error",
      );
    }
    index += 1;
    switch (argument) {
      case "--operation":
        if (!isOperation(value) || operation !== undefined) {
          throw new OidcSecretMigrationError(
            "oidc_secret_migration_usage_error",
          );
        }
        operation = value;
        break;
      case "--counts-output":
        if (!value || countsOutputPath !== undefined) {
          throw new OidcSecretMigrationError(
            "oidc_secret_migration_usage_error",
          );
        }
        countsOutputPath = resolve(value);
        break;
      default:
        throw new OidcSecretMigrationError("oidc_secret_migration_usage_error");
    }
  }

  if (!operation || !countsOutputPath) {
    throw new OidcSecretMigrationError("oidc_secret_migration_usage_error");
  }
  return { operation, countsOutputPath };
}

export function requiredOidcMigrationEnvironment(
  environment: Record<string, string | undefined> = process.env,
): EnvironmentSettings {
  return {
    accountId: requiredEnvironment(environment, "CLOUDFLARE_ACCOUNT_ID"),
    databaseId: requiredEnvironment(environment, "CLOUDFLARE_DATABASE_ID"),
    token: requiredEnvironment(environment, "CLOUDFLARE_API_TOKEN"),
    encryptionKey: requiredEnvironment(
      environment,
      "OIDC_SSO_CONFIG_ENCRYPTION_KEY_V1",
    ),
  };
}

export function requireOidcMigrationConfirmation(
  operation: OidcSecretMigrationOperation,
  environment: Record<string, string | undefined> = process.env,
): void {
  if (
    environment.OIDC_MIGRATION_CONFIRMATION !==
    OIDC_SECRET_MIGRATION_CONFIRMATIONS[operation]
  ) {
    throw new OidcSecretMigrationError(
      "oidc_secret_migration_confirmation_required",
    );
  }
}

export async function importOidcSecretMigrationKey(
  encodedKey: string,
): Promise<CryptoKey> {
  const key = decodeBase64Url(encodedKey);
  if (!key || key.byteLength !== 32) {
    throw new OidcSecretMigrationError("oidc_secret_migration_key_invalid");
  }
  try {
    return await crypto.subtle.importKey(
      "raw",
      copyArrayBuffer(key),
      "AES-GCM",
      false,
      ["encrypt", "decrypt"],
    );
  } catch {
    throw new OidcSecretMigrationError("oidc_secret_migration_key_invalid");
  }
}

export function oidcSecretMigrationAad(input: {
  id: string;
  providerId: string;
  organizationId: string | null;
}): Uint8Array {
  return new TextEncoder().encode(
    `${AAD_PREFIX}\0${input.id}\0${input.providerId}\0${input.organizationId ?? ""}`,
  );
}

export async function encryptOidcClientSecret(input: {
  readonly encryptionKey: CryptoKey;
  readonly id: string;
  readonly providerId: string;
  readonly organizationId: string | null;
  readonly secret: string;
  readonly randomValues?: (values: Uint8Array) => Uint8Array;
}): Promise<string> {
  if (new TextEncoder().encode(input.secret).byteLength > MAX_CLIENT_SECRET_BYTES) {
    throw new OidcSecretMigrationError(
      "oidc_secret_migration_secret_invalid",
    );
  }
  const iv = new Uint8Array(12);
  if (input.randomValues) input.randomValues(iv);
  else crypto.getRandomValues(iv);
  try {
    const ciphertext = await crypto.subtle.encrypt(
      {
        name: "AES-GCM",
        iv: copyArrayBuffer(iv),
        additionalData: copyArrayBuffer(oidcSecretMigrationAad(input)),
      },
      input.encryptionKey,
      copyArrayBuffer(new TextEncoder().encode(input.secret)),
    );
    return `${ENVELOPE_VERSION}.${encodeBase64Url(iv)}.${encodeBase64Url(new Uint8Array(ciphertext))}`;
  } catch {
    throw new OidcSecretMigrationError(
      "oidc_secret_migration_encryption_failed",
    );
  }
}

export async function decryptOidcClientSecret(input: {
  readonly encryptionKey: CryptoKey;
  readonly id: string;
  readonly providerId: string;
  readonly organizationId: string | null;
  readonly ciphertext: string;
}): Promise<string | null> {
  const envelope = parseEnvelope(input.ciphertext);
  if (!envelope) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: copyArrayBuffer(envelope.iv),
        additionalData: copyArrayBuffer(oidcSecretMigrationAad(input)),
      },
      input.encryptionKey,
      copyArrayBuffer(envelope.ciphertext),
    );
    return new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
  } catch {
    return null;
  }
}

export async function runOidcSecretMigration(input: {
  readonly client: D1WriteClient;
  readonly operation: OidcSecretMigrationOperation;
  readonly encryptionKey: CryptoKey;
}): Promise<OidcSecretMigrationEvidence> {
  const before = await analyzeOidcProviders(input.client, input.encryptionKey);
  if (input.operation === "plan") {
    return evidence(
      input.operation,
      hasIntegrityFailure(before.counts) ? "blocked" : "ready",
      before.counts,
    );
  }

  if (isBlockedForOperation(input.operation, before.counts)) {
    return evidence(input.operation, "blocked", before.counts);
  }

  let writesApplied = 0;
  let casConflicts = 0;
  for (const analysis of writeTargets(input.operation, before.rows)) {
    const applied = await applyOperation({
      client: input.client,
      operation: input.operation,
      encryptionKey: input.encryptionKey,
      analysis,
    });
    if (applied) writesApplied += 1;
    else casConflicts += 1;
  }

  const after = await analyzeOidcProviders(input.client, input.encryptionKey);
  const counts = {
    ...after.counts,
    writesApplied,
    casConflicts,
  };
  if (hasIntegrityFailure(counts)) {
    return evidence(input.operation, "blocked", counts);
  }
  if (casConflicts > 0 || writeTargets(input.operation, after.rows).length > 0) {
    return evidence(input.operation, "incomplete", counts);
  }
  return evidence(input.operation, "completed", counts);
}

export function writeOidcMigrationEvidence(
  path: string,
  migrationEvidence: OidcSecretMigrationEvidence,
): void {
  try {
    writeFileSync(path, `${JSON.stringify(migrationEvidence)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    throw new OidcSecretMigrationError(
      "oidc_secret_migration_counts_output_unavailable",
    );
  }
}

async function executeCli(): Promise<void> {
  try {
    const options = parseOidcSecretMigrationArguments(process.argv.slice(2));
    requireOidcMigrationConfirmation(options.operation);
    const settings = requiredOidcMigrationEnvironment();
    const encryptionKey = await importOidcSecretMigrationKey(
      settings.encryptionKey,
    );
    const client = new CloudflareD1RestClient({
      accountId: settings.accountId,
      databaseId: settings.databaseId,
      token: settings.token,
    });
    const migrationEvidence = await runOidcSecretMigration({
      client,
      operation: options.operation,
      encryptionKey,
    });
    writeOidcMigrationEvidence(options.countsOutputPath, migrationEvidence);
    console.log(JSON.stringify(migrationEvidence));
    if (
      migrationEvidence.status !== "ready" &&
      migrationEvidence.status !== "completed"
    ) {
      process.exitCode = 1;
    }
  } catch {
    // Never expose a D1 row, OIDC config, envelope, or plaintext secret.
    console.error("oidc_secret_migration_failed");
    process.exitCode = 1;
  }
}

async function analyzeOidcProviders(
  client: D1WriteClient,
  encryptionKey: CryptoKey,
): Promise<MigrationAnalysis> {
  const rows = await readOidcProviderRows(client);
  const analyzed: OidcProviderAnalysis[] = [];
  for (const row of rows) {
    analyzed.push(await analyzeOidcProvider(row, encryptionKey));
  }
  return {
    rows: analyzed,
    counts: countsFor(analyzed),
  };
}

async function readOidcProviderRows(
  client: D1WriteClient,
): Promise<readonly OidcProviderRow[]> {
  const rows: OidcProviderRow[] = [];
  let cursor = "";
  while (true) {
    const result = await safeQuery(client, READ_OIDC_PROVIDERS_SQL, [
      cursor,
      PAGE_SIZE,
    ]);
    if (result.rows.length === 0) break;
    for (const rawRow of result.rows) {
      const row = parseOidcProviderRow(rawRow);
      if (row.id <= cursor) {
        throw new OidcSecretMigrationError(
          "oidc_secret_migration_database_row_invalid",
        );
      }
      rows.push(row);
      cursor = row.id;
    }
    if (result.rows.length < PAGE_SIZE) break;
  }
  return rows;
}

async function analyzeOidcProvider(
  row: OidcProviderRow,
  encryptionKey: CryptoKey,
): Promise<OidcProviderAnalysis> {
  const config = parseOidcConfig(row.oidcConfig);
  if (!config) {
    return {
      row,
      config: null,
      plaintext: null,
      ciphertextState: row.ciphertext === null ? "missing" : "invalid",
      ciphertextPlaintext: null,
      dualWriteMatches: false,
    };
  }

  const secretValue = config.clientSecret;
  const plaintext =
    secretValue === undefined
      ? null
      : typeof secretValue === "string" &&
          new TextEncoder().encode(secretValue).byteLength <=
            MAX_CLIENT_SECRET_BYTES
        ? secretValue
        : null;
  const configHasInvalidSecret = secretValue !== undefined && plaintext === null;
  if (configHasInvalidSecret) {
    return {
      row,
      config: null,
      plaintext: null,
      ciphertextState: row.ciphertext === null ? "missing" : "invalid",
      ciphertextPlaintext: null,
      dualWriteMatches: false,
    };
  }

  if (row.ciphertext === null) {
    return {
      row,
      config,
      plaintext,
      ciphertextState: "missing",
      ciphertextPlaintext: null,
      dualWriteMatches: false,
    };
  }
  const ciphertextPlaintext = await decryptOidcClientSecret({
    encryptionKey,
    id: row.id,
    providerId: row.providerId,
    organizationId: row.organizationId,
    ciphertext: row.ciphertext,
  });
  return {
    row,
    config,
    plaintext,
    ciphertextState: ciphertextPlaintext === null ? "invalid" : "valid",
    ciphertextPlaintext,
    dualWriteMatches:
      plaintext !== null &&
      ciphertextPlaintext !== null &&
      constantTimeEqual(plaintext, ciphertextPlaintext),
  };
}

function countsFor(rows: readonly OidcProviderAnalysis[]): OidcSecretMigrationCounts {
  const counts: {
    -readonly [Key in keyof OidcSecretMigrationCounts]: number;
  } = {
    scanned: rows.length,
    plaintextPresent: 0,
    ciphertextPresent: 0,
    ciphertextValid: 0,
    ciphertextInvalid: 0,
    plaintextOnly: 0,
    dualWritten: 0,
    ciphertextOnly: 0,
    missingSecretMaterial: 0,
    configInvalid: 0,
    secretMismatch: 0,
    writesApplied: 0,
    casConflicts: 0,
  };
  for (const row of rows) {
    if (row.config === null) {
      counts.configInvalid += 1;
      continue;
    }
    if (row.plaintext !== null) counts.plaintextPresent += 1;
    if (row.row.ciphertext !== null) counts.ciphertextPresent += 1;
    if (row.ciphertextState === "valid") counts.ciphertextValid += 1;
    if (row.ciphertextState === "invalid") counts.ciphertextInvalid += 1;
    if (row.plaintext !== null && row.ciphertextState === "missing") {
      counts.plaintextOnly += 1;
    }
    if (row.plaintext === null && row.ciphertextState === "valid") {
      counts.ciphertextOnly += 1;
    }
    if (
      row.plaintext !== null &&
      row.ciphertextState === "valid" &&
      row.dualWriteMatches
    ) {
      counts.dualWritten += 1;
    }
    if (row.plaintext === null && row.ciphertextState === "missing") {
      counts.missingSecretMaterial += 1;
    }
    if (
      row.plaintext !== null &&
      row.ciphertextState === "valid" &&
      !row.dualWriteMatches
    ) {
      counts.secretMismatch += 1;
    }
  }
  return counts;
}

function hasIntegrityFailure(counts: OidcSecretMigrationCounts): boolean {
  return (
    counts.ciphertextInvalid > 0 ||
    counts.missingSecretMaterial > 0 ||
    counts.configInvalid > 0 ||
    counts.secretMismatch > 0
  );
}

function isBlockedForOperation(
  operation: Exclude<OidcSecretMigrationOperation, "plan">,
  counts: OidcSecretMigrationCounts,
): boolean {
  if (hasIntegrityFailure(counts)) return true;
  return operation === "cleanup" && counts.plaintextOnly > 0;
}

function writeTargets(
  operation: Exclude<OidcSecretMigrationOperation, "plan">,
  rows: readonly OidcProviderAnalysis[],
): readonly OidcProviderAnalysis[] {
  switch (operation) {
    case "backfill":
      return rows.filter(
        (row) => row.config !== null && row.plaintext !== null && row.ciphertextState === "missing",
      );
    case "cleanup":
      return rows.filter(
        (row) =>
          row.config !== null &&
          row.plaintext !== null &&
          row.ciphertextState === "valid" &&
          row.dualWriteMatches,
      );
  }
}

async function applyOperation(input: {
  readonly client: D1WriteClient;
  readonly operation: Exclude<OidcSecretMigrationOperation, "plan">;
  readonly encryptionKey: CryptoKey;
  readonly analysis: OidcProviderAnalysis;
}): Promise<boolean> {
  const { analysis, operation } = input;
  if (operation === "backfill") {
    if (analysis.plaintext === null) {
      throw new OidcSecretMigrationError(
        "oidc_secret_migration_precondition_failed",
      );
    }
    const ciphertext = await encryptOidcClientSecret({
      encryptionKey: input.encryptionKey,
      ...analysis.row,
      secret: analysis.plaintext,
    });
    return guardedWrite(input.client, {
      sql: WRITE_CIPHERTEXT_SQL,
      params: [
        ciphertext,
        analysis.row.id,
        analysis.row.providerId,
        analysis.row.organizationId,
        analysis.row.oidcConfig,
      ],
    });
  }

  if (analysis.config === null || analysis.row.ciphertext === null) {
    throw new OidcSecretMigrationError(
      "oidc_secret_migration_precondition_failed",
    );
  }
  const nextConfig = withoutClientSecret(analysis.config);
  return guardedWrite(input.client, {
    sql: REMOVE_PLAINTEXT_SQL,
    params: [
      nextConfig,
      analysis.row.id,
      analysis.row.providerId,
      analysis.row.organizationId,
      analysis.row.oidcConfig,
      analysis.row.ciphertext,
    ],
  });
}

async function guardedWrite(
  client: D1WriteClient,
  statement: D1Statement,
): Promise<boolean> {
  let result: readonly D1StatementResult[];
  try {
    // CloudflareD1RestClient intentionally does not retry batch writes: a
    // dropped response can be ambiguous. The guards make a later rerun safe.
    result = await client.batch([statement]);
  } catch {
    throw new OidcSecretMigrationError(
      "oidc_secret_migration_database_failure",
    );
  }
  const changes = result[0]?.changes;
  if (changes === 1) return true;
  if (changes === 0) return false;
  throw new OidcSecretMigrationError("oidc_secret_migration_database_failure");
}

async function safeQuery(
  client: D1WriteClient,
  sql: string,
  params: readonly D1Value[],
): Promise<D1StatementResult> {
  try {
    return await client.query(sql, params);
  } catch {
    throw new OidcSecretMigrationError(
      "oidc_secret_migration_database_failure",
    );
  }
}

function parseOidcProviderRow(raw: Record<string, D1Value>): OidcProviderRow {
  const id = raw.id;
  const providerId = raw.provider_id;
  const organizationId = raw.organization_id;
  const oidcConfig = raw.oidc_config;
  const ciphertext = raw.oidc_client_secret_ciphertext;
  if (
    !validIdentifier(id) ||
    !validIdentifier(providerId) ||
    (organizationId !== null && !validIdentifier(organizationId)) ||
    typeof oidcConfig !== "string" ||
    (ciphertext !== null && typeof ciphertext !== "string")
  ) {
    throw new OidcSecretMigrationError(
      "oidc_secret_migration_database_row_invalid",
    );
  }
  return {
    id,
    providerId,
    organizationId,
    oidcConfig,
    ciphertext,
  };
}

function parseOidcConfig(value: string): Record<string, unknown> | null {
  if (new TextEncoder().encode(value).byteLength > MAX_CONFIG_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function withoutClientSecret(config: Record<string, unknown>): string {
  const next = { ...config };
  delete next.clientSecret;
  return JSON.stringify(next);
}

function parseEnvelope(
  value: string,
): { readonly iv: Uint8Array; readonly ciphertext: Uint8Array } | null {
  if (new TextEncoder().encode(value).byteLength > MAX_CIPHERTEXT_BYTES) {
    return null;
  }
  const [version, encodedIv, encodedCiphertext, extra] = value.split(".");
  if (
    version !== ENVELOPE_VERSION ||
    !encodedIv ||
    !encodedCiphertext ||
    extra !== undefined
  ) {
    return null;
  }
  const iv = decodeBase64Url(encodedIv);
  const ciphertext = decodeBase64Url(encodedCiphertext);
  if (!iv || iv.byteLength !== 12 || !ciphertext || ciphertext.byteLength < 16) {
    return null;
  }
  return { iv, ciphertext };
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const remainder = value.length % 4;
  if (remainder === 1) return null;
  try {
    const binary = atob(
      value.replaceAll("-", "+").replaceAll("_", "/") +
        "=".repeat((4 - remainder) % 4),
    );
    const decoded = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return encodeBase64Url(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function copyArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  let difference = leftBytes.byteLength ^ rightBytes.byteLength;
  const length = Math.max(leftBytes.byteLength, rightBytes.byteLength);
  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }
  return difference === 0;
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    new TextEncoder().encode(value).byteLength <= MAX_ID_BYTES
  );
}

function requiredEnvironment(
  environment: Record<string, string | undefined>,
  name: string,
): string {
  const value = environment[name]?.trim();
  if (!value) {
    throw new OidcSecretMigrationError(
      "oidc_secret_migration_environment_invalid",
    );
  }
  return value;
}

function evidence(
  operation: OidcSecretMigrationOperation,
  status: OidcSecretMigrationStatus,
  counts: OidcSecretMigrationCounts,
): OidcSecretMigrationEvidence {
  return { version: 1, operation, status, counts };
}

function isOperation(value: string): value is OidcSecretMigrationOperation {
  return Object.hasOwn(OIDC_SECRET_MIGRATION_CONFIRMATIONS, value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) await executeCli();
