import { describe, expect, it } from "vitest";

import {
  assertActiveWorkerVersion,
  assertVersionDatabaseBinding,
} from "./worker-version";

const oldDatabaseId = "6e715506-88ce-4565-85bc-66a9cf2a3c5e";
const versionId = "11111111-2222-4333-8444-555555555555";

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
});
