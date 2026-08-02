interface ProviderServiceResult {
  ok: boolean;
  value?: { data?: unknown };
  error?: { code?: string };
}

interface LegacyProviderService {
  runOperation(request: unknown): Promise<ProviderServiceResult>;
}

interface Env {
  LEGACY_DB: D1Database;
  HCLOUD_PROVIDER_SERVICE: LegacyProviderService;
}

interface ConnectionRow {
  connection_id: string;
  organization_id: string;
  state: string;
  sentinel_firewall_id: string;
  active_credential_version_id: string | null;
  credential_id: string;
  credential_version: number;
  algorithm: string;
  kek_version: string;
  aad_sha256: string;
  encrypted_token_b64: string;
  token_iv_b64: string;
  wrapped_dek_b64: string;
  dek_iv_b64: string;
  envelope_created_at: number;
  revoked_at: number | null;
}

const CONNECTIONS_SQL = `
SELECT
  connection.id AS connection_id,
  connection.organization_id,
  connection.state,
  connection.sentinel_firewall_id,
  connection.active_credential_version_id,
  credential.id AS credential_id,
  credential.version AS credential_version,
  credential.algorithm,
  credential.kek_version,
  credential.aad_sha256,
  credential.encrypted_token_b64,
  credential.token_iv_b64,
  credential.wrapped_dek_b64,
  credential.dek_iv_b64,
  credential.envelope_created_at,
  credential.revoked_at
FROM organization_provider_connections connection
INNER JOIN provider_credential_versions credential
  ON credential.connection_id = connection.id
 AND credential.version = (
   SELECT max(candidate.version)
   FROM provider_credential_versions candidate
   WHERE candidate.connection_id = connection.id
 )
WHERE connection.provider_kind = 'hetzner_cloud'
ORDER BY connection.id
`;

const INVENTORY_KEYS = [
  "servers",
  "primaryIps",
  "floatingIps",
  "firewalls",
  "networks",
  "volumes",
  "placementGroups",
  "snapshots",
  "sshKeys",
  "loadBalancers",
  "certificates",
] as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/inventory") {
      return new Response("Not Found", { status: 404 });
    }

    const result = await env.LEGACY_DB.prepare(CONNECTIONS_SQL).all<ConnectionRow>();
    const connections = [];
    for (const row of result.results) {
      const rpc = await env.HCLOUD_PROVIDER_SERVICE.runOperation({
        requestId: `cutover:${crypto.randomUUID()}`,
        connectionId: row.connection_id,
        credentialContext: {
          organizationId: row.organization_id,
          connectionId: row.connection_id,
          credentialId: row.credential_id,
          provider: "hetzner_cloud",
          version: row.credential_version,
        },
        credential: {
          algorithm: row.algorithm,
          kekVersion: row.kek_version,
          aadSha256: row.aad_sha256,
          wrappedDek: row.wrapped_dek_b64,
          wrappedDekIv: row.dek_iv_b64,
          ciphertext: row.encrypted_token_b64,
          ciphertextIv: row.token_iv_b64,
          createdAt: new Date(row.envelope_created_at).toISOString(),
        },
        operation: { kind: "inventory" },
      });

      if (!rpc.ok) {
        connections.push({
          connectionId: row.connection_id,
          state: row.state,
          activeCredentialVersionIdPresent:
            row.active_credential_version_id !== null,
          credentialRevoked: row.revoked_at !== null,
          providerRequestSucceeded: false,
          providerErrorCode: rpc.error?.code ?? "provider_inventory_failed",
          projectEmpty: false,
          sentinelPresent: null,
          counts: null,
        });
        continue;
      }

      const inventory = inventoryRecord(rpc.value?.data);
      const counts = Object.fromEntries(
        INVENTORY_KEYS.map((key) => [key, inventoryArray(inventory[key], key).length]),
      );
      const sentinelId = row.sentinel_firewall_id;
      const sentinelName = `intar-${row.connection_id.slice(0, 20)}-sentinel`;
      const sentinelPresent = inventoryArray(inventory.firewalls, "firewalls").some(
        (firewall) => {
          const candidate = record(firewall, "firewall");
          return String(candidate.id ?? "") === sentinelId || candidate.name === sentinelName;
        },
      );
      connections.push({
        connectionId: row.connection_id,
        state: row.state,
        activeCredentialVersionIdPresent:
          row.active_credential_version_id !== null,
        credentialRevoked: row.revoked_at !== null,
        providerRequestSucceeded: true,
        projectEmpty: Object.values(counts).every((count) => count === 0),
        sentinelPresent,
        counts,
      });
    }

    const provenEmpty =
      connections.length > 0 &&
      connections.every(
        (connection) =>
          connection.state === "disconnected" &&
          connection.activeCredentialVersionIdPresent === false &&
          connection.credentialRevoked === true &&
          connection.providerRequestSucceeded === true &&
          connection.projectEmpty === true &&
          connection.sentinelPresent === false,
      );
    return Response.json(
      {
        schemaVersion: 1,
        observedAt: new Date().toISOString(),
        transport: "legacy_encrypted_credential_via_provider_service_binding",
        connectionCount: connections.length,
        provenEmpty,
        connections,
      },
      {
        status: provenEmpty ? 200 : 409,
        headers: {
          "Cache-Control": "private, no-store",
          "X-Intar-Legacy-Provider-Probe": "live",
        },
      },
    );
  },
} satisfies ExportedHandler<Env>;

function inventoryRecord(value: unknown): Record<string, unknown> {
  return record(value, "provider inventory");
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function inventoryArray(value: unknown, label: string): unknown[] {
  if (value === undefined && label === "certificates") return [];
  if (!Array.isArray(value)) {
    throw new TypeError(`provider inventory ${label} must be an array`);
  }
  return value;
}
