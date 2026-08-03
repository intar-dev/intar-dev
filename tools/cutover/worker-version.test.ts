import { describe, expect, it } from "vitest";

import {
  assertActiveWorkerRuntimeVersion,
  assertActiveWorkerVersion,
  assertVersionDatabaseBinding,
  assertVersionRuntimeBindings,
} from "./worker-version";

const oldDatabaseId = "6e715506-88ce-4565-85bc-66a9cf2a3c5e";
const versionId = "11111111-2222-4333-8444-555555555555";
const sessionNamespaceId = "87ad9df7e37e4ced900553aa1a7775a1";

function version(bindings: unknown[]) {
  return {
    id: versionId,
    resources: { bindings },
  };
}

describe("clean D1 Worker binding evidence", () => {
  it("accepts one 100 percent active version with the exact DB binding", () => {
    expect(
      assertActiveWorkerVersion(
        { versions: [{ version_id: versionId, percentage: 100 }] },
        version([{ type: "d1", name: "DB", id: oldDatabaseId }]),
        oldDatabaseId,
      ),
    ).toEqual({ versionId, databaseId: oldDatabaseId });
  });

  it("rejects split traffic, extra DB bindings, and suffix-shaped spoofing", () => {
    expect(() =>
      assertActiveWorkerVersion(
        {
          versions: [
            { version_id: versionId, percentage: 90 },
            { version_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", percentage: 10 },
          ],
        },
        version([{ type: "d1", name: "DB", id: oldDatabaseId }]),
        oldDatabaseId,
      ),
    ).toThrow(/exactly one/);
    expect(() =>
      assertVersionDatabaseBinding(
        version([
          { type: "d1", name: "DB", id: oldDatabaseId },
          { type: "d1", name: "DB", id: oldDatabaseId },
        ]),
        oldDatabaseId,
      ),
    ).toThrow(/exactly one/);
    expect(() =>
      assertVersionDatabaseBinding(
        version([{ type: "plain_text", name: "NOTE", text: oldDatabaseId }]),
        oldDatabaseId,
      ),
    ).toThrow(/exactly one/);
  });

  it("rejects a different active version or database", () => {
    expect(() =>
      assertActiveWorkerVersion(
        { versions: [{ version_id: versionId, percentage: 100 }] },
        version([{ type: "d1", name: "DB", id: oldDatabaseId }]),
        "00000000-0000-4000-8000-000000000001",
      ),
    ).toThrow(/expected database/);
    expect(() =>
      assertVersionDatabaseBinding(
        version([{ type: "d1", name: "DB", id: oldDatabaseId }]),
        oldDatabaseId,
        "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      ),
    ).toThrow(/expected version/);
  });

  it("accepts the exact DB and SESSION bindings on an uploaded or active version", () => {
    const runtimeVersion = version([
      { type: "d1", name: "DB", id: oldDatabaseId },
      {
        type: "kv_namespace",
        name: "SESSION",
        namespace_id: sessionNamespaceId,
      },
    ]);
    expect(
      assertVersionRuntimeBindings(
        runtimeVersion,
        oldDatabaseId,
        sessionNamespaceId,
        versionId,
      ),
    ).toEqual({ versionId, databaseId: oldDatabaseId, sessionNamespaceId });
    expect(
      assertActiveWorkerRuntimeVersion(
        { versions: [{ version_id: versionId, percentage: 100 }] },
        runtimeVersion,
        oldDatabaseId,
        sessionNamespaceId,
        versionId,
      ),
    ).toEqual({ versionId, databaseId: oldDatabaseId, sessionNamespaceId });
  });

  it("rejects a missing, duplicate, or wrong SESSION namespace binding", () => {
    const databaseBinding = { type: "d1", name: "DB", id: oldDatabaseId };
    const sessionBinding = {
      type: "kv_namespace",
      name: "SESSION",
      namespace_id: sessionNamespaceId,
    };
    expect(() =>
      assertVersionRuntimeBindings(
        version([databaseBinding]),
        oldDatabaseId,
        sessionNamespaceId,
      ),
    ).toThrow(/exactly one KV binding/);
    expect(() =>
      assertVersionRuntimeBindings(
        version([databaseBinding, sessionBinding, sessionBinding]),
        oldDatabaseId,
        sessionNamespaceId,
      ),
    ).toThrow(/exactly one KV binding/);
    expect(() =>
      assertVersionRuntimeBindings(
        version([
          databaseBinding,
          { ...sessionBinding, namespace_id: `${sessionNamespaceId}spoof` },
        ]),
        oldDatabaseId,
        sessionNamespaceId,
      ),
    ).toThrow(/expected namespace/);
  });
});
