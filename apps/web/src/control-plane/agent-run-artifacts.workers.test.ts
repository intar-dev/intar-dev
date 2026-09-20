/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleAgentRunArtifactRequest } from "@/control-plane/agent-run-artifacts";
import { handleAgentBootstrap, sha256Hex } from "@/control-plane/auth";
import {
  agentBootstrapTokens,
  agentHosts,
  scenarioRunArtifacts,
  scenarioRuns,
  user,
} from "@/db/schema";
import { grantFixtureBetaAccess } from "@/test/beta-access-fixtures";
import {
  RUN_PHASE_ORDER,
  buildInitialRunState,
  recomputeRunState,
  type RunPhase,
  type VmPhase,
} from "@/lib/run-state";
import { seedArtifactRuntime } from "./agent-run-artifacts/test-fixtures";
import { resetD1Database } from "@/test/d1-migrations";

describe("agent run artifact sealing", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    await resetD1Database();
  });

  it("rejects a new artifact after the VM archive is sealed", async () => {
    const token = await seedRun("completed", "completed");

    const response = await handleAgentRunArtifactRequest(
      new Request("http://localhost/agent/runs/begin", {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          runId: "run-1",
          vmName: "vm-runtime",
          artifacts: [artifactDescriptor()],
        }),
      }),
      env,
    );

    expect(response?.status).toBe(409);
    await expect(response?.json()).resolves.toEqual({
      code: "run_artifacts_sealed",
      error: "run artifact writes are sealed",
    });
    await expect(
      drizzle(env.DB).select().from(scenarioRunArtifacts),
    ).resolves.toHaveLength(0);
  });

  it("turns a failed VM into cleanup-complete without erasing the failed outcome", async () => {
    const token = await seedRun("failed", "failed");

    const response = await handleAgentRunArtifactRequest(
      new Request("http://localhost/agent/runs/run-1/vms/vm-runtime/complete", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      }),
      env,
    );

    expect(response?.status).toBe(200);
    const [run] = await drizzle(env.DB).select().from(scenarioRuns);
    const state = JSON.parse(run?.stateJson ?? "{}") as {
      phase: string;
      vms: Array<{ phase: string }>;
    };
    expect(run?.state).toBe("failed");
    expect(state.phase).toBe("failed");
    expect(state.vms[0]?.phase).toBe("completed");
  });

  it.each(["archive-stage", "timeline", "begin"])(
    "fences a delayed %s body after retirement",
    async (route) => {
      const token = await seedRun("failed", "failed");
      if (route === "timeline")
        await beginManifest(token, "ssh_recording_segment");
      if (route === "timeline") {
        await env.DB.prepare(
          "UPDATE runtime_artifacts SET upload_status = 'uploaded', uploaded_at = created_at",
        ).run();
        await env.DB.prepare(
          "UPDATE scenario_run_artifacts SET upload_status = 'uploaded', uploaded_at = created_at",
        ).run();
      }
      const delayed = delayedBody();
      const path =
        route === "begin"
          ? "/agent/runs/begin"
          : `/agent/runs/run-1/vms/vm-runtime/${route}`;
      const pending = handleAgentRunArtifactRequest(
        new Request(`http://localhost${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: delayed.stream,
        }),
        env,
      );
      await delayed.reading;
      await retireFixture();
      const before = await artifactSnapshot();
      delayed.release(
        route === "archive-stage"
          ? { stage: "raw_files_saved" }
          : route === "begin"
            ? {
                runId: "run-1",
                vmName: "vm-runtime",
                artifacts: [artifactDescriptor()],
              }
            : {
                version: 1,
                sessions: [
                  {
                    index: 1,
                    startTimestampMs: 1,
                    durationMs: 2,
                    castFilename: "console.log",
                    transcript: "retired transcript",
                  },
                ],
              },
      );
      const response = await pending;
      expect(response?.status).toBe(410);
      expect(await response?.json()).toMatchObject({
        code: "artifact_write_fenced",
      });
      expect(await artifactSnapshot()).toEqual(before);
    },
  );

  it.each([
    "UPDATE agent_hosts SET credential_generation = 2",
    "UPDATE agent_hosts SET scope = NULL",
    "UPDATE access_allowlist SET granted_at = granted_at + 1",
    "UPDATE runtime_vms SET runtime_vm_name = 'replacement'",
    "INSERT INTO runtime_executions (id,user_id,host_id,domain_kind,domain_id,generation,state) VALUES ('new','user-1','host-1','scenario','run-1',2,'archiving')",
  ])(
    "rejects a changed identity while a report body waits: %s",
    async (mutation) => {
      const token = await seedRun("failed", "failed");
      const delayed = delayedBody();
      const pending = handleAgentRunArtifactRequest(
        new Request(
          "http://localhost/agent/runs/run-1/vms/vm-runtime/archive-stage",
          {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: delayed.stream,
          },
        ),
        env,
      );
      await delayed.reading;
      await env.DB.prepare(mutation).run();
      delayed.release({ stage: "raw_files_saved" });
      expect((await pending)?.status).toBe(410);
      expect(
        await env.DB.prepare(
          "SELECT archive_stage_rank FROM runtime_vms",
        ).first(),
      ).toEqual({ archive_stage_rank: 1 });
    },
  );

  it.each(["initialize", "part", "complete"])(
    "fences a delayed multipart %s and retains its ledger",
    async (stage) => {
      const token = await seedRun("failed", "failed");
      await beginManifest(token);
      if (stage !== "initialize") {
        await env.DB.prepare(
          "INSERT INTO runtime_artifact_uploads (artifact_id,r2_upload_id,uploaded_parts_json,next_expected_part,updated_at) SELECT id,'upload-1',?, ?,1 FROM runtime_artifacts",
        )
          .bind(
            stage === "complete" ? '[{"partNumber":1,"etag":"part"}]' : "[]",
            stage === "complete" ? 2 : 1,
          )
          .run();
      }
      const object = await fixtureR2Object();
      const entered = deferred();
      const release = deferred();
      const wait = async () => {
        entered.resolve();
        await release.promise;
      };
      const abort = vi.fn(async () => {});
      const multipart = {
        uploadId: "upload-1",
        key: "fixture",
        abort,
        uploadPart: async () => {
          await wait();
          return { partNumber: 1, etag: "part" };
        },
        complete: async () => {
          await wait();
          return object;
        },
      };
      const bucket = {
        head: vi.fn(async (): Promise<R2Object | null> => object)
          .mockResolvedValueOnce(null),
        createMultipartUpload: async () => {
          await wait();
          return multipart;
        },
        resumeMultipartUpload: () => multipart,
      } as unknown as R2Bucket;
      const suffix =
        stage === "initialize"
          ? "multipart-begin"
          : stage === "part"
            ? "parts/1"
            : "complete";
      const pending = handleAgentRunArtifactRequest(
        new Request(
          `http://localhost/agent/runs/run-1/vms/vm-runtime/artifacts/1/${suffix}`,
          {
            method: stage === "part" ? "PUT" : "POST",
            headers: { authorization: `Bearer ${token}` },
            ...(stage === "part" ? { body: "part" } : {}),
          },
        ),
        { ...env, VM_RUN_ARTIFACTS_BUCKET: bucket },
      );
      await entered.promise;
      await retireFixture();
      const before = await artifactSnapshot();
      release.resolve();
      expect((await pending)?.status).toBe(410);
      expect(abort).toHaveBeenCalledOnce();
      expect(await artifactSnapshot()).toEqual(before);
    },
  );

  it("keeps completion and archive-stage retries idempotent for a current host", async () => {
    const token = await seedRun("failed", "failed");
    for (const suffix of ["complete", "complete", "archive-stage"]) {
      const response = await handleAgentRunArtifactRequest(
        new Request(
          `http://localhost/agent/runs/run-1/vms/vm-runtime/${suffix}`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${token}` },
            body: JSON.stringify({ stage: "raw_files_saved" }),
          },
        ),
        env,
      );
      expect(response?.status).toBe(200);
    }
    expect(
      await env.DB.prepare(
        "SELECT artifact_writes_sealed,archive_stage_rank FROM runtime_vms",
      ).first(),
    ).toEqual({ artifact_writes_sealed: 1, archive_stage_rank: 4 });
  });

  it("completes an upload without retrying when R2 completion omits metadata", async () => {
    const { token, object } = await pendingMultipartFixture();
    const head = vi.fn(async (): Promise<R2Object | null> => object)
      .mockResolvedValueOnce(null);
    const complete = vi.fn(async () => ({
      ...object,
      customMetadata: {},
      httpMetadata: {},
      writeHttpMetadata: object.writeHttpMetadata,
    }));

    const response = await completeArtifact(
      token,
      completionBucket(head, complete),
    );

    expect(response?.status).toBe(200);
    expect(complete).toHaveBeenCalledOnce();
    expect(head).toHaveBeenCalledTimes(2);
    for (const table of ["runtime_artifacts", "scenario_run_artifacts"]) {
      expect(
        (await env.DB.prepare(`SELECT upload_status FROM ${table}`).all()).results,
      ).toEqual([{ upload_status: "uploaded" }]);
    }
    for (const table of [
      "runtime_artifact_uploads",
      "scenario_run_artifact_uploads",
    ]) {
      expect(
        (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results,
      ).toHaveLength(0);
    }
  });

  it("keeps the pending ledger when the completed R2 object is missing", async () => {
    const { token, object } = await pendingMultipartFixture();
    const head = vi.fn(async () => null);
    const complete = vi.fn(async () => object);
    const before = await uploadLedgerSnapshot();

    const response = await completeArtifact(
      token,
      completionBucket(head, complete),
    );

    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({
      code: "artifact_object_conflict",
    });
    expect(complete).toHaveBeenCalledOnce();
    expect(await uploadLedgerSnapshot()).toEqual(before);
  });

  it("recovers a completed R2 upload after all eight metadata CAS attempts conflict", async () => {
    const token = await seedRun("failed", "failed");
    await beginManifest(token, "ssh_recording_raw");
    // Real Miniflare R2 preserves the metadata supplied by multipart-begin.
    for (const [suffix, method, body] of [
      ["multipart-begin", "POST", undefined],
      ["parts/1", "PUT", "0123456789"],
    ] as const) {
      const response = await handleAgentRunArtifactRequest(
        new Request(
          `http://localhost/agent/runs/run-1/vms/vm-runtime/artifacts/1/${suffix}`,
          {
            method,
            headers: { authorization: `Bearer ${token}` },
            ...(body === undefined ? {} : { body }),
          },
        ),
        env,
      );
      expect(response?.status).toBe(200);
    }
    const object = await fixtureR2Object();
    const upload = await env.DB.prepare(
      "SELECT r2_upload_id FROM runtime_artifact_uploads",
    ).first<{ r2_upload_id: string }>();
    const realBucket = env.VM_RUN_ARTIFACTS_BUCKET;
    const complete = vi.fn((parts: R2UploadedPart[]) =>
      realBucket
        .resumeMultipartUpload(object.key, upload!.r2_upload_id)
        .complete(parts),
    );
    const head = vi.fn((key: string) => realBucket.head(key));
    const bucket = completionBucket(head, complete);
    const before = await uploadLedgerSnapshot();
    const originalBatch = env.DB.batch.bind(env.DB);
    let conflicts = 0;
    let forceConflict = true;
    vi.spyOn(env.DB, "batch").mockImplementation(async (statements) => {
      // Metadata has been read by the time its multi-statement write reaches D1.
      // Change real persisted JSON so the actual CAS guard must abort each batch.
      if (forceConflict && statements.length > 1) {
        await env.DB.prepare(
          "UPDATE scenario_runs SET state_json = json_set(state_json, '$.concurrentReport', ?) WHERE run_id = 'run-1'",
        )
          .bind(++conflicts)
          .run();
      }
      return originalBatch(statements);
    });
    const first = await completeArtifact(token, bucket);
    expect(first?.status).toBe(409);
    expect(await first?.json()).toMatchObject({
      code: "artifact_state_conflict",
    });
    expect(conflicts).toBe(8);
    expect(complete).toHaveBeenCalledOnce();
    const stored = await realBucket.head(object.key);
    expect(stored).toMatchObject({
      key: object.key,
      size: 10,
      httpMetadata: object.httpMetadata,
    });
    expect(stored?.customMetadata).toEqual(object.customMetadata);
    expect(await uploadLedgerSnapshot()).toEqual(before);

    forceConflict = false;
    const retry = await completeArtifact(token, bucket);
    expect(retry?.status).toBe(200);
    expect(complete).toHaveBeenCalledOnce(); // HEAD recovery must not reuse the completed upload ID.
    expect(head).toHaveBeenCalledWith(object.key);
    for (const table of ["runtime_artifacts", "scenario_run_artifacts"]) {
      expect(
        (await env.DB.prepare(`SELECT upload_status FROM ${table}`).all())
          .results,
      ).toEqual([{ upload_status: "uploaded" }]);
    }
    expect(
      (await env.DB.prepare("SELECT * FROM runtime_artifact_uploads").all())
        .results,
    ).toHaveLength(0);
    expect(
      (
        await env.DB.prepare(
          "SELECT * FROM scenario_run_artifact_uploads",
        ).all()
      ).results,
    ).toHaveLength(0);
    const run = await env.DB.prepare(
      "SELECT state_json FROM scenario_runs WHERE run_id = 'run-1'",
    ).first<{ state_json: string }>();
    expect(JSON.parse(run!.state_json).vms[0].hasRecording).toBe(true);
  });

  it.each(
    ["existing", "new"].flatMap((source) =>
      ["ownerId", "executionGeneration", "sha256", "size", "contentType"].map(
        (field) => ({ source, field }),
      ),
    ),
  )(
    "rejects $source stored object with wrong $field and keeps the pending ledger",
    async ({ source, field }) => {
      const { token, object } = await pendingMultipartFixture();
      const wrong = {
        ...object,
        customMetadata: { ...object.customMetadata },
        httpMetadata: { ...object.httpMetadata },
        writeHttpMetadata: object.writeHttpMetadata,
      };
      if (field === "size") wrong.size += 1;
      else if (field === "contentType")
        wrong.httpMetadata.contentType = "application/wrong";
      else wrong.customMetadata[field] = "wrong";
      const complete = vi.fn(async () => object);
      const head = vi.fn(async (): Promise<R2Object | null> => wrong);
      if (source === "new") head.mockResolvedValueOnce(null);
      const before = await uploadLedgerSnapshot();
      const response = await completeArtifact(
        token,
        completionBucket(head, complete),
      );
      expect(response?.status).toBe(409);
      expect(await response?.json()).toMatchObject({
        code: "artifact_object_conflict",
      });
      expect(complete).toHaveBeenCalledTimes(source === "existing" ? 0 : 1);
      expect(await uploadLedgerSnapshot()).toEqual(before);
    },
  );

  it("fences revocation during HEAD recovery even when the completed object matches", async () => {
    const { token, object } = await pendingMultipartFixture();
    const entered = deferred();
    const release = deferred();
    const head = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return object;
    });
    const complete = vi.fn(async () => object);
    const pending = completeArtifact(token, completionBucket(head, complete));
    await entered.promise;
    await retireFixture();
    const before = await artifactSnapshot();
    release.resolve();
    const response = await pending;
    expect(response?.status).toBe(410);
    expect(await response?.json()).toMatchObject({
      code: "artifact_write_fenced",
    });
    expect(complete).not.toHaveBeenCalled();
    expect(await artifactSnapshot()).toEqual(before);
  });
});

async function seedRun(runPhase: RunPhase, vmPhase: VmPhase): Promise<string> {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.insert(user).values({
    id: "user-1",
    name: "Agent Owner",
    email: "agent-owner@example.com",
  });
  await grantActiveBetaAccess("user-1");
  await db.insert(agentHosts).values({
    id: "host-1",
    userId: "user-1",
    name: "Agent Host",
    scope: "personal",
    credentialGeneration: 1,
  });

  const initial = buildInitialRunState({
    vms: [
      {
        id: "vm-1",
        ordinal: 0,
        scenarioVmId: "scenario-vm-1",
        scenarioVmName: "vm",
        runtimeVmName: "vm-runtime",
        hostname: "vm",
        launchSummary: {
          scenarioVmName: "vm",
          hostname: "vm",
          probePhaseMap: {},
          probeDescriptors: [],
        },
      },
    ],
  });
  const state = recomputeRunState({
    ...initial,
    phase: runPhase,
    vms: initial.vms.map((vm) => ({ ...vm, phase: vmPhase })),
  });
  await db.insert(scenarioRuns).values({
    runId: "run-1",
    userId: "user-1",
    hostId: "host-1",
    scenarioId: "scenario-1",
    scenarioName: "scenario-1",
    title: "Scenario",
    tagline: "Test",
    briefingMarkdown: "Briefing",
    objectivesJson: "[]",
    difficulty: "easy",
    estimatedMinutes: 10,
    tagsJson: [],
    hintsJson: [],
    solutionMarkdown: "Solution",
    vmCount: 1,
    state: state.phase,
    stateRank: RUN_PHASE_ORDER[state.phase],
    activeKey: null,
    stateJson: JSON.stringify(state),
    completedAt: runPhase === "completed" ? now : null,
    failedAt: runPhase === "failed" ? now : null,
    createdAt: now,
    updatedAt: now,
  });

  await seedArtifactRuntime(env.DB);

  const bootstrapToken = "bootstrap-token";
  await db.insert(agentBootstrapTokens).values({
    id: "bootstrap-1",
    credentialGeneration: 1,
    hostId: "host-1",
    tokenHash: await sha256Hex(bootstrapToken),
    expiresAt: now + 60_000,
    createdAt: now,
  });
  const response = await handleAgentBootstrap(
    new Request("http://localhost/agent/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: "host-1", bootstrapToken }),
    }),
    env,
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { accessToken: string };
  return body.accessToken;
}

async function grantActiveBetaAccess(userId: string): Promise<void> {
  await grantFixtureBetaAccess({
    d1: env.DB,
    userId,
    githubUsername: userId,
  });
}

function artifactDescriptor() {
  return {
    ordinal: 1,
    kind: "console_log",
    filename: "console.log",
    contentType: "text/plain",
    sizeBytes: 10,
    sha256: "a".repeat(64),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function delayedBody() {
  const reading = deferred();
  const released = deferred();
  let payload: unknown;
  return {
    reading: reading.promise,
    release(value: unknown) {
      payload = value;
      released.resolve();
    },
    stream: new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          reading.resolve();
          await released.promise;
          controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
          controller.close();
        },
      },
      { highWaterMark: 0 },
    ),
  };
}

async function beginManifest(token: string, kind = "console_log") {
  const response = await handleAgentRunArtifactRequest(
    new Request("http://localhost/agent/runs/begin", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({
        runId: "run-1",
        vmName: "vm-runtime",
        artifacts: [{ ...artifactDescriptor(), kind }],
      }),
    }),
    env,
  );
  expect(response?.status).toBe(200);
}

async function retireFixture() {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE agent_hosts SET disabled = 1, scope = NULL, credential_generation = credential_generation + 1",
    ),
    env.DB.prepare("UPDATE agent_bootstrap_tokens SET revoked_at = 1"),
    env.DB.prepare(
      "UPDATE runtime_executions SET state = 'archived', lease_expires_at = NULL",
    ),
    env.DB.prepare("UPDATE runtime_vms SET artifact_writes_sealed = 1"),
  ]);
}

async function artifactSnapshot() {
  const tables = [
    "runtime_artifacts",
    "scenario_run_artifacts",
    "runtime_artifact_uploads",
    "scenario_run_artifact_uploads",
    "runtime_terminal_sessions",
    "scenario_run_session_transcripts",
    "scenario_runs",
    "runtime_vms",
    "runtime_executions",
  ];
  return Promise.all(
    tables.map(
      async (table) =>
        (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results,
    ),
  );
}

async function fixtureR2Object(): Promise<R2Object> {
  const artifact = await env.DB.prepare(
    "SELECT id,r2_key,size_bytes,content_type,sha256 FROM runtime_artifacts WHERE ordinal = 1",
  ).first<{
    id: string;
    r2_key: string;
    size_bytes: number;
    content_type: string;
    sha256: string;
  }>();
  if (!artifact) throw new Error("Missing artifact fixture");
  return {
    key: artifact.r2_key,
    size: artifact.size_bytes,
    customMetadata: {
      artifactId: artifact.id,
      executionId: "run-1",
      executionGeneration: "1",
      ownerId: "user-1",
      vmId: "vm-1",
      sha256: artifact.sha256,
    },
    httpMetadata: { contentType: artifact.content_type },
    version: "fixture-version",
    etag: "fixture-etag",
    httpEtag: '"fixture-etag"',
    uploaded: new Date(),
    storageClass: "Standard",
    checksums: { toJSON: () => ({}) },
    writeHttpMetadata: () => {},
  } as R2Object;
}

async function pendingMultipartFixture() {
  const token = await seedRun("failed", "failed");
  await beginManifest(token, "ssh_recording_raw");
  await env.DB.batch([
    env.DB
      .prepare(`INSERT INTO runtime_artifact_uploads (artifact_id,r2_upload_id,uploaded_parts_json,next_expected_part,updated_at)
      SELECT id,'upload-1','[{"partNumber":1,"etag":"part"}]',2,created_at FROM runtime_artifacts`),
    env.DB
      .prepare(`INSERT INTO scenario_run_artifact_uploads (artifact_id,r2_upload_id,uploaded_parts_json,next_expected_part,updated_at)
      SELECT id,'upload-1','[{"partNumber":1,"etag":"part"}]',2,created_at FROM scenario_run_artifacts`),
  ]);
  return { token, object: await fixtureR2Object() };
}

function completionBucket(
  head: (key: string) => Promise<R2Object | null>,
  complete: (parts: R2UploadedPart[]) => Promise<R2Object>,
): R2Bucket {
  return {
    head,
    resumeMultipartUpload: () => ({ complete, abort: vi.fn(async () => {}) }),
  } as unknown as R2Bucket;
}

function completeArtifact(token: string, bucket: R2Bucket) {
  return handleAgentRunArtifactRequest(
    new Request(
      "http://localhost/agent/runs/run-1/vms/vm-runtime/artifacts/1/complete",
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      },
    ),
    { ...env, VM_RUN_ARTIFACTS_BUCKET: bucket },
  );
}

async function uploadLedgerSnapshot() {
  return Promise.all(
    [
      "runtime_artifacts",
      "scenario_run_artifacts",
      "runtime_artifact_uploads",
      "scenario_run_artifact_uploads",
    ].map(
      async (table) =>
        (await env.DB.prepare(`SELECT * FROM ${table}`).all()).results,
    ),
  );
}
