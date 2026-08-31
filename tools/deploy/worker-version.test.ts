import { describe, expect, it } from "vitest";

import { assertActiveWorkerRuntimeVersion } from "./worker-version";

const databaseId = "33333333-4444-4555-8666-777777777777";
const versionId = "11111111-2222-4333-8444-555555555555";
const sessionNamespaceId = "87ad9df7e37e4ced900553aa1a7775a1";

function version(bindings: unknown[]) {
  return {
    id: versionId,
    resources: { bindings },
  };
}

describe("production Worker runtime binding evidence", () => {
  const deployment = { versions: [{ version_id: versionId, percentage: 100 }] };
  const runtimeVersion = version([
    { type: "d1", name: "DB", id: databaseId },
    {
      type: "kv_namespace",
      name: "SESSION",
      namespace_id: sessionNamespaceId,
    },
  ]);

  it("accepts one 100 percent active version with the exact runtime bindings", () => {
    expect(
      assertActiveWorkerRuntimeVersion(
        deployment,
        runtimeVersion,
        databaseId,
        sessionNamespaceId,
        versionId,
      ),
    ).toEqual({ versionId, databaseId, sessionNamespaceId });
  });

  it("rejects split traffic, invalid DB bindings, and a different expected version", () => {
    expect(() =>
      assertActiveWorkerRuntimeVersion(
        {
          versions: [
            { version_id: versionId, percentage: 90 },
            { version_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", percentage: 10 },
          ],
        },
        runtimeVersion,
        databaseId,
        sessionNamespaceId,
      ),
    ).toThrow(/exactly one/);
    expect(() =>
      assertActiveWorkerRuntimeVersion(
        deployment,
        version([
          { type: "d1", name: "DB", id: databaseId },
          { type: "d1", name: "DB", id: databaseId },
          {
            type: "kv_namespace",
            name: "SESSION",
            namespace_id: sessionNamespaceId,
          },
        ]),
        databaseId,
        sessionNamespaceId,
      ),
    ).toThrow(/exactly one/);
    expect(() =>
      assertActiveWorkerRuntimeVersion(
        deployment,
        runtimeVersion,
        "00000000-0000-4000-8000-000000000001",
        sessionNamespaceId,
      ),
    ).toThrow(/expected database/);
    expect(() =>
      assertActiveWorkerRuntimeVersion(
        deployment,
        runtimeVersion,
        databaseId,
        sessionNamespaceId,
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      ),
    ).toThrow(/expected version/);
  });

  it("rejects a missing, duplicate, or wrong SESSION namespace binding", () => {
    const databaseBinding = { type: "d1", name: "DB", id: databaseId };
    const sessionBinding = {
      type: "kv_namespace",
      name: "SESSION",
      namespace_id: sessionNamespaceId,
    };
    expect(() =>
      assertActiveWorkerRuntimeVersion(
        deployment,
        version([databaseBinding]),
        databaseId,
        sessionNamespaceId,
      ),
    ).toThrow(/exactly one KV binding/);
    expect(() =>
      assertActiveWorkerRuntimeVersion(
        deployment,
        version([databaseBinding, sessionBinding, sessionBinding]),
        databaseId,
        sessionNamespaceId,
      ),
    ).toThrow(/exactly one KV binding/);
    expect(() =>
      assertActiveWorkerRuntimeVersion(
        deployment,
        version([
          databaseBinding,
          { ...sessionBinding, namespace_id: `${sessionNamespaceId}spoof` },
        ]),
        databaseId,
        sessionNamespaceId,
      ),
    ).toThrow(/expected namespace/);
  });
});
