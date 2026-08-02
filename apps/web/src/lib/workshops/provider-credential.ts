import type { EncryptedCredentialEnvelope } from "@intar/provider-contracts";
import type { RuntimeProviderKind } from "@intar/workshop-contracts";
import {
  providerConnections,
  providerCredentialVersions,
} from "@/db/schema";
import { appError } from "@/lib/app-error";

export function providerCredentialContext(input: {
  organizationId: string;
  connection: typeof providerConnections.$inferSelect;
  credential: typeof providerCredentialVersions.$inferSelect;
}): {
  organizationId: string;
  connectionId: string;
  credentialId: string;
  provider: Exclude<RuntimeProviderKind, "agent_kvm">;
  version: number;
} {
  if (input.credential.connectionId !== input.connection.id) {
    throw appError(
      409,
      "provider_credential_connection_mismatch",
      "the provider credential does not belong to this connection",
    );
  }
  return {
    organizationId: input.organizationId,
    connectionId: input.connection.id,
    credentialId: input.credential.id,
    provider: input.connection.providerKind,
    version: input.credential.version,
  };
}

export function providerCredentialEnvelope(
  row: typeof providerCredentialVersions.$inferSelect,
): EncryptedCredentialEnvelope {
  if (row.algorithm !== "AES-256-GCM" || row.kekVersion !== "v1") {
    throw appError(
      500,
      "provider_credential_envelope_unsupported",
      "the provider credential envelope version is unsupported",
    );
  }
  return {
    algorithm: "AES-256-GCM",
    kekVersion: "v1",
    aadSha256: row.aadSha256,
    wrappedDek: row.wrappedDekB64,
    wrappedDekIv: row.dekIvB64,
    ciphertext: row.encryptedPayloadB64,
    ciphertextIv: row.payloadIvB64,
    createdAt: new Date(row.createdAt).toISOString(),
  };
}
