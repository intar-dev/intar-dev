import { describe, expect, test } from "bun:test";
import type {
  D1Statement,
  D1StatementResult,
  D1Value,
  D1WriteClient,
} from "./d1-rest-client";
import {
  OIDC_SECRET_MIGRATION_CONFIRMATIONS,
  decryptOidcClientSecret,
  encryptOidcClientSecret,
  importOidcSecretMigrationKey,
  oidcSecretMigrationAad,
  parseOidcSecretMigrationArguments,
  requiredOidcMigrationEnvironment,
  requireOidcMigrationConfirmation,
  runOidcSecretMigration,
  writeOidcMigrationEvidence,
} from "./oidc-secret-migration";

type StoredRow = {
  id: string;
  providerId: string;
  organizationId: string | null;
  oidcConfig: string;
  ciphertext: string | null;
};

describe("OIDC secret migration", () => {
  test("plans using counts only and never serializes OIDC data", async () => {
    const secret = "plan-secret-never-output";
    const rows = [legacyRow("row-plan", "provider-plan", "org-plan", secret)];
    const client = new FakeD1Client(rows);
    const key = await testKey();

    const result = await runOidcSecretMigration({
      client,
      operation: "plan",
      encryptionKey: key,
    });

    expect(result).toEqual({
      version: 1,
      operation: "plan",
      status: "ready",
      counts: expect.objectContaining({
        scanned: 1,
        plaintextPresent: 1,
        plaintextOnly: 1,
        ciphertextPresent: 0,
        writesApplied: 0,
        casConflicts: 0,
      }),
    });
    expect(client.writeAttempts).toBe(0);
    const output = JSON.stringify(result);
    for (const forbidden of [
      secret,
      "row-plan",
      "provider-plan",
      "org-plan",
      rows[0]!.oidcConfig,
    ]) {
      expect(output).not.toContain(forbidden);
    }
  });

  test("backfill and cleanup are idempotent and preserve the encrypted envelope", async () => {
    const secret = "round-trip-secret";
    const rows = [legacyRow("row-round-trip", "provider-round-trip", "org-round-trip", secret)];
    const client = new FakeD1Client(rows);
    const key = await testKey();

    const backfill = await runOidcSecretMigration({
      client,
      operation: "backfill",
      encryptionKey: key,
    });
    expect(backfill.status).toBe("completed");
    expect(backfill.counts.writesApplied).toBe(1);
    expect(client.rows[0]!.ciphertext).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
    expect(client.rows[0]!.oidcConfig).toContain(secret);

    const repeatedBackfill = await runOidcSecretMigration({
      client,
      operation: "backfill",
      encryptionKey: key,
    });
    expect(repeatedBackfill).toMatchObject({
      status: "completed",
      counts: { writesApplied: 0, dualWritten: 1 },
    });

    const cleanup = await runOidcSecretMigration({
      client,
      operation: "cleanup",
      encryptionKey: key,
    });
    expect(cleanup).toMatchObject({
      status: "completed",
      counts: { writesApplied: 1, ciphertextOnly: 1 },
    });
    expect(client.rows[0]!.oidcConfig).not.toContain("clientSecret");
    expect(client.rows[0]!.oidcConfig).not.toContain(secret);

    const repeatedCleanup = await runOidcSecretMigration({
      client,
      operation: "cleanup",
      encryptionKey: key,
    });
    expect(repeatedCleanup).toMatchObject({
      status: "completed",
      counts: { writesApplied: 0, ciphertextOnly: 1 },
    });

  });

  test("can resume after an ambiguous partial backfill without leaking the backend error", async () => {
    const secret = "partial-secret-never-output";
    const client = new FakeD1Client([
      legacyRow("row-1", "provider-1", "org-1", secret),
      legacyRow("row-2", "provider-2", "org-2", secret),
    ]);
    const key = await testKey();
    client.throwAfterWriteAttempt = 1;
    client.throwMessage = `backend observed ${secret}`;

    const failed = runOidcSecretMigration({
      client,
      operation: "backfill",
      encryptionKey: key,
    });
    await expect(failed).rejects.toThrow("oidc_secret_migration_database_failure");
    await expect(failed).rejects.not.toThrow(secret);
    expect(client.rows[0]!.ciphertext).not.toBeNull();
    expect(client.rows[1]!.ciphertext).toBeNull();

    client.throwAfterWriteAttempt = undefined;
    const retry = await runOidcSecretMigration({
      client,
      operation: "backfill",
      encryptionKey: key,
    });
    expect(retry).toMatchObject({
      status: "completed",
      counts: { dualWritten: 2, writesApplied: 1 },
    });
  });

  test("uses CAS guards and reports concurrent changes without overwriting them", async () => {
    const secret = "cas-secret";
    const client = new FakeD1Client([
      legacyRow("row-cas", "provider-cas", "org-cas", secret),
    ]);
    const key = await testKey();
    client.beforeFirstWrite = () => {
      client.rows[0]!.oidcConfig = JSON.stringify({
        clientId: "client",
        clientSecret: "different-secret",
      });
    };

    const result = await runOidcSecretMigration({
      client,
      operation: "backfill",
      encryptionKey: key,
    });

    expect(result).toMatchObject({
      status: "incomplete",
      counts: {
        casConflicts: 1,
        writesApplied: 0,
        plaintextOnly: 1,
      },
    });
    expect(client.rows[0]!.ciphertext).toBeNull();
    expect(parseConfig(client.rows[0]!.oidcConfig).clientSecret).toBe(
      "different-secret",
    );
  });

  test("fails closed on a tampered envelope and makes no cleanup write", async () => {
    const secret = "tamper-secret-never-output";
    const row = legacyRow("row-tamper", "provider-tamper", "org-tamper", secret);
    const key = await testKey();
    const envelope = await encryptOidcClientSecret({
      encryptionKey: key,
      id: row.id,
      providerId: row.providerId,
      organizationId: row.organizationId,
      secret,
      randomValues: deterministicRandomValues,
    });
    row.ciphertext = `${envelope.slice(0, -1)}${envelope.endsWith("A") ? "B" : "A"}`;
    const client = new FakeD1Client([row]);

    const plan = await runOidcSecretMigration({
      client,
      operation: "plan",
      encryptionKey: key,
    });
    expect(plan).toMatchObject({
      status: "blocked",
      counts: { ciphertextInvalid: 1, writesApplied: 0 },
    });

    const cleanup = await runOidcSecretMigration({
      client,
      operation: "cleanup",
      encryptionKey: key,
    });
    expect(cleanup).toMatchObject({
      status: "blocked",
      counts: { ciphertextInvalid: 1, writesApplied: 0 },
    });
    expect(client.writeAttempts).toBe(0);
    const output = JSON.stringify(cleanup);
    expect(output).not.toContain(secret);
    expect(output).not.toContain(row.ciphertext);
  });

  test("binds ciphertext to the exact row, provider, and organization", async () => {
    const key = await testKey();
    const envelope = await encryptOidcClientSecret({
      encryptionKey: key,
      id: "row-a",
      providerId: "provider-a",
      organizationId: "organization-a",
      secret: "bound-secret",
      randomValues: deterministicRandomValues,
    });
    await expect(
      decryptOidcClientSecret({
        encryptionKey: key,
        id: "row-a",
        providerId: "provider-a",
        organizationId: "organization-a",
        ciphertext: envelope,
      }),
    ).resolves.toBe("bound-secret");
    await expect(
      decryptOidcClientSecret({
        encryptionKey: key,
        id: "row-b",
        providerId: "provider-a",
        organizationId: "organization-a",
        ciphertext: envelope,
      }),
    ).resolves.toBeNull();
    expect(new TextDecoder().decode(oidcSecretMigrationAad({
      id: "row-a",
      providerId: "provider-a",
      organizationId: null,
    }))).toBe("intar:oidc-sso-secret:v1\0row-a\0provider-a\0");
  });

  test("requires env-only credentials and exact operation confirmation", async () => {
    const environment = {
      CLOUDFLARE_ACCOUNT_ID: "account",
      CLOUDFLARE_DATABASE_ID: "database",
      CLOUDFLARE_API_TOKEN: "api-token-never-output",
      OIDC_SSO_CONFIG_ENCRYPTION_KEY_V1: encodedTestKey(),
      OIDC_MIGRATION_CONFIRMATION:
        OIDC_SECRET_MIGRATION_CONFIRMATIONS.cleanup,
    };
    expect(requiredOidcMigrationEnvironment(environment)).toEqual({
      accountId: "account",
      databaseId: "database",
      token: "api-token-never-output",
      encryptionKey: encodedTestKey(),
    });
    expect(() =>
      requireOidcMigrationConfirmation("cleanup", environment),
    ).not.toThrow();
    expect(() =>
      requireOidcMigrationConfirmation("backfill", environment),
    ).toThrow("oidc_secret_migration_confirmation_required");
    expect(
      parseOidcSecretMigrationArguments([
        "--operation",
        "backfill",
        "--counts-output",
        "counts.json",
      ]),
    ).toMatchObject({ operation: "backfill" });
    expect(() =>
      parseOidcSecretMigrationArguments([
        "--operation",
        "backfill",
        "--database-id",
        "database",
      ]),
    ).toThrow("oidc_secret_migration_usage_error");
    await expect(importOidcSecretMigrationKey(` ${encodedTestKey()}`)).rejects.toThrow(
      "oidc_secret_migration_key_invalid",
    );
  });

  test("writes opaque count evidence without rows, configs, or envelopes", async () => {
    const secret = "evidence-secret-never-output";
    const client = new FakeD1Client([
      legacyRow("row-evidence", "provider-evidence", "org-evidence", secret),
    ]);
    const evidence = await runOidcSecretMigration({
      client,
      operation: "plan",
      encryptionKey: await testKey(),
    });
    const path = `/private/tmp/oidc-secret-migration-${crypto.randomUUID()}.json`;
    writeOidcMigrationEvidence(path, evidence);
    const saved = await Bun.file(path).text();
    expect(saved).toBe(`${JSON.stringify(evidence)}\n`);
    for (const forbidden of [secret, "row-evidence", "provider-evidence", "org-evidence"]) {
      expect(saved).not.toContain(forbidden);
    }
  });
});

class FakeD1Client implements D1WriteClient {
  readonly rows: StoredRow[];
  writeAttempts = 0;
  throwAfterWriteAttempt: number | undefined;
  throwMessage = "backend failure";
  beforeFirstWrite: (() => void) | undefined;

  constructor(rows: readonly StoredRow[]) {
    this.rows = rows.map((row) => ({ ...row }));
  }

  async query(
    sql: string,
    params: readonly D1Value[] = [],
  ): Promise<D1StatementResult> {
    expect(sql).toContain("SELECT id, provider_id, organization_id, oidc_config");
    const cursor = params[0];
    const limit = params[1];
    if (typeof cursor !== "string" || typeof limit !== "number") {
      throw new Error("unexpected read parameters");
    }
    return {
      rows: this.rows
        .filter((row) => row.id > cursor)
        .sort((left, right) => left.id.localeCompare(right.id))
        .slice(0, limit)
        .map((row) => ({
          id: row.id,
          provider_id: row.providerId,
          organization_id: row.organizationId,
          oidc_config: row.oidcConfig,
          oidc_client_secret_ciphertext: row.ciphertext,
        })),
      changes: null,
    };
  }

  async batch(
    statements: readonly D1Statement[],
  ): Promise<readonly D1StatementResult[]> {
    return statements.map((statement) => this.apply(statement));
  }

  private apply(statement: D1Statement): D1StatementResult {
    this.writeAttempts += 1;
    if (this.writeAttempts === 1) this.beforeFirstWrite?.();
    const params = statement.params ?? [];
    if (statement.sql.includes("SET oidc_client_secret_ciphertext = ?")) {
      const [ciphertext, id, providerId, organizationId, oidcConfig] = params;
      const row = this.rowForCas(id, providerId, organizationId, oidcConfig);
      const changes = row && row.ciphertext === null && typeof ciphertext === "string";
      if (changes) row.ciphertext = ciphertext;
      if (this.throwAfterWriteAttempt === this.writeAttempts) {
        throw new Error(this.throwMessage);
      }
      return { rows: [], changes: changes ? 1 : 0 };
    }
    if (statement.sql.includes("SET oidc_config = ?")) {
      const [nextConfig, id, providerId, organizationId, oidcConfig, ciphertext] = params;
      const row = this.rowForCas(id, providerId, organizationId, oidcConfig);
      const changes =
        row &&
        row.ciphertext === ciphertext &&
        typeof nextConfig === "string";
      if (changes) row.oidcConfig = nextConfig;
      if (this.throwAfterWriteAttempt === this.writeAttempts) {
        throw new Error(this.throwMessage);
      }
      return { rows: [], changes: changes ? 1 : 0 };
    }
    throw new Error("unexpected write SQL");
  }

  private rowForCas(
    id: D1Value | undefined,
    providerId: D1Value | undefined,
    organizationId: D1Value | undefined,
    oidcConfig: D1Value | undefined,
  ): StoredRow | undefined {
    return this.rows.find(
      (row) =>
        row.id === id &&
        row.providerId === providerId &&
        row.organizationId === organizationId &&
        row.oidcConfig === oidcConfig,
    );
  }
}

function legacyRow(
  id: string,
  providerId: string,
  organizationId: string,
  secret: string,
): StoredRow {
  return {
    id,
    providerId,
    organizationId,
    oidcConfig: JSON.stringify({
      issuer: "https://issuer.example.test",
      clientId: "client",
      clientSecret: secret,
    }),
    ciphertext: null,
  };
}

function parseConfig(value: string): Record<string, unknown> {
  return JSON.parse(value) as Record<string, unknown>;
}

function deterministicRandomValues(values: Uint8Array): Uint8Array {
  for (let index = 0; index < values.byteLength; index += 1) {
    values[index] = index + 1;
  }
  return values;
}

async function testKey(): Promise<CryptoKey> {
  return importOidcSecretMigrationKey(encodedTestKey());
}

function encodedTestKey(): string {
  return "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
}
