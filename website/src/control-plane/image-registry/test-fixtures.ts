import { gzipSync } from "node:zlib";
import { vi } from "vitest";
import type { ScenarioManifestV3 } from "@/generated/catalog";

const authMock = vi.hoisted(() => ({
  requireVerifiedAgentRequest: vi.fn(),
}));

const dbMock = vi.hoisted(() => {
  const db = { kind: "test-db" };
  return {
    db,
    drizzle: vi.fn(() => db),
  };
});

const schedulerMock = vi.hoisted(() => ({
  assignQueuedImageBuilds: vi.fn(),
  queueImageBuildsFromBundle: vi.fn(),
}));

const imageBuildLockMock = vi.hoisted(() => ({
  withImageBuildCoordinationLock: vi.fn(),
  assertHeld: vi.fn(),
}));

const catalogManifestMock = vi.hoisted(() => ({
  seedScenarioManifest: vi.fn(),
}));

const desiredStateStoreMock = vi.hoisted(() => ({
  mutateStoredHostDesiredState: vi.fn(),
}));

const hostRuntimeWakeMock = vi.hoisted(() => ({
  tryWakeHostRuntime: vi.fn(),
}));

export function imageRegistryMocks() {
  return {
    authMock,
    dbMock,
    schedulerMock,
    imageBuildLockMock,
    catalogManifestMock,
    desiredStateStoreMock,
    hostRuntimeWakeMock,
  };
}

vi.mock("@/control-plane/auth", () => authMock);

vi.mock("drizzle-orm/d1", () => ({ drizzle: dbMock.drizzle }));

vi.mock("@/lib/build-scheduler", () => schedulerMock);

vi.mock("@/lib/image-build-lock", () => imageBuildLockMock);

vi.mock("@/lib/catalog-manifest", () => catalogManifestMock);

vi.mock("@/lib/desired-state-store", () => desiredStateStoreMock);

vi.mock("@/lib/host-runtime-wake", () => hostRuntimeWakeMock);

vi.mock("cloudflare:workers", () => ({ env: {} }));

export function resetImageRegistryMocks(): void {
  authMock.requireVerifiedAgentRequest.mockReset();
  dbMock.drizzle.mockClear();
  schedulerMock.assignQueuedImageBuilds.mockReset();
  schedulerMock.queueImageBuildsFromBundle.mockReset();
  imageBuildLockMock.assertHeld.mockReset();
  imageBuildLockMock.assertHeld.mockResolvedValue(undefined);
  imageBuildLockMock.withImageBuildCoordinationLock.mockReset();
  imageBuildLockMock.withImageBuildCoordinationLock.mockImplementation(
    async (
      _db: unknown,
      _identity: unknown,
      operation: (lease: {
        assertHeld: () => Promise<void>;
      }) => Promise<unknown>,
    ) => operation({ assertHeld: imageBuildLockMock.assertHeld }),
  );
  catalogManifestMock.seedScenarioManifest.mockReset();
  desiredStateStoreMock.mutateStoredHostDesiredState.mockReset();
  hostRuntimeWakeMock.tryWakeHostRuntime.mockReset();
}

export function buildLogDb(input: {
  selectRows: Array<{ hostId: string | null }>;
  updatedRows: Array<{ id: string }>;
}) {
  const selectLimit = vi.fn().mockResolvedValue(input.selectRows);
  const selectWhere = vi.fn(() => ({ limit: selectLimit }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));
  const updateReturning = vi.fn().mockResolvedValue(input.updatedRows);
  const updateWhere = vi.fn(() => ({ returning: updateReturning }));
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  return {
    kind: "test-db",
    select,
    update,
    updateSet,
  };
}

export type PublishBuildAssignmentFixture = {
  id: string;
  hostId: string | null;
  status: "queued" | "assigned" | "building" | "succeeded" | "failed" | "stale";
  scenarioId: string;
  arch: "x86_64" | "aarch64";
  rev: string;
  contentHash: string;
};

export function publishBuildAssignment(
  overrides: Partial<PublishBuildAssignmentFixture> = {},
): PublishBuildAssignmentFixture {
  return {
    id: "build-1",
    hostId: "builder-1",
    status: "building",
    scenarioId: "broken-nginx",
    arch: "x86_64",
    rev: "abc123",
    contentHash: "d".repeat(64),
    ...overrides,
  };
}

export function builderPublishForm(manifest: ScenarioManifestV3): FormData {
  const form = new FormData();
  form.set("manifest", JSON.stringify(manifest));
  form.set("build_id", "build-1");
  form.set("rev", "abc123");
  form.set("content_hash", "d".repeat(64));
  form.set("architecture", "x86_64");
  return form;
}

export function publishFenceDb(input: {
  assignmentRows: PublishBuildAssignmentFixture[][];
  hostRows?: HostSelectRow[];
  imageRefRows?: Array<{ imageKey: unknown; imageSha256: string | null }>;
}) {
  let selectCall = 0;
  const select = vi.fn(() => {
    const call = selectCall;
    selectCall += 1;
    if (call < input.assignmentRows.length) {
      const rows = input.assignmentRows[call] ?? [];
      const limit = vi.fn().mockResolvedValue(rows);
      const where = vi.fn(() => ({ limit }));
      const from = vi.fn(() => ({ where }));
      return { from };
    }

    const rows =
      call === input.assignmentRows.length
        ? (input.hostRows ?? [])
        : (input.imageRefRows ?? []);
    const where = vi.fn().mockResolvedValue(rows);
    const from = vi.fn(() => ({ where }));
    return { from };
  });

  return {
    kind: "test-db",
    select,
  };
}

export function hostSelectDb(rows: HostSelectRow[]) {
  const selectWhere = vi.fn().mockResolvedValue(rows);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  return {
    kind: "test-db",
    select,
  };
}

export interface HostSelectRow {
  id: string;
  role: "agent" | "builder";
  disabled: boolean;
  scenarioEnabled: boolean;
}

// Publish runs two select().from().where() queries in order: the cached-image
// host bump (agentHosts) and then the prune's catalog-reference guard
// (vmScenarioVms).
export function publishPruneDb(
  hostRows: HostSelectRow[],
  imageRefRows: Array<{ imageKey: unknown; imageSha256: string | null }>,
) {
  const selectWhere = vi
    .fn()
    .mockResolvedValueOnce(hostRows)
    .mockResolvedValueOnce(imageRefRows);
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  return {
    kind: "test-db",
    select,
  };
}

export function pruneImageObject(sha256: string, uploadedMs: number) {
  return {
    key: `images/broken-nginx-web-x86_64/${sha256}.raw.zst`,
    uploaded: new Date(uploadedMs),
  };
}

export function pruneCompanionObject(sha256: string, uploadedMs: number) {
  return {
    key: `images/broken-nginx-web-x86_64/${sha256}.raw.zst.sha256`,
    uploaded: new Date(uploadedMs),
  };
}

export function imageIndexDb(rows: ImageIndexRow[]) {
  const selectFrom = vi.fn().mockResolvedValue(rows);
  const select = vi.fn(() => ({ from: selectFrom }));

  return {
    kind: "test-db",
    select,
  };
}

export function bundleDownloadDb(rows: Array<{ r2Key: string }>) {
  const selectLimit = vi.fn().mockResolvedValue(rows);
  const selectWhere = vi.fn(() => ({ limit: selectLimit }));
  const selectFrom = vi.fn(() => ({ where: selectWhere }));
  const select = vi.fn(() => ({ from: selectFrom }));

  return {
    kind: "test-db",
    select,
  };
}

export function sourceBundleFixture(scenarioIds: string[]): ArrayBuffer {
  return toArrayBuffer(
    gzipSync(tarArchiveFixture(bundleFixtureFiles(scenarioIds))),
  );
}

export function sourceBundleFixtureWithInvalidTarHeader(
  scenarioIds: string[],
): ArrayBuffer {
  const files = bundleFixtureFiles(scenarioIds);
  const tar = tarArchiveFixture(files);
  const firstByte = tar[0] ?? 0;
  tar[0] = firstByte === 0 ? 1 : firstByte + 1;
  return toArrayBuffer(gzipSync(tar));
}

export function sourceBundleFixtureWithMetadataEntry(
  scenarioIds: string[],
): ArrayBuffer {
  const metadataEntry = tarEntryFixture("pax-header", "", "x");
  const tar = concatBytes([
    metadataEntry,
    tarArchiveFixture(bundleFixtureFiles(scenarioIds)),
  ]);
  return toArrayBuffer(gzipSync(tar));
}

export function bundleFixtureFiles(
  scenarioIds: string[],
): Array<[string, string]> {
  return [
    ["base-images.hcl", 'base_image "trixie" {}\n'],
    ["build-tools.hcl", 'kino { version = "0.4.0" }\n'],
    ...scenarioIds.map((scenarioId): [string, string] => [
      `scenarios/${scenarioId}/scenario.hcl`,
      `scenario "${scenarioId}" {}\n`,
    ]),
  ];
}

export function tarArchiveFixture(files: Array<[string, string]>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const [path, content] of files) {
    chunks.push(tarEntryFixture(path, content, "0"));
  }
  chunks.push(new Uint8Array(1024));
  return concatBytes(chunks);
}

export function tarEntryFixture(
  path: string,
  content: string,
  typeflag: string,
): Uint8Array {
  const bytes = new TextEncoder().encode(content);
  const header = new Uint8Array(512);
  writeTarString(header, 0, 100, path);
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, bytes.byteLength);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = typeflag.charCodeAt(0);
  writeTarString(header, 257, 6, "ustar");
  writeTarString(header, 263, 2, "00");
  writeTarOctal(header, 148, 8, tarChecksum(header));

  const chunks: Uint8Array[] = [header, bytes];
  const padding = (512 - (bytes.byteLength % 512)) % 512;
  if (padding > 0) {
    chunks.push(new Uint8Array(padding));
  }
  return concatBytes(chunks);
}

export function writeTarString(
  output: Uint8Array,
  offset: number,
  length: number,
  value: string,
): void {
  const bytes = new TextEncoder().encode(value);
  output.set(bytes.subarray(0, length), offset);
}

export function writeTarOctal(
  output: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const raw = value.toString(8).padStart(length - 1, "0");
  writeTarString(output, offset, length, raw);
}

export function tarChecksum(header: Uint8Array): number {
  return header.reduce((sum, byte) => sum + byte, 0);
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

export interface ImageIndexRow {
  imageKey: {
    scenario: string;
    vm: string;
    arch: "x86_64" | "aarch64";
  };
  imageSha256: string;
  imageFormat: string;
  imageVirtualSizeBytes: number;
  kernelSha256: string;
  initrdSha256: string;
  bootCmdline: string;
}

export function imageIndexRow(
  overrides: Partial<ImageIndexRow> = {},
): ImageIndexRow {
  return {
    imageKey: {
      scenario: "broken-nginx",
      vm: "web",
      arch: "x86_64",
    },
    imageSha256: "a".repeat(64),
    imageFormat: "raw_zstd",
    imageVirtualSizeBytes: 8_589_934_592,
    kernelSha256: "b".repeat(64),
    initrdSha256: "c".repeat(64),
    bootCmdline:
      "root=/dev/vda rw console=ttyS0 quiet loglevel=4 systemd.show_status=false",
    ...overrides,
  };
}

export function publishManifest(input: {
  imageSha256: string;
  artifactSha256: string;
}): ScenarioManifestV3 {
  return {
    schema_version: 3,
    scenario_id: "broken-nginx",
    name: "broken-nginx",
    title: "Broken Nginx",
    category: "web",
    description: "Repair nginx.",
    difficulty: "easy",
    estimated_minutes: 15,
    tags: ["nginx"],
    briefing_markdown: "Repair the web server.",
    solution_markdown: "Enable nginx.",
    hints: [],
    vms: [
      {
        name: "web",
        image_key: {
          scenario: "broken-nginx",
          vm: "web",
          arch: "x86_64",
        },
        image_sha256: input.imageSha256,
        image_format: "raw_zstd",
        image_virtual_size_bytes: 8_589_934_592,
        boot: {
          kernel_sha256: input.artifactSha256,
          initrd_sha256: input.artifactSha256,
          cmdline:
            "root=/dev/vda rw console=ttyS0 quiet loglevel=4 systemd.show_status=false",
        },
        cpu_millis: 2_000,
        vcpu_count: 2,
        memory_mib: 2048,
        disk_mib: 8192,
        probes: [],
      },
    ],
  };
}

export async function sha256HexForTest(payload: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(payload);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
