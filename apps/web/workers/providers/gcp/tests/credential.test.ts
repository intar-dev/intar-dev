import { describe, expect, it } from "vitest";
import type { GcpCredentialContext } from "@intar/provider-contracts/gcp";
import { CredentialEnvelopeError } from "@intar/provider-worker-core";
import {
  openGcpCredential,
  parseServiceAccountKey,
  sealGcpCredential,
} from "../src/credential";

const context: GcpCredentialContext = {
  organizationId: "org_0123456789",
  connectionId: "conn_0123456789",
  credentialId: "cred_0123456789",
  provider: "gcp_compute",
  version: 1,
};

const key = {
  type: "service_account",
  project_id: "intar-empty-12345",
  private_key_id: "0123456789abcdef0123456789abcdef",
  private_key: "-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----\n",
  client_email: "intar-runtime@intar-empty-12345.iam.gserviceaccount.com",
  client_id: "123456789012345678901",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
} as const;

function kek(fill = 19): string {
  let binary = "";
  for (const byte of new Uint8Array(32).fill(fill)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

describe("GCP credential boundary", () => {
  it("parses, seals, and binds a service-account key to its connection", async () => {
    const json = JSON.stringify(key);
    expect(parseServiceAccountKey(json).project_id).toBe(key.project_id);
    const envelope = await sealGcpCredential(
      `\n${json}\n`,
      kek(),
      context,
      new Date("2026-08-01T10:00:00.000Z"),
    );
    expect(JSON.stringify(envelope)).not.toContain(key.private_key);
    expect(envelope.aadSha256).toMatch(/^[0-9a-f]{64}$/u);
    await expect(openGcpCredential(envelope, kek(), context)).resolves.toMatchObject({
      project_id: key.project_id,
      client_email: key.client_email,
    });
    await expect(
      openGcpCredential(envelope, kek(), { ...context, organizationId: "org_other" }),
    ).rejects.toBeInstanceOf(CredentialEnvelopeError);
    await expect(
      openGcpCredential(envelope, kek(), { ...context, connectionId: "conn_other_123" }),
    ).rejects.toBeInstanceOf(CredentialEnvelopeError);
    await expect(
      openGcpCredential(envelope, kek(), { ...context, version: 2 }),
    ).rejects.toBeInstanceOf(CredentialEnvelopeError);
    await expect(
      openGcpCredential(
        envelope,
        kek(),
        { ...context, provider: "hetzner_cloud" } as never,
      ),
    ).rejects.toBeInstanceOf(CredentialEnvelopeError);
    await expect(openGcpCredential(envelope, kek(20), context))
      .rejects.toBeInstanceOf(CredentialEnvelopeError);
    await expect(openGcpCredential({
      ...envelope,
      ciphertext: `${envelope.ciphertext.slice(0, -2)}AA`,
    }, kek(), context)).rejects.toBeInstanceOf(CredentialEnvelopeError);
  });

  it("rejects user credentials and non-Google token endpoints", () => {
    expect(() => parseServiceAccountKey(JSON.stringify({ ...key, type: "authorized_user" })))
      .toThrow("GCP service-account key is invalid");
    expect(() => parseServiceAccountKey(JSON.stringify({ ...key, token_uri: "https://evil.test" })))
      .toThrow("GCP service-account key is invalid");
  });

  it("rejects a service account whose email belongs to another project", () => {
    expect(() => parseServiceAccountKey(JSON.stringify({
      ...key,
      client_email: "intar-runtime@different-project.iam.gserviceaccount.com",
    }))).toThrow("GCP service-account key is invalid");
  });
});
