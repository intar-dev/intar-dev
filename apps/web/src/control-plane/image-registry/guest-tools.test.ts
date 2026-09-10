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
    const fixture = await guestToolsFixture();
    const db = agentDb(["agent-a", "agent-b"]);
    const gate = promotionGate({ state: "drained", count: 0 });
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
      guestToolsRequest("promote", fixture.candidateSha256),
      guestToolsEnv(fixture, gate),
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      ok: true,
      warmed_host_ids: ["agent-a", "agent-b"],
      stable: {
        tools_disk_sha256: fixture.toolsDiskSha256,
        kino_sha256: fixture.kinoSha256,
        bootstrap_abi: 1,
      },
    });
    expect(desiredPins).toEqual([
      [expect.objectContaining({ tools_disk_sha256: fixture.toolsDiskSha256 })],
      [expect.objectContaining({ tools_disk_sha256: fixture.toolsDiskSha256 })],
    ]);
    expect(wakeMock.tryWakeHostRuntimeViaNamespace).toHaveBeenCalledTimes(2);
    expect(fixture.put).toHaveBeenCalledWith(
      "guest-tools/scenario/stable.json",
      expect.any(ArrayBuffer),
      { httpMetadata: { contentType: "application/json" } },
    );
  });

  it("warms every agent with a matching candidate digest", async () => {
    const fixture = await guestToolsFixture();
    const gate = promotionGate({ state: "drained", count: 0 });
    dbMock.drizzle.mockReturnValue(agentDb(["agent-a", "agent-b"]));

    const response = await handleImageRegistryRequest(
      guestToolsRequest("warm", fixture.candidateSha256),
      guestToolsEnv(fixture, gate),
    );

    expect(response?.status).toBe(200);
    await expect(response?.json()).resolves.toMatchObject({
      candidate: { tools_disk_sha256: fixture.toolsDiskSha256 },
      warmed_host_ids: ["agent-a", "agent-b"],
    });
    expect(gate.prepare).not.toHaveBeenCalled();
    expect(desiredStateStoreMock.mutateStoredHostDesiredState).toHaveBeenCalledTimes(2);
    expect(wakeMock.tryWakeHostRuntimeViaNamespace).toHaveBeenCalledTimes(2);
    expect(fixture.put).not.toHaveBeenCalled();
  });

  it.each([
    ["warm", undefined, 400],
    ["warm", "not-a-digest", 400],
    ["warm", "0".repeat(64), 409],
    ["promote", undefined, 400],
    ["promote", "0".repeat(64), 409],
  ])("rejects %s requests with a missing or changed candidate digest", async (path, digest, status) => {
    const fixture = await guestToolsFixture();
    const gate = promotionGate({ state: "drained", count: 0 });

    const response = await handleImageRegistryRequest(
      guestToolsRequest(path, digest),
      guestToolsEnv(fixture, gate),
    );

    expect(response?.status).toBe(status);
    expect(dbMock.drizzle).not.toHaveBeenCalled();
    expect(gate.prepare).not.toHaveBeenCalled();
    expect(desiredStateStoreMock.mutateStoredHostDesiredState).not.toHaveBeenCalled();
    expect(wakeMock.tryWakeHostRuntimeViaNamespace).not.toHaveBeenCalled();
    expect(fixture.put).not.toHaveBeenCalled();
  });

  it.each([
    ["the gate is missing", { state: null, count: 0 }],
    ["the gate is open", { state: "open", count: 0 }],
    ["a desired VM is running", { state: "drained", count: 1 }],
  ])("refuses promotion when %s", async (_reason, drain) => {
    const fixture = await guestToolsFixture();
    const gate = promotionGate(drain);

    const response = await handleImageRegistryRequest(
      guestToolsRequest("promote", fixture.candidateSha256),
      guestToolsEnv(fixture, gate),
    );

    expect(response?.status).toBe(409);
    expect(dbMock.drizzle).not.toHaveBeenCalled();
    expect(desiredStateStoreMock.mutateStoredHostDesiredState).not.toHaveBeenCalled();
    expect(wakeMock.tryWakeHostRuntimeViaNamespace).not.toHaveBeenCalled();
    expect(fixture.put).not.toHaveBeenCalled();
  });
});

async function guestToolsFixture() {
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
  return {
    candidateSha256: await sha256(candidate),
    get,
    head,
    kinoSha256,
    put,
    toolsDiskSha256,
  };
}

function agentDb(ids: string[]) {
  return {
    kind: "guest-tools-test-db",
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn().mockResolvedValue(ids.map((id) => ({ id }))),
      })),
    })),
  };
}

function promotionGate(row: { state: string | null; count: number }) {
  const first = vi.fn().mockResolvedValue(row);
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));
  return { prepare };
}

function guestToolsEnv(
  fixture: Awaited<ReturnType<typeof guestToolsFixture>>,
  gate: ReturnType<typeof promotionGate>,
) {
  return {
    DB: gate,
    HOST_RUNTIME: "runtime-binding",
    REGISTRY_PUBLISH_TOKEN: "publish-secret",
    VM_IMAGE_REGISTRY_BUCKET: {
      get: fixture.get,
      head: fixture.head,
      put: fixture.put,
    },
  } as unknown as Cloudflare.Env;
}

function guestToolsRequest(path: string, digest: string | undefined): Request {
  const headers: Record<string, string> = {
    authorization: "Bearer publish-secret",
  };
  if (digest) headers["x-intar-candidate-sha256"] = digest;
  return new Request(`https://intar.test/registry/v1/guest-tools/${path}`, {
    method: "POST",
    headers,
  });
}

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
