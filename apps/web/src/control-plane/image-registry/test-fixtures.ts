import { gzipSync } from "node:zlib";
import { vi } from "vitest";
import type { HostDesiredStateV2 } from "@/generated/bridge";
import type { ScenarioManifestV4 } from "@/generated/catalog";

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

const scenarioCourseCatalogMock = vi.hoisted(() => ({
  syncScenarioCourseCatalogSnapshot: vi.fn(),
  validateScenarioCourseCatalogReferences: vi.fn(),
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

const candidateCatalogMock = vi.hoisted(() => ({
  stageCandidateScenarioManifest: vi.fn(),
  stageReusableCandidateManifests: vi.fn(),
  warmCandidateScenarioManifest: vi.fn(),
}));

const hostRuntimeWakeMock = vi.hoisted(() => ({
  tryWakeHostRuntime: vi.fn(),
}));

const scenarioImageCacheMock = vi.hoisted(() => ({
  isRuntimeImageCacheHost: vi.fn(),
  reconcileScenarioImagesForPublicationScope: vi.fn(),
  tryReconcileScenarioImagesForPublicationScope: vi.fn(),
}));

export function imageRegistryMocks() {
  return {
    authMock,
    dbMock,
    schedulerMock,
    scenarioCourseCatalogMock,
    imageBuildLockMock,
    catalogManifestMock,
    desiredStateStoreMock,
    candidateCatalogMock,
    hostRuntimeWakeMock,
    scenarioImageCacheMock,
  };
}

vi.mock("@/control-plane/auth", () => authMock);

vi.mock("drizzle-orm/d1", () => ({ drizzle: dbMock.drizzle }));

vi.mock("@/lib/build-scheduler", () => schedulerMock);

vi.mock("@/lib/scenario-course-catalogs", () => scenarioCourseCatalogMock);

vi.mock("@/lib/image-build-lock", () => imageBuildLockMock);

vi.mock("@/lib/catalog-manifest", () => catalogManifestMock);

vi.mock("@/lib/desired-state-store", () => desiredStateStoreMock);

vi.mock("@/lib/scenario-catalog-candidates", () => candidateCatalogMock);

vi.mock("@/lib/host-runtime-wake", () => hostRuntimeWakeMock);

vi.mock("@/lib/scenario-image-cache", () => scenarioImageCacheMock);

vi.mock("cloudflare:workers", () => ({ env: {} }));

export function resetImageRegistryMocks(): void {
  authMock.requireVerifiedAgentRequest.mockReset();
  dbMock.drizzle.mockReset();
  dbMock.drizzle.mockImplementation(() => defaultAgentVisibilityDb());
  schedulerMock.assignQueuedImageBuilds.mockReset();
  schedulerMock.queueImageBuildsFromBundle.mockReset();
  scenarioCourseCatalogMock.syncScenarioCourseCatalogSnapshot.mockReset();
  scenarioCourseCatalogMock.validateScenarioCourseCatalogReferences.mockReset();
  scenarioCourseCatalogMock.validateScenarioCourseCatalogReferences.mockResolvedValue(
    { ok: true, invalidScenarioIds: [] },
  );
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
  candidateCatalogMock.stageCandidateScenarioManifest.mockReset();
  candidateCatalogMock.stageCandidateScenarioManifest.mockResolvedValue(undefined);
  candidateCatalogMock.stageReusableCandidateManifests.mockReset();
  candidateCatalogMock.stageReusableCandidateManifests.mockResolvedValue([]);
  candidateCatalogMock.warmCandidateScenarioManifest.mockReset();
  candidateCatalogMock.warmCandidateScenarioManifest.mockResolvedValue([]);
  hostRuntimeWakeMock.tryWakeHostRuntime.mockReset();
  scenarioImageCacheMock.isRuntimeImageCacheHost.mockReset();
  scenarioImageCacheMock.isRuntimeImageCacheHost.mockImplementation(
    (host: { role: string; disabled: boolean }) =>
      host.role === "agent" && !host.disabled,
  );
  scenarioImageCacheMock.reconcileScenarioImagesForPublicationScope.mockReset();
  scenarioImageCacheMock.reconcileScenarioImagesForPublicationScope.mockResolvedValue(
    {
      changedHostIds: [],
      skippedUnknownArchitectureHostIds: [],
      failedHostIds: [],
    },
  );
  scenarioImageCacheMock.tryReconcileScenarioImagesForPublicationScope.mockReset();
  scenarioImageCacheMock.tryReconcileScenarioImagesForPublicationScope.mockResolvedValue(
    {
      changedHostIds: [],
      skippedUnknownArchitectureHostIds: [],
      failedHostIds: [],
    },
  );
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
  organizationId: string | null;
  hostId: string | null;
  status: "queued" | "assigned" | "building" | "succeeded" | "failed" | "stale";
  scenarioId: string;
  arch: "x86_64" | "aarch64";
  rev: string;
  contentHash: string;
  catalogChannel?: "candidate" | "live";
};

export function publishBuildAssignment(
  overrides: Partial<PublishBuildAssignmentFixture> = {},
): PublishBuildAssignmentFixture {
  return {
    id: "build-1",
    organizationId: null,
    hostId: "builder-1",
    status: "building",
    scenarioId: "broken-nginx",
    arch: "x86_64",
    rev: "abc123",
    contentHash: "d".repeat(64),
    ...overrides,
  };
}

export function builderPublishForm(manifest: ScenarioManifestV4): FormData {
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
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const updateSet = vi.fn(() => ({ where: updateWhere }));
  const update = vi.fn(() => ({ set: updateSet }));

  return {
    kind: "test-db",
    select,
    update,
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

export function imageIndexDb(
  rows: ImageIndexRow[],
  desiredRows: Array<{ docJson: HostDesiredStateV2 }> = [],
  candidateRows: Array<{ manifest: ScenarioManifestV4 }> = [],
) {
  let call = 0;
  const select = vi.fn(() => {
    const current = call++;
    if (current === 0) {
      const where = vi.fn().mockResolvedValue(rows);
      const innerJoin = vi.fn(() => ({ where }));
      const from = vi.fn(() => ({ innerJoin }));
      return { from };
    }
    if (current === 1) {
      const limit = vi.fn().mockResolvedValue(desiredRows);
      const where = vi.fn(() => ({ limit }));
      const from = vi.fn(() => ({ where }));
      return { from };
    }
    const where = vi.fn().mockResolvedValue(candidateRows);
    const from = vi.fn(() => ({ where }));
    return { from };
  });

  return {
    kind: "test-db",
    select,
  };
}

export function candidateArtifactDb(
  desiredRows: Array<{ docJson: HostDesiredStateV2 }>,
  candidateRows: Array<{ manifest: ScenarioManifestV4 }>,
) {
  let call = 0;
  const select = vi.fn(() => {
    const current = call++;
    if (current === 0) {
      const limit = vi.fn().mockResolvedValue([]);
      const where = vi.fn(() => ({ limit }));
      const innerJoin = vi.fn(() => ({ where }));
      const from = vi.fn(() => ({ innerJoin }));
      return { from };
    }
    if (current === 1) {
      const limit = vi.fn().mockResolvedValue(desiredRows);
      const where = vi.fn(() => ({ limit }));
      const from = vi.fn(() => ({ where }));
      return { from };
    }
    const where = vi.fn().mockResolvedValue(candidateRows);
    const from = vi.fn(() => ({ where }));
    return { from };
  });

  return {
    kind: "test-db",
    select,
  };
}

export function bundleDownloadDb(rows: Array<{ r2Key: string }>) {
  const selectLimit = vi.fn().mockResolvedValue(rows);
  const selectWhere = vi.fn(() => ({ limit: selectLimit }));
  const selectInnerJoin = vi.fn(() => ({ where: selectWhere }));
  const selectFrom = vi.fn(() => ({ innerJoin: selectInnerJoin }));
  const select = vi.fn(() => ({ from: selectFrom }));

  return {
    kind: "test-db",
    select,
  };
}

function defaultAgentVisibilityDb() {
  const select = vi.fn((selection: Record<string, unknown>) => {
    const imageKey = {
      scenario: "broken-nginx",
      vm: "web",
      arch: "x86_64" as const,
    };
    const where = vi.fn(() => {
      if ("id" in selection && !("imageKey" in selection)) {
        return { limit: vi.fn().mockResolvedValue([{ id: "vm-1" }]) };
      }
      return Promise.resolve([{ imageKey }]);
    });
    const innerJoin = vi.fn(() => ({ where }));
    const from = vi.fn(() => ({ innerJoin }));
    return { from };
  });
  return Object.assign(dbMock.db, { select });
}

export function sourceBundleFixture(scenarioIds: string[]): ArrayBuffer {
  return toArrayBuffer(
    gzipSync(tarArchiveFixture(bundleFixtureFiles(scenarioIds))),
  );
}

export function sourceBundleFixtureWithCourses(
  scenarioIds: string[],
  coursesHcl: string,
): ArrayBuffer {
  return toArrayBuffer(
    gzipSync(
      tarArchiveFixture([
        ...bundleFixtureFiles(scenarioIds),
        ["courses.hcl", coursesHcl],
      ]),
    ),
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
  chunkManifestSha256: string | null;
  guestBootstrapAbi: number | null;
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
    imageFormat: "raw_chunks_v1",
    imageVirtualSizeBytes: 8_589_934_592,
    chunkManifestSha256: "d".repeat(64),
    guestBootstrapAbi: 1,
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
}): ScenarioManifestV4 {
  return {
    schema_version: 4,
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
        image_id: input.imageSha256,
        image_format: "raw_chunks_v1",
        image_virtual_size_bytes: 8_589_934_592,
        chunk_manifest_sha256: "d".repeat(64),
        guest_bootstrap_abi: 1,
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

export function chunkManifestHead(manifest: ScenarioManifestV4) {
  const vm = manifest.vms[0];
  if (!vm) throw new Error("manifest has no VM");
  return {
    size: 321,
    customMetadata: {
      manifest_sha256: vm.chunk_manifest_sha256.toLowerCase(),
      image_id: vm.image_id.toLowerCase(),
      virtual_size_bytes: String(vm.image_virtual_size_bytes),
    },
  };
}

export async function sha256HexForTest(payload: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(payload);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
