import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  imageRegistryMocks,
  resetImageRegistryMocks,
} from "./test-fixtures";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";

const wakeMock = vi.hoisted(() => ({
  tryWakeHostRuntimeViaNamespace: vi.fn(),
}));
vi.mock("@/lib/host-runtime-wake-client", () => wakeMock);

const { dbMock, desiredStateStoreMock } = imageRegistryMocks();

describe("scenario guest-tools promotion", () => {
  beforeEach(() => {
    resetImageRegistryMocks();
    wakeMock.tryWakeHostRuntimeViaNamespace.mockReset();
    wakeMock.tryWakeHostRuntimeViaNamespace.mockResolvedValue(undefined);
  });

  it("verifies candidate objects, warms every agent, then switches stable", async () => {
    const compressedDisk = new Uint8Array([1, 2, 3, 4]);
    const kino = new Uint8Array([5, 6, 7]);
    const toolsDiskSha256 = "a".repeat(64);
    const kinoSha256 = await sha256(kino);
    const pin = {
      schema_version: 1,
      bootstrap_abi: 1,
      tools_disk_sha256: toolsDiskSha256,
      tools_disk_size_bytes: 64 * 1024 * 1024,
      compressed_disk_sha256: await sha256(compressedDisk),
      compressed_disk_size_bytes: compressedDisk.byteLength,
      kino_sha256: kinoSha256,
      kino_size_bytes: kino.byteLength,
    };
    const candidate = new TextEncoder().encode(JSON.stringify(pin));
    const put = vi.fn().mockResolvedValue(undefined);
    const get = vi.fn(async (key: string) => {
      if (key === "guest-tools/scenario/candidate.json") {
        return object(candidate);
      }
      if (key === `guest-tools/scenario/disks/${toolsDiskSha256}.ext4.zst`) {
        return object(compressedDisk);
      }
      if (key === `guest-tools/scenario/kino/${kinoSha256}/kino`) {
        return object(kino);
      }
      return null;
    });
    const head = vi.fn(async (key: string) => {
      const value = await get(key);
      return value ? { size: value.size } : null;
    });
    const db = {
      kind: "guest-tools-test-db",
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([{ id: "agent-a" }, { id: "agent-b" }]),
        })),
      })),
    };
    dbMock.drizzle.mockReturnValue(db);
    const desiredPins: unknown[] = [];
    desiredStateStoreMock.mutateStoredHostDesiredState.mockImplementation(
      async (_db, _hostId, _now, mutate) => {
        const draft = { cached_guest_tools: [] };
        mutate(draft);
        desiredPins.push(draft.cached_guest_tools);
        return draft;
      },
    );

    const response = await handleImageRegistryRequest(
      new Request("https://intar.test/registry/v1/guest-tools/promote", {
        method: "POST",
        headers: { authorization: "Bearer publish-secret" },
      }),
      {
        DB: "db-binding",
        HOST_RUNTIME: "runtime-binding",
        REGISTRY_PUBLISH_TOKEN: "publish-secret",
        VM_IMAGE_REGISTRY_BUCKET: { get, head, put },
      } as unknown as Cloudflare.Env,
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      ok: true,
      warmed_host_ids: ["agent-a", "agent-b"],
      stable: {
        tools_disk_sha256: toolsDiskSha256,
        kino_sha256: kinoSha256,
        bootstrap_abi: 1,
      },
    });
    expect(desiredPins).toEqual([
      [expect.objectContaining({ tools_disk_sha256: toolsDiskSha256 })],
      [expect.objectContaining({ tools_disk_sha256: toolsDiskSha256 })],
    ]);
    expect(wakeMock.tryWakeHostRuntimeViaNamespace).toHaveBeenCalledTimes(2);
    expect(put).toHaveBeenCalledWith(
      "guest-tools/scenario/stable.json",
      expect.any(ArrayBuffer),
      { httpMetadata: { contentType: "application/json" } },
    );
  });
});

function object(bytes: Uint8Array) {
  return {
    size: bytes.byteLength,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const input = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
