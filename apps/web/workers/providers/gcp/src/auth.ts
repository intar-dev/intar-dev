import type { GcpServiceAccountKey } from "@intar/provider-contracts/gcp";
import { ProviderServiceError } from "@intar/provider-worker-core";

const encoder = new TextEncoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function pemToPkcs8(pem: string): ArrayBuffer {
  const encoded = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/gu, "");
  try {
    const binary = atob(encoded);
    const result = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      result[index] = binary.charCodeAt(index);
    }
    return result.buffer;
  } catch {
    throw new ProviderServiceError({
      code: "gcp_credential_invalid",
      message: "GCP credential cannot be used",
      retryable: false,
    });
  }
}

export interface GcpAccessToken {
  accessToken: string;
  expiresAtEpochSeconds: number;
}

export async function mintAccessToken(
  key: GcpServiceAccountKey,
  options: {
    fetcher?: typeof fetch;
    now?: () => Date;
  } = {},
): Promise<GcpAccessToken> {
  const nowSeconds = Math.floor((options.now?.() ?? new Date()).getTime() / 1000);
  const header = base64Url(
    encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT", kid: key.private_key_id })),
  );
  const claims = base64Url(
    encoder.encode(
      JSON.stringify({
        iss: key.client_email,
        scope: [
          "https://www.googleapis.com/auth/cloud-platform",
          "https://www.googleapis.com/auth/compute",
        ].join(" "),
        aud: key.token_uri,
        iat: nowSeconds,
        exp: nowSeconds + 3600,
      }),
    ),
  );
  const signingInput = `${header}.${claims}`;
  let privateKey: CryptoKey;
  try {
    privateKey = await crypto.subtle.importKey(
      "pkcs8",
      pemToPkcs8(key.private_key),
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new ProviderServiceError({
      code: "gcp_credential_invalid",
      message: "GCP credential cannot be used",
      retryable: false,
    });
  }
  const signature = base64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        privateKey,
        encoder.encode(signingInput),
      ),
    ),
  );
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: `${signingInput}.${signature}`,
  });
  let response: Response;
  try {
    response = await (options.fetcher ?? fetch)(key.token_uri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    throw new ProviderServiceError({
      code: "gcp_transport_error",
      message: "GCP authentication transport failed",
      retryable: true,
    });
  }
  if (!response.ok) {
    throw new ProviderServiceError({
      code: response.status === 401 || response.status === 400
        ? "gcp_credential_rejected"
        : "gcp_authentication_failed",
      message: "GCP authentication rejected the credential",
      retryable: response.status >= 500 || response.status === 429,
      providerStatus: response.status,
    });
  }
  const value = await response.json<unknown>();
  if (
    typeof value !== "object" || value === null ||
    !("access_token" in value) || typeof value.access_token !== "string" ||
    !("expires_in" in value) || typeof value.expires_in !== "number"
  ) {
    throw new ProviderServiceError({
      code: "gcp_authentication_failed",
      message: "GCP authentication returned an invalid response",
      retryable: false,
    });
  }
  return {
    accessToken: value.access_token,
    expiresAtEpochSeconds: nowSeconds + Math.max(1, Math.floor(value.expires_in)),
  };
}
