import { describe, expect, it } from "vitest";

import worker from "./index";

const row = {
  connection_id: "hcloud-1234567890abcdef1234567890abcdef",
  organization_id: "org-1",
  state: "disconnected",
  sentinel_firewall_id: "42",
  active_credential_version_id: null,
  credential_id: "credential-1",
  credential_version: 1,
  algorithm: "AES-256-GCM",
  kek_version: "v1",
  aad_sha256: "a".repeat(64),
  encrypted_token_b64: "ciphertext",
  token_iv_b64: "ciphertext-iv",
  wrapped_dek_b64: "wrapped-dek",
  dek_iv_b64: "dek-iv",
  envelope_created_at: 1_700_000_000_000,
  revoked_at: 1_700_000_001_000,
};

const emptyInventory = {
  servers: [],
  primaryIps: [],
  floatingIps: [],
  firewalls: [],
  networks: [],
  volumes: [],
  placementGroups: [],
  snapshots: [],
  sshKeys: [],
  loadBalancers: [],
  certificates: [],
};

function environment(inventory: typeof emptyInventory) {
  return {
    LEGACY_DB: {
      prepare: () => ({ all: async () => ({ results: [row] }) }),
    },
    HCLOUD_PROVIDER_SERVICE: {
      runOperation: async () => ({
        ok: true,
        value: { data: inventory },
      }),
    },
  };
}

describe("legacy Hetzner project inventory proof", () => {
  it("proves a disconnected project empty through a live provider response", async () => {
    const response = await worker.fetch(
      new Request("https://probe.invalid/inventory"),
      environment(emptyInventory) as never,
    );
    expect(response.status).toBe(200);
    const evidence = (await response.json()) as Record<string, unknown>;
    expect(evidence.provenEmpty).toBe(true);
    expect(evidence.transport).toBe(
      "legacy_encrypted_credential_via_provider_service_binding",
    );
  });

  it("fails closed when the sentinel or any other resource still exists", async () => {
    const response = await worker.fetch(
      new Request("https://probe.invalid/inventory"),
      environment({
        ...emptyInventory,
        firewalls: [
          {
            id: 42,
            name: "intar-hcloud-1234567890abc-sentinel",
          } as never,
        ],
      }) as never,
    );
    expect(response.status).toBe(409);
    const evidence = (await response.json()) as Record<string, unknown>;
    expect(evidence.provenEmpty).toBe(false);
  });

  it("fails closed when D1 has no connection capable of real inventory proof", async () => {
    const response = await worker.fetch(
      new Request("https://probe.invalid/inventory"),
      {
        LEGACY_DB: {
          prepare: () => ({ all: async () => ({ results: [] }) }),
        },
        HCLOUD_PROVIDER_SERVICE: { runOperation: async () => ({ ok: true }) },
      } as never,
    );
    expect(response.status).toBe(409);
    expect((await response.json()) as object).toMatchObject({
      connectionCount: 0,
      provenEmpty: false,
    });
  });
});
