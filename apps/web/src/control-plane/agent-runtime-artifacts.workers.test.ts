/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAgentRunArtifactRequest } from "@/control-plane/agent-run-artifacts";
import { buildArtifactObjectKey } from "@/control-plane/agent-run-artifacts/storage";
import { handleAgentBootstrap, sha256Hex } from "@/control-plane/auth";
import {
  agentBootstrapTokens,
  agentHosts,
  member,
  organization,
  runtimeArtifacts,
  runtimeExecutions,
  runtimeTerminalSessions,
  runtimeVms,
  scenarioRunArtifacts,
  scenarioRunSessionTranscripts,
  scenarioRuns,
  user,
  workshopSessionMembers,
  workshopSessions,
  workshopTemplateRevisions,
  workshopTemplates,
  workshopWorkspaceGenerations,
  workshopWorkspaces,
  type WorkshopManifestV2,
} from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { grantFixtureBetaAccess } from "@/test/beta-access-fixtures";
import { listWorkshopArtifactsForOwner } from "@/lib/workshops/artifacts";
import { deriveScenarioRunReplayState } from "@/lib/scenario-runs/activity";
import { getScenarioRunForUser } from "@/lib/scenario-runs";
import {
  drizzleQueryToD1Statement,
  executeScenarioRunRuntimeProjection,
} from "@/lib/runtime-executions";
import {
  RUN_PHASE_ORDER,
  buildInitialRunState,
  recomputeRunState,
} from "@/lib/run-state";
import { resetD1Database } from "@/test/d1-migrations";

describe("domain-neutral agent artifact ingestion", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("preserves scenario archive behavior while mirroring the runtime ledger", async () => {
    const token = await seedScenarioRuntime();
    const descriptor = artifactDescriptor("console_log", "console.log");

    const begin = await beginUpload(
      token,
      "scenario-execution",
      "scenario-vm",
      descriptor,
    );
    expect(begin.status).toBe(200);
    await expect(begin.json()).resolves.toMatchObject({
      archiveProgressVersion: 1,
    });
    expect(
      (
        await agentRequest(
          token,
          "/agent/runs/scenario-execution/vms/scenario-vm/artifacts/1/multipart-begin",
          "POST",
        )
      ).status,
    ).toBe(200);

    const db = drizzle(env.DB);
    const [legacy, generic] = await Promise.all([
      db.select().from(scenarioRunArtifacts),
      db.select().from(runtimeArtifacts),
    ]);
    expect(legacy).toHaveLength(1);
    expect(generic).toHaveLength(1);
    expect(legacy[0]).toMatchObject({
      id: generic[0]?.id,
      uploadStatus: "uploaded",
      r2Key: generic[0]?.r2Key,
    });
    expect(
      (
        await agentRequest(
          token,
          "/agent/runs/scenario-execution/vms/scenario-vm/complete",
          "POST",
        )
      ).status,
    ).toBe(200);
    const [runtimeVm] = await db.select().from(runtimeVms);
    const [scenario] = await db.select().from(scenarioRuns);
    expect(runtimeVm?.artifactWritesSealed).toBe(true);
    expect(scenario?.state).toBe("completed");
  });

  it("archives a zero-byte raw recording bundle without treating it as a timeline segment", async () => {
    const token = await seedScenarioRuntime();
    const bundle = {
      ...artifactDescriptor("ssh_recording_raw_bundle", "recordings.tar"),
      contentType: "application/x-tar",
    };
    expect(
      (await beginUpload(token, "scenario-execution", "scenario-vm", bundle))
        .status,
    ).toBe(200);
    const upload = await agentRequest(
      token,
      "/agent/runs/scenario-execution/vms/scenario-vm/artifacts/1/multipart-begin",
      "POST",
    );
    expect(upload.status).toBe(200);
    await expect(upload.json()).resolves.toMatchObject({ done: true });

    const db = drizzle(env.DB);
    const [runtimeArtifact, legacyArtifact, run] = await Promise.all([
      db.select().from(runtimeArtifacts),
      db.select().from(scenarioRunArtifacts),
      db
        .select({ stateJson: scenarioRuns.stateJson })
        .from(scenarioRuns)
        .where(eq(scenarioRuns.runId, "scenario-execution")),
    ]);
    expect(runtimeArtifact[0]).toMatchObject({
      kind: "ssh_recording_raw_bundle",
      contentType: "application/x-tar",
      uploadStatus: "uploaded",
    });
    expect(legacyArtifact[0]?.uploadStatus).toBe("uploaded");
    const state = JSON.parse(run[0]?.stateJson ?? "{}") as Parameters<
      typeof deriveScenarioRunReplayState
    >[0];
    expect(state.vms[0]?.hasRecording).toBe(true);
    expect(deriveScenarioRunReplayState(state)).toBe("preparing");

    expect(
      (
        await agentRequest(
          token,
          "/agent/runs/scenario-execution/vms/scenario-vm/timeline",
          "POST",
          {
            version: 1,
            sessions: [
              {
                index: 1,
                startTimestampMs: 1_000,
                durationMs: 100,
                castFilename: "recordings.tar",
                transcript: "not a replay segment",
              },
            ],
          },
        )
      ).status,
    ).toBe(409);
  });

  it("batches a contiguous artifact manifest and keeps dual-ledger retries idempotent", async () => {
    const token = await seedScenarioRuntime();
    const artifacts = [
      artifactDescriptor("console_log", "one.log", 0, 1),
      artifactDescriptor("console_log", "two.log", 0, 2),
      artifactDescriptor("console_log", "three.log", 0, 3),
    ];

    const first = await beginUploadArtifacts(
      token,
      "scenario-execution",
      "scenario-vm",
      artifacts,
    );
    expect(first.status).toBe(200);

    const db = drizzle(env.DB);
    const [runtimeRows, legacyRows] = await Promise.all([
      db.select().from(runtimeArtifacts).orderBy(runtimeArtifacts.ordinal),
      db
        .select()
        .from(scenarioRunArtifacts)
        .orderBy(scenarioRunArtifacts.ordinal),
    ]);
    expect(runtimeRows.map((artifact) => artifact.ordinal)).toEqual([1, 2, 3]);
    expect(legacyRows.map((artifact) => artifact.ordinal)).toEqual([1, 2, 3]);
    expect(legacyRows.map((artifact) => artifact.r2Key)).toEqual(
      runtimeRows.map((artifact) => artifact.r2Key),
    );
    expect(
      (
        await agentRequest(
          token,
          "/agent/runs/scenario-execution/vms/scenario-vm/artifacts/3/multipart-begin",
          "POST",
        )
      ).status,
    ).toBe(200);

    const retry = await beginUploadArtifacts(
      token,
      "scenario-execution",
      "scenario-vm",
      artifacts,
    );
    expect(retry.status).toBe(200);
    await expect(db.select().from(runtimeArtifacts)).resolves.toHaveLength(3);
    await expect(db.select().from(scenarioRunArtifacts)).resolves.toHaveLength(
      3,
    );

    const conflict = await beginUploadArtifacts(
      token,
      "scenario-execution",
      "scenario-vm",
      artifacts.map((artifact) =>
        artifact.ordinal === 2
          ? { ...artifact, filename: "changed.log" }
          : artifact,
      ),
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: "artifact 2 metadata does not match existing upload",
    });
    await expect(db.select().from(runtimeArtifacts)).resolves.toHaveLength(3);
    await expect(db.select().from(scenarioRunArtifacts)).resolves.toHaveLength(
      3,
    );
  });

  it("does not reserve a racing conflicting manifest's extra ordinals", async () => {
    const token = await seedScenarioRuntime();
    const winner = artifactDescriptor("console_log", "winner.log");
    const conflicting = [
      { ...winner, filename: "conflicting.log" },
      artifactDescriptor("console_log", "must-not-land.log", 0, 2),
    ];

    let releaseFirstBatch: () => void = () => undefined;
    const firstBatchGate = new Promise<void>((resolve) => {
      releaseFirstBatch = resolve;
    });
    let signalFirstBatch: () => void = () => undefined;
    const firstBatchReached = new Promise<void>((resolve) => {
      signalFirstBatch = resolve;
    });
    let delayFirstBatch = true;
    const delayedD1 = new Proxy(env.DB, {
      get(target, property, receiver) {
        if (property === "batch") {
          return async (...statements: Parameters<D1Database["batch"]>) => {
            if (delayFirstBatch) {
              delayFirstBatch = false;
              signalFirstBatch();
              await firstBatchGate;
            }
            return target.batch(...statements);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    const delayedEnv = new Proxy(env, {
      get(target, property, receiver) {
        return property === "DB"
          ? delayedD1
          : Reflect.get(target, property, receiver);
      },
    }) as Cloudflare.Env;

    const conflictingRequest = beginUploadArtifacts(
      token,
      "scenario-execution",
      "scenario-vm",
      conflicting,
      undefined,
      delayedEnv,
    );
    await firstBatchReached;
    const winningResponse = await beginUploadArtifacts(
      token,
      "scenario-execution",
      "scenario-vm",
      [winner],
    );
    releaseFirstBatch();
    const conflictingResponse = await conflictingRequest;

    expect(winningResponse.status).toBe(200);
    expect(conflictingResponse.status).toBe(409);
    const db = drizzle(env.DB);
    const [runtimeRows, legacyRows] = await Promise.all([
      db.select().from(runtimeArtifacts).orderBy(runtimeArtifacts.ordinal),
      db
        .select()
        .from(scenarioRunArtifacts)
        .orderBy(scenarioRunArtifacts.ordinal),
    ]);
    expect(runtimeRows.map((row) => row.ordinal)).toEqual([1]);
    expect(legacyRows.map((row) => row.ordinal)).toEqual([1]);
    expect(runtimeRows[0]?.filename).toBe("winner.log");
    expect(legacyRows[0]?.filename).toBe("winner.log");
  });

  it("rejects a dual-ledger divergence before it reserves a later ordinal", async () => {
    const token = await seedScenarioRuntime();
    const first = artifactDescriptor("console_log", "one.log");
    expect(
      (
        await beginUploadArtifacts(token, "scenario-execution", "scenario-vm", [
          first,
        ])
      ).status,
    ).toBe(200);

    const db = drizzle(env.DB);
    await db
      .update(scenarioRunArtifacts)
      .set({ filename: "diverged.log" })
      .where(eq(scenarioRunArtifacts.ordinal, 1));

    const response = await beginUploadArtifacts(
      token,
      "scenario-execution",
      "scenario-vm",
      [first, artifactDescriptor("console_log", "must-not-land.log", 0, 2)],
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "artifact 1 metadata does not match existing upload",
    });
    const [runtimeRows, legacyRows] = await Promise.all([
      db.select().from(runtimeArtifacts).orderBy(runtimeArtifacts.ordinal),
      db
        .select()
        .from(scenarioRunArtifacts)
        .orderBy(scenarioRunArtifacts.ordinal),
    ]);
    expect(runtimeRows.map((row) => row.ordinal)).toEqual([1]);
    expect(legacyRows.map((row) => row.ordinal)).toEqual([1]);
  });

  it("requires both modern scenario ledgers while allowing a matching subset retry", async () => {
    const token = await seedScenarioRuntime();
    const first = artifactDescriptor("console_log", "one.log");
    const second = artifactDescriptor("console_log", "two.log", 0, 2);
    expect(
      (
        await beginUploadArtifacts(token, "scenario-execution", "scenario-vm", [
          first,
          second,
        ])
      ).status,
    ).toBe(200);
    expect(
      (
        await beginUploadArtifacts(token, "scenario-execution", "scenario-vm", [
          first,
        ])
      ).status,
    ).toBe(200);

    const db = drizzle(env.DB);
    await db
      .delete(scenarioRunArtifacts)
      .where(eq(scenarioRunArtifacts.ordinal, 2));
    const splitLedger = await beginUploadArtifacts(
      token,
      "scenario-execution",
      "scenario-vm",
      [
        first,
        second,
        artifactDescriptor("console_log", "must-not-land.log", 0, 3),
      ],
    );
    expect(splitLedger.status).toBe(409);
    await expect(splitLedger.json()).resolves.toMatchObject({
      error: "artifact 2 metadata does not match existing upload",
    });
    await expect(db.select().from(runtimeArtifacts)).resolves.toHaveLength(2);
    await expect(db.select().from(scenarioRunArtifacts)).resolves.toHaveLength(
      1,
    );
  });

  it("bounds begin bodies, descriptor count, descriptor fields, and R2 keys", async () => {
    const token = await seedScenarioRuntime();
    const descriptors = Array.from({ length: 1024 }, (_, index) =>
      artifactDescriptor(
        "console_log",
        `artifact-${index + 1}.log`,
        0,
        index + 1,
      ),
    );
    expect(
      (
        await beginUploadArtifacts(
          token,
          "scenario-execution",
          "scenario-vm",
          descriptors,
        )
      ).status,
    ).toBe(200);

    const db = drizzle(env.DB);
    await expect(db.select().from(runtimeArtifacts)).resolves.toHaveLength(
      1024,
    );
    await expect(db.select().from(scenarioRunArtifacts)).resolves.toHaveLength(
      1024,
    );
    expect(
      (
        await beginUploadArtifacts(token, "scenario-execution", "scenario-vm", [
          ...descriptors,
          artifactDescriptor("console_log", "too-many.log", 0, 1025),
        ])
      ).status,
    ).toBe(400);

    for (const invalid of [
      artifactDescriptor("k".repeat(65), "valid.log"),
      artifactDescriptor("console_log", "🙂".repeat(64)),
      {
        ...artifactDescriptor("console_log", "valid.log"),
        contentType: "a".repeat(256),
      },
      {
        ...artifactDescriptor("console_log", "valid.log"),
        sha256: "A".repeat(64),
      },
      {
        ...artifactDescriptor("console_log", "valid.log"),
        sizeBytes: Number.MAX_SAFE_INTEGER + 1,
      },
    ]) {
      expect(
        (
          await beginUploadArtifacts(
            token,
            "scenario-execution",
            "scenario-vm",
            [invalid],
          )
        ).status,
      ).toBe(400);
    }

    const oversizedResponse = await agentRawRequest(
      token,
      "/agent/runs/begin",
      "POST",
      JSON.stringify({
        runId: "scenario-execution",
        vmName: "scenario-vm",
        artifacts: [],
        padding: "x".repeat(2 * 1024 * 1024),
      }),
    );
    expect(oversizedResponse.status).toBe(413);

    const boundaryKey = buildArtifactObjectKey({
      runId: "r".repeat(128),
      vmId: "v".repeat(128),
      ordinal: 1024,
      kind: "k".repeat(64),
      filename: "f".repeat(255),
    });
    expect(
      new TextEncoder().encode(boundaryKey).byteLength,
    ).toBeLessThanOrEqual(1024);
    expect(() =>
      buildArtifactObjectKey({
        runId: "r".repeat(128),
        vmId: "v".repeat(128),
        ordinal: 1024,
        kind: "k".repeat(64),
        filename: "f".repeat(1_000),
      }),
    ).toThrow(/R2 key byte limit/);
  });

  it("retries an exact pre-limit manifest through the normal archiving transition", async () => {
    const token = await seedScenarioRuntime();
    const artifacts = oversizedArtifactDescriptors();
    await seedScenarioArtifactManifest(artifacts);

    const db = drizzle(env.DB);
    const [storedRun] = await db
      .select({ stateJson: scenarioRuns.stateJson })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, "scenario-execution"));
    const archivedState = JSON.parse(
      storedRun?.stateJson ?? "{}",
    ) as Parameters<typeof recomputeRunState>[0];
    const preArchivingState = recomputeRunState({
      ...archivedState,
      vms: archivedState.vms.map((vm) => ({
        ...vm,
        phase: "destroying",
      })),
    });
    const preparedAt = Date.now();
    await db
      .update(runtimeExecutions)
      .set({
        state: "ready",
        archiveRequestedAt: null,
        updatedAt: preparedAt,
      })
      .where(eq(runtimeExecutions.id, "scenario-execution"));
    await db
      .update(runtimeVms)
      .set({ archiveStageRank: null, updatedAt: preparedAt })
      .where(eq(runtimeVms.id, "scenario-runtime-vm"));
    await db
      .update(scenarioRuns)
      .set({
        state: preArchivingState.phase,
        stateRank: RUN_PHASE_ORDER[preArchivingState.phase],
        stateJson: JSON.stringify(preArchivingState),
        updatedAt: preparedAt,
      })
      .where(eq(scenarioRuns.runId, "scenario-execution"));

    const before = await scenarioArtifactLedgerSnapshot(db);
    expect(before.runtimeExecution).toMatchObject({ state: "ready" });
    expect(before.scenarioRun).toMatchObject({ state: "tearing_down" });
    const response = await beginUploadArtifacts(
      token,
      "scenario-execution",
      "scenario-vm",
      artifacts,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      archiveProgressVersion: 1,
    });
    const after = await scenarioArtifactLedgerSnapshot(db);
    expect(after.runtime).toEqual(before.runtime);
    expect(after.legacy).toEqual(before.legacy);
    expect(after.runtimeExecution).toMatchObject({
      state: "archiving",
      archiveRequestedAt: expect.any(Number),
    });
    expect(after.runtimeVm).toMatchObject({ archiveStageRank: 1 });
    expect(after.scenarioRun).toMatchObject({ state: "archiving" });
    const transitionedState = JSON.parse(
      after.scenarioRun?.stateJson ?? "{}",
    ) as {
      vms: Array<{ id: string; phase: string }>;
    };
    expect(
      transitionedState.vms.find((vm) => vm.id === "scenario-vm-id")?.phase,
    ).toBe("archived");
  });

  it("rejects a mismatched legacy ledger for an oversized retry without mutation", async () => {
    const token = await seedScenarioRuntime();
    const artifacts = oversizedArtifactDescriptors();
    await seedScenarioArtifactManifest(artifacts);

    const db = drizzle(env.DB);
    await db
      .update(scenarioRunArtifacts)
      .set({ filename: "diverged.log" })
      .where(eq(scenarioRunArtifacts.ordinal, artifacts.length));
    const before = await scenarioArtifactLedgerSnapshot(db);
    const response = await beginUploadArtifacts(
      token,
      "scenario-execution",
      "scenario-vm",
      artifacts,
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "artifact manifest does not match existing upload",
    });
    await expect(scenarioArtifactLedgerSnapshot(db)).resolves.toEqual(before);
  });

  it("rejects a new oversized manifest", async () => {
    const token = await seedScenarioRuntime();
    const response = await beginUploadArtifacts(
      token,
      "scenario-execution",
      "scenario-vm",
      oversizedArtifactDescriptors(),
    );

    expect(response.status).toBe(400);
    const db = drizzle(env.DB);
    const snapshot = await scenarioArtifactLedgerSnapshot(db);
    expect(snapshot.runtime).toEqual([]);
    expect(snapshot.legacy).toEqual([]);
  });

  it("batches a multi-session scenario timeline before one ordered state update", async () => {
    const token = await seedScenarioRuntime();
    const artifacts = [
      artifactDescriptor("ssh_recording_segment", "session-1.cast", 0, 1),
      artifactDescriptor("ssh_recording_segment", "session-2.cast", 0, 2),
      artifactDescriptor("ssh_recording_segment", "session-3.cast", 0, 3),
    ];
    expect(
      (
        await beginUploadArtifacts(
          token,
          "scenario-execution",
          "scenario-vm",
          artifacts,
        )
      ).status,
    ).toBe(200);
    for (const artifact of artifacts) {
      expect(
        (
          await agentRequest(
            token,
            `/agent/runs/scenario-execution/vms/scenario-vm/artifacts/${artifact.ordinal}/multipart-begin`,
            "POST",
          )
        ).status,
      ).toBe(200);
    }

    const timeline = {
      version: 1,
      sessions: [
        {
          index: 1,
          startTimestampMs: 1_000,
          durationMs: 100,
          exitCode: 0,
          castFilename: "session-1.cast",
          transcript: "one",
        },
        {
          index: 2,
          startTimestampMs: 1_200,
          durationMs: 100,
          exitCode: 0,
          castFilename: "session-2.cast",
          transcript: "two",
        },
        {
          index: 3,
          startTimestampMs: 1_400,
          durationMs: 100,
          exitCode: 0,
          castFilename: "session-3.cast",
          transcript: "three",
        },
      ],
    };
    expect(
      (
        await agentRequest(
          token,
          "/agent/runs/scenario-execution/vms/scenario-vm/timeline",
          "POST",
          timeline,
        )
      ).status,
    ).toBe(200);

    const db = drizzle(env.DB);
    const [terminalRows, transcriptRows, artifactRows, runRows] =
      await Promise.all([
        db
          .select()
          .from(runtimeTerminalSessions)
          .orderBy(runtimeTerminalSessions.ordinal),
        db
          .select()
          .from(scenarioRunSessionTranscripts)
          .orderBy(scenarioRunSessionTranscripts.sessionIndex),
        db.select().from(runtimeArtifacts).orderBy(runtimeArtifacts.ordinal),
        db
          .select({ stateJson: scenarioRuns.stateJson })
          .from(scenarioRuns)
          .where(eq(scenarioRuns.runId, "scenario-execution")),
      ]);
    expect(terminalRows.map((session) => session.ordinal)).toEqual([1, 2, 3]);
    expect(terminalRows.map((session) => session.recordingArtifactId)).toEqual(
      artifactRows.map((artifact) => artifact.id),
    );
    expect(transcriptRows.map((session) => session.transcript)).toEqual([
      "one",
      "two",
      "three",
    ]);
    const state = JSON.parse(runRows[0]?.stateJson ?? "{}") as {
      vms: Array<{ id: string; sessionTimeline?: Array<{ index: number }> }>;
    };
    expect(
      state.vms
        .find((vm) => vm.id === "scenario-vm-id")
        ?.sessionTimeline?.map((session) => session.index),
    ).toEqual([1, 2, 3]);

    expect(
      (
        await agentRequest(
          token,
          "/agent/runs/scenario-execution/vms/scenario-vm/timeline",
          "POST",
          timeline,
        )
      ).status,
    ).toBe(200);
    await expect(
      db.select().from(runtimeTerminalSessions),
    ).resolves.toHaveLength(3);
    await expect(
      db.select().from(scenarioRunSessionTranscripts),
    ).resolves.toHaveLength(3);
  });

  it("merges concurrent scenario timelines for different VMs", async () => {
    const token = await seedScenarioRuntime({ vms: 2 });
    const firstArtifact = artifactDescriptor(
      "ssh_recording_segment",
      "first-session.cast",
    );
    const secondArtifact = artifactDescriptor(
      "ssh_recording_segment",
      "second-session.cast",
    );
    for (const [vmName, artifact] of [
      ["scenario-vm", firstArtifact],
      ["scenario-vm-2", secondArtifact],
    ] as const) {
      expect(
        (await beginUpload(token, "scenario-execution", vmName, artifact))
          .status,
      ).toBe(200);
      expect(
        (
          await agentRequest(
            token,
            `/agent/runs/scenario-execution/vms/${vmName}/artifacts/1/multipart-begin`,
            "POST",
          )
        ).status,
      ).toBe(200);
    }

    const [firstTimeline, secondTimeline] = await Promise.all([
      agentRequest(
        token,
        "/agent/runs/scenario-execution/vms/scenario-vm/timeline",
        "POST",
        {
          version: 1,
          sessions: [
            {
              index: 1,
              startTimestampMs: 1_000,
              durationMs: 100,
              castFilename: firstArtifact.filename,
              transcript: "first transcript",
            },
          ],
        },
      ),
      agentRequest(
        token,
        "/agent/runs/scenario-execution/vms/scenario-vm-2/timeline",
        "POST",
        {
          version: 1,
          sessions: [
            {
              index: 1,
              startTimestampMs: 2_000,
              durationMs: 100,
              castFilename: secondArtifact.filename,
              transcript: "second transcript",
            },
          ],
        },
      ),
    ]);
    expect(firstTimeline.status).toBe(200);
    expect(secondTimeline.status).toBe(200);

    const db = drizzle(env.DB);
    const [terminalRows, transcriptRows, runRows] = await Promise.all([
      db
        .select()
        .from(runtimeTerminalSessions)
        .where(eq(runtimeTerminalSessions.executionId, "scenario-execution"))
        .orderBy(runtimeTerminalSessions.runtimeVmId),
      db
        .select()
        .from(scenarioRunSessionTranscripts)
        .where(eq(scenarioRunSessionTranscripts.runId, "scenario-execution"))
        .orderBy(scenarioRunSessionTranscripts.vmId),
      db
        .select({ stateJson: scenarioRuns.stateJson })
        .from(scenarioRuns)
        .where(eq(scenarioRuns.runId, "scenario-execution")),
    ]);
    expect(terminalRows.map((row) => row.runtimeVmId)).toEqual([
      "scenario-runtime-vm",
      "scenario-runtime-vm-2",
    ]);
    expect(transcriptRows).toHaveLength(2);
    expect(transcriptRows.map((row) => row.transcript)).toEqual(
      expect.arrayContaining(["first transcript", "second transcript"]),
    );
    const state = JSON.parse(runRows[0]?.stateJson ?? "{}") as {
      vms: Array<{
        id: string;
        sessionTimeline?: Array<{ castFilename: string }>;
      }>;
    };
    expect(
      state.vms.find((vm) => vm.id === "scenario-vm-id")?.sessionTimeline,
    ).toMatchObject([{ castFilename: "first-session.cast" }]);
    expect(
      state.vms.find((vm) => vm.id === "scenario-vm-2-id")?.sessionTimeline,
    ).toMatchObject([{ castFilename: "second-session.cast" }]);
  });

  it("does not publish a partial timeline when its D1 batch fails", async () => {
    const token = await seedScenarioRuntime();
    const artifacts = [
      artifactDescriptor("ssh_recording_segment", "session-1.cast", 0, 1),
      artifactDescriptor("ssh_recording_segment", "session-2.cast", 0, 2),
    ];
    await beginUploadArtifacts(
      token,
      "scenario-execution",
      "scenario-vm",
      artifacts,
    );
    for (const artifact of artifacts) {
      await agentRequest(
        token,
        `/agent/runs/scenario-execution/vms/scenario-vm/artifacts/${artifact.ordinal}/multipart-begin`,
        "POST",
      );
    }

    const db = drizzle(env.DB);
    await db.insert(scenarioRunSessionTranscripts).values({
      id: "scenario-vm-id:session:2",
      runId: "scenario-execution",
      vmId: "different-vm",
      sessionIndex: 2,
      transcript: "existing transcript",
      createdAt: Date.now(),
    });

    await expect(
      agentRequest(
        token,
        "/agent/runs/scenario-execution/vms/scenario-vm/timeline",
        "POST",
        {
          version: 1,
          sessions: [
            {
              index: 1,
              startTimestampMs: 1_000,
              durationMs: 100,
              castFilename: "session-1.cast",
              transcript: "one",
            },
            {
              index: 2,
              startTimestampMs: 1_200,
              durationMs: 100,
              castFilename: "session-2.cast",
              transcript: "two",
            },
          ],
        },
      ),
    ).rejects.toThrow(/UNIQUE constraint failed/);

    const [terminalRows, transcriptRows, runRows] = await Promise.all([
      db
        .select()
        .from(runtimeTerminalSessions)
        .where(eq(runtimeTerminalSessions.runtimeVmId, "scenario-runtime-vm")),
      db
        .select()
        .from(scenarioRunSessionTranscripts)
        .where(eq(scenarioRunSessionTranscripts.vmId, "scenario-vm-id")),
      db
        .select({ stateJson: scenarioRuns.stateJson })
        .from(scenarioRuns)
        .where(eq(scenarioRuns.runId, "scenario-execution")),
    ]);
    expect(terminalRows).toHaveLength(0);
    expect(transcriptRows).toHaveLength(0);
    const state = JSON.parse(runRows[0]?.stateJson ?? "{}") as {
      vms: Array<{ id: string; sessionTimeline?: unknown }>;
    };
    expect(
      state.vms.find((vm) => vm.id === "scenario-vm-id")?.sessionTimeline,
    ).toBeNull();
  });

  it("rolls back every timeline row and state after a later D1 statement fails", async () => {
    const token = await seedScenarioRuntime();
    const db = drizzle(env.DB);
    const now = Date.now();
    const artifacts = Array.from({ length: 51 }, (_, index) => {
      const ordinal = index + 1;
      return {
        id: `scenario-vm-id:${ordinal}`,
        ordinal,
        filename: `session-${ordinal}.cast`,
        r2Key: `test/segments/${ordinal}.cast`,
      };
    });
    await env.DB.batch(
      artifacts
        .flatMap((artifact) => [
          db.insert(runtimeArtifacts).values({
            id: artifact.id,
            executionId: "scenario-execution",
            runtimeVmId: "scenario-runtime-vm",
            ordinal: artifact.ordinal,
            kind: "ssh_recording_segment",
            filename: artifact.filename,
            contentType: "application/x-asciicast",
            sizeBytes: 0,
            sha256: "a".repeat(64),
            r2Key: artifact.r2Key,
            uploadStatus: "uploaded",
            createdAt: now,
            uploadedAt: now,
          }),
          db.insert(scenarioRunArtifacts).values({
            id: artifact.id,
            runId: "scenario-execution",
            vmId: "scenario-vm-id",
            ordinal: artifact.ordinal,
            kind: "ssh_recording_segment",
            filename: artifact.filename,
            contentType: "application/x-asciicast",
            sizeBytes: 0,
            sha256: "a".repeat(64),
            r2Key: artifact.r2Key,
            uploadStatus: "uploaded",
            createdAt: now,
            uploadedAt: now,
          }),
        ])
        .map((statement) => drizzleQueryToD1Statement(env.DB, statement)),
    );

    const timeline = {
      version: 1,
      sessions: artifacts.map((artifact) => ({
        index: artifact.ordinal,
        startTimestampMs: artifact.ordinal * 1_000,
        durationMs: 100,
        castFilename: artifact.filename,
        transcript: `transcript ${artifact.ordinal}`,
      })),
    };
    const conflictingId = "scenario-vm-id:session:51";
    await db.insert(scenarioRunSessionTranscripts).values({
      id: conflictingId,
      runId: "scenario-execution",
      vmId: "different-vm",
      sessionIndex: 51,
      transcript: "existing transcript",
      createdAt: now,
    });

    await expect(
      agentRequest(
        token,
        "/agent/runs/scenario-execution/vms/scenario-vm/timeline",
        "POST",
        timeline,
      ),
    ).rejects.toThrow(/UNIQUE constraint failed/);

    const [partialTerminalRows, partialTranscriptRows, partialRunRows] =
      await Promise.all([
        db
          .select()
          .from(runtimeTerminalSessions)
          .where(
            eq(runtimeTerminalSessions.runtimeVmId, "scenario-runtime-vm"),
          ),
        db
          .select()
          .from(scenarioRunSessionTranscripts)
          .where(eq(scenarioRunSessionTranscripts.vmId, "scenario-vm-id")),
        db
          .select({ stateJson: scenarioRuns.stateJson })
          .from(scenarioRuns)
          .where(eq(scenarioRuns.runId, "scenario-execution")),
      ]);
    expect(partialTerminalRows).toHaveLength(0);
    expect(partialTranscriptRows).toHaveLength(0);
    const partialState = JSON.parse(partialRunRows[0]?.stateJson ?? "{}") as {
      vms: Array<{ id: string; sessionTimeline?: unknown }>;
    };
    expect(
      partialState.vms.find((vm) => vm.id === "scenario-vm-id")
        ?.sessionTimeline,
    ).toBeNull();

    await db
      .delete(scenarioRunSessionTranscripts)
      .where(eq(scenarioRunSessionTranscripts.id, conflictingId));
    expect(
      (
        await agentRequest(
          token,
          "/agent/runs/scenario-execution/vms/scenario-vm/timeline",
          "POST",
          timeline,
        )
      ).status,
    ).toBe(200);

    const [terminalRows, transcriptRows, runRows] = await Promise.all([
      db
        .select()
        .from(runtimeTerminalSessions)
        .where(eq(runtimeTerminalSessions.runtimeVmId, "scenario-runtime-vm")),
      db
        .select()
        .from(scenarioRunSessionTranscripts)
        .where(eq(scenarioRunSessionTranscripts.vmId, "scenario-vm-id")),
      db
        .select({ stateJson: scenarioRuns.stateJson })
        .from(scenarioRuns)
        .where(eq(scenarioRuns.runId, "scenario-execution")),
    ]);
    expect(terminalRows).toHaveLength(51);
    expect(transcriptRows).toHaveLength(51);
    const state = JSON.parse(runRows[0]?.stateJson ?? "{}") as {
      vms: Array<{ id: string; sessionTimeline?: Array<{ index: number }> }>;
    };
    expect(
      state.vms
        .find((vm) => vm.id === "scenario-vm-id")
        ?.sessionTimeline?.map((session) => session.index),
    ).toEqual(artifacts.map((artifact) => artifact.ordinal));
  });

  it("rejects multibyte and aggregate transcript payloads above their byte budgets", async () => {
    const token = await seedScenarioRuntime();
    const tooLargeMultibyteTranscript = "🙂".repeat(375_001);
    expect(
      (
        await agentRequest(
          token,
          "/agent/runs/scenario-execution/vms/scenario-vm/timeline",
          "POST",
          {
            version: 1,
            sessions: [
              {
                index: 1,
                startTimestampMs: 1_000,
                durationMs: 100,
                castFilename: "session-1.cast",
                transcript: tooLargeMultibyteTranscript,
              },
            ],
          },
        )
      ).status,
    ).toBe(400);

    const mebibyte = 1024 * 1024;
    const individuallyValidTranscript = "a".repeat(mebibyte);
    expect(
      (
        await agentRequest(
          token,
          "/agent/runs/scenario-execution/vms/scenario-vm/timeline",
          "POST",
          {
            version: 1,
            sessions: Array.from({ length: 5 }, (_, index) => ({
              index: index + 1,
              startTimestampMs: 1_000 + index * 100,
              durationMs: 100,
              castFilename: `session-${index + 1}.cast`,
              transcript: individuallyValidTranscript,
            })),
          },
        )
      ).status,
    ).toBe(400);
  });

  it("requires dense timeline indexes in request order", async () => {
    const token = await seedScenarioRuntime();
    for (const indexes of [[2], [1, 3], [2, 1], [1, 1]]) {
      expect(
        (
          await agentRequest(
            token,
            "/agent/runs/scenario-execution/vms/scenario-vm/timeline",
            "POST",
            {
              version: 1,
              sessions: indexes.map((index, offset) => ({
                index,
                startTimestampMs: 1_000 + offset * 100,
                durationMs: 100,
                castFilename: `session-${offset + 1}.cast`,
                transcript: "transcript",
              })),
            },
          )
        ).status,
      ).toBe(400);
    }
  });

  it("requires every timeline cast to be an uploaded recording segment", async () => {
    const token = await seedScenarioRuntime();
    const segment = artifactDescriptor(
      "ssh_recording_segment",
      "session-1.cast",
    );
    await beginUpload(token, "scenario-execution", "scenario-vm", segment);
    const timeline = {
      version: 1,
      sessions: [
        {
          index: 1,
          startTimestampMs: 1_000,
          durationMs: 100,
          castFilename: "session-1.cast",
          transcript: "transcript",
        },
      ],
    };
    expect(
      (
        await agentRequest(
          token,
          "/agent/runs/scenario-execution/vms/scenario-vm/timeline",
          "POST",
          timeline,
        )
      ).status,
    ).toBe(409);

    expect(
      (
        await agentRequest(
          token,
          "/agent/runs/scenario-execution/vms/scenario-vm/artifacts/1/multipart-begin",
          "POST",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await agentRequest(
          token,
          "/agent/runs/scenario-execution/vms/scenario-vm/timeline",
          "POST",
          timeline,
        )
      ).status,
    ).toBe(200);
  });

  it("rejects a non-recording artifact as timeline media", async () => {
    const token = await seedScenarioRuntime();
    await beginUpload(
      token,
      "scenario-execution",
      "scenario-vm",
      artifactDescriptor("console_log", "session-1.cast"),
    );
    await agentRequest(
      token,
      "/agent/runs/scenario-execution/vms/scenario-vm/artifacts/1/multipart-begin",
      "POST",
    );

    expect(
      (
        await agentRequest(
          token,
          "/agent/runs/scenario-execution/vms/scenario-vm/timeline",
          "POST",
          {
            version: 1,
            sessions: [
              {
                index: 1,
                startTimestampMs: 1_000,
                durationMs: 100,
                castFilename: "session-1.cast",
                transcript: "transcript",
              },
            ],
          },
        )
      ).status,
    ).toBe(409);
  });

  it("records monotonic archive stages from begin through final sealing", async () => {
    const token = await seedScenarioRuntime();
    const descriptor = artifactDescriptor("console_log", "console.log");
    const db = drizzle(env.DB);

    // /begin is the durable archive hand-off, so rank one does not depend on
    // a separate best-effort stage callback.
    expect(
      (
        await beginUpload(
          token,
          "scenario-execution",
          "scenario-vm",
          descriptor,
        )
      ).status,
    ).toBe(200);
    await expectArchiveStageRank(db, "scenario-runtime-vm", 1);

    for (const [stage, expectedRank] of [
      // Rank three cannot skip the files-saved milestone.
      ["replay_prepared", 1],
      ["raw_files_saved", 2],
      ["replay_prepared", 3],
      // Late callbacks must never move a VM backward.
      ["raw_files_saved", 3],
      ["replay_skipped", 3],
    ] as const) {
      expect(
        (
          await agentRequest(
            token,
            "/agent/runs/scenario-execution/vms/scenario-vm/archive-stage",
            "POST",
            { stage },
          )
        ).status,
      ).toBe(200);
      await expectArchiveStageRank(db, "scenario-runtime-vm", expectedRank);
    }

    const concurrentCallbacks = await Promise.all([
      agentRequest(
        token,
        "/agent/runs/scenario-execution/vms/scenario-vm/archive-stage",
        "POST",
        { stage: "raw_files_saved" },
      ),
      agentRequest(
        token,
        "/agent/runs/scenario-execution/vms/scenario-vm/archive-stage",
        "POST",
        { stage: "replay_skipped" },
      ),
    ]);
    expect(concurrentCallbacks.map((response) => response.status)).toEqual([
      200, 200,
    ]);
    await expectArchiveStageRank(db, "scenario-runtime-vm", 3);

    expect(
      (
        await agentRequest(
          token,
          "/agent/runs/scenario-execution/vms/scenario-vm/archive-stage",
          "POST",
          { stage: "not-a-stage" },
        )
      ).status,
    ).toBe(400);

    expect(
      (
        await agentRequest(
          token,
          "/agent/runs/scenario-execution/vms/scenario-vm/artifacts/1/multipart-begin",
          "POST",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await agentRequest(
          token,
          "/agent/runs/scenario-execution/vms/scenario-vm/complete",
          "POST",
        )
      ).status,
    ).toBe(200);
    await expectArchiveStageRank(db, "scenario-runtime-vm", 4);

    const sealedRetry = await beginUpload(
      token,
      "scenario-execution",
      "scenario-vm",
      descriptor,
    );
    expect(sealedRetry.status).toBe(200);
    await expect(sealedRetry.json()).resolves.toMatchObject({
      archiveProgressVersion: 1,
    });

    // A duplicate, delayed stage notification remains safe after sealing.
    expect(
      (
        await agentRequest(
          token,
          "/agent/runs/scenario-execution/vms/scenario-vm/archive-stage",
          "POST",
          { stage: "raw_files_saved" },
        )
      ).status,
    ).toBe(200);
    await expectArchiveStageRank(db, "scenario-runtime-vm", 4);
  });

  it("keeps legacy and unknown begin capabilities on the coarse save fallback", async () => {
    const token = await seedScenarioRuntime();
    const descriptor = artifactDescriptor("console_log", "console.log");
    const db = drizzle(env.DB);

    // Old agents omit the capability. A future or malformed version must not
    // opt into a partial five-step flow either.
    const legacyBegin = await beginUpload(
      token,
      "scenario-execution",
      "scenario-vm",
      descriptor,
      { archiveProgressVersion: null },
    );
    expect(legacyBegin.status).toBe(200);
    await expect(legacyBegin.json()).resolves.not.toHaveProperty(
      "archiveProgressVersion",
    );
    await expectArchiveStageRank(db, "scenario-runtime-vm", null);
    expect(
      (
        await getScenarioRunForUser({
          runId: "scenario-execution",
          userId: "scenario-owner",
        })
      ).savingStage,
    ).toBe("closing_workspace");

    const unknownBegin = await beginUpload(
      token,
      "scenario-execution",
      "scenario-vm",
      descriptor,
      { archiveProgressVersion: 2 },
    );
    expect(unknownBegin.status).toBe(200);
    await expect(unknownBegin.json()).resolves.not.toHaveProperty(
      "archiveProgressVersion",
    );
    await expectArchiveStageRank(db, "scenario-runtime-vm", null);

    expect(
      (
        await agentRequest(
          token,
          "/agent/runs/scenario-execution/vms/scenario-vm/artifacts/1/multipart-begin",
          "POST",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await agentRequest(
          token,
          "/agent/runs/scenario-execution/vms/scenario-vm/complete",
          "POST",
        )
      ).status,
    ).toBe(200);
    await expectArchiveStageRank(db, "scenario-runtime-vm", null);
  });

  it("publishes only the slowest modern VM's learner-safe archive stage", async () => {
    await seedScenarioRuntime();
    const db = drizzle(env.DB);
    await db.insert(runtimeVms).values({
      id: "scenario-runtime-vm-2",
      executionId: "scenario-execution",
      vmId: "scenario-vm-id-2",
      ordinal: 1,
      runtimeVmName: "scenario-vm-2",
      imageKeyJson: { scenario: "scenario", vm: "vm-2", arch: "x86_64" },
      imageSha256: "b".repeat(64),
      cpuMillis: 4_000,
      memoryMib: 16_384,
      diskMib: 102_400,
      artifactWritesSealed: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await db
      .update(runtimeVms)
      .set({ archiveStageRank: 3 })
      .where(eq(runtimeVms.id, "scenario-runtime-vm"));

    // An older or lagging VM is a safe coarse fallback, never a false
    // indication that replay work has begun for every machine.
    expect(
      (
        await getScenarioRunForUser({
          runId: "scenario-execution",
          userId: "scenario-owner",
        })
      ).savingStage,
    ).toBe("closing_workspace");

    for (const [rank, expectedStage] of [
      [1, "saving_files"],
      [2, "preparing_replay"],
      [3, "finalizing_recap"],
    ] as const) {
      await db
        .update(runtimeVms)
        .set({ archiveStageRank: rank })
        .where(eq(runtimeVms.id, "scenario-runtime-vm-2"));
      expect(
        (
          await getScenarioRunForUser({
            runId: "scenario-execution",
            userId: "scenario-owner",
          })
        ).savingStage,
      ).toBe(expectedStage);
    }

    const learnerRun = await getScenarioRunForUser({
      runId: "scenario-execution",
      userId: "scenario-owner",
    });
    expect(JSON.stringify(learnerRun)).not.toContain("archiveStageRank");
    expect(JSON.stringify(learnerRun)).not.toContain("raw_files_saved");
  });

  it("archives a workshop recording and terminal timeline on its exact generation", async () => {
    const fixture = await seedWorkshopRuntime({ generations: 1 });
    const descriptor = artifactDescriptor(
      "ssh_recording_segment",
      "session-1.cast",
      5,
    );

    expect(
      (
        await beginUpload(
          fixture.token1,
          "execution-1",
          "workshop-vm-1",
          descriptor,
        )
      ).status,
    ).toBe(200);
    await agentRequest(
      fixture.token1,
      "/agent/runs/execution-1/vms/workshop-vm-1/artifacts/1/multipart-begin",
      "POST",
    );
    expect(
      (
        await agentRawRequest(
          fixture.token1,
          "/agent/runs/execution-1/vms/workshop-vm-1/artifacts/1/parts/1",
          "PUT",
          "hello",
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await agentRequest(
          fixture.token1,
          "/agent/runs/execution-1/vms/workshop-vm-1/artifacts/1/complete",
          "POST",
        )
      ).status,
    ).toBe(200);
    const timeline = await agentRequest(
      fixture.token1,
      "/agent/runs/execution-1/vms/workshop-vm-1/timeline",
      "POST",
      {
        version: 1,
        sessions: [
          {
            index: 1,
            startTimestampMs: 1_000,
            durationMs: 250,
            exitCode: 0,
            castFilename: "session-1.cast",
            transcript: "$ verify\npass\n",
          },
        ],
      },
    );
    expect(timeline.status).toBe(200);
    expect(
      (
        await agentRequest(
          fixture.token1,
          "/agent/runs/execution-1/vms/workshop-vm-1/complete",
          "POST",
        )
      ).status,
    ).toBe(200);

    const db = drizzle(env.DB);
    const [artifact] = await db.select().from(runtimeArtifacts);
    const [terminal] = await db.select().from(runtimeTerminalSessions);
    expect(artifact).toMatchObject({
      executionId: "execution-1",
      runtimeVmId: "runtime-vm-1",
      uploadStatus: "uploaded",
    });
    expect(terminal).toMatchObject({
      executionId: "execution-1",
      runtimeVmId: "runtime-vm-1",
      recordingArtifactId: artifact?.id,
      startedAt: 1_000,
      endedAt: 1_250,
      exitCode: 0,
    });
    expect(terminal?.transcriptR2Key).toBeTruthy();
    expect(
      await env.VM_RUN_ARTIFACTS_BUCKET.get(terminal?.transcriptR2Key ?? ""),
    ).not.toBeNull();
  });

  it("bounds concurrent workshop transcript uploads", async () => {
    const fixture = await seedWorkshopRuntime({ generations: 1 });
    const artifacts = Array.from({ length: 6 }, (_, index) =>
      artifactDescriptor(
        "ssh_recording_segment",
        `session-${index + 1}.cast`,
        0,
        index + 1,
      ),
    );
    await beginUploadArtifacts(
      fixture.token1,
      "execution-1",
      "workshop-vm-1",
      artifacts,
    );
    for (const artifact of artifacts) {
      await agentRequest(
        fixture.token1,
        `/agent/runs/execution-1/vms/workshop-vm-1/artifacts/${artifact.ordinal}/multipart-begin`,
        "POST",
      );
    }

    const bucket = env.VM_RUN_ARTIFACTS_BUCKET;
    const originalPut = bucket.put.bind(bucket);
    let inFlightPuts = 0;
    let maxInFlightPuts = 0;
    const boundedBucket = new Proxy(bucket, {
      get(target, property) {
        if (property === "put") {
          return async (...args: Parameters<R2Bucket["put"]>) => {
            inFlightPuts += 1;
            maxInFlightPuts = Math.max(maxInFlightPuts, inFlightPuts);
            try {
              await Promise.resolve();
              return await originalPut(...args);
            } finally {
              inFlightPuts -= 1;
            }
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const boundedEnv = new Proxy(env, {
      get(target, property) {
        return property === "VM_RUN_ARTIFACTS_BUCKET"
          ? boundedBucket
          : Reflect.get(target, property);
      },
    }) as Cloudflare.Env;

    expect(
      (
        await agentRequest(
          fixture.token1,
          "/agent/runs/execution-1/vms/workshop-vm-1/timeline",
          "POST",
          {
            version: 1,
            sessions: artifacts.map((artifact, index) => ({
              index: index + 1,
              startTimestampMs: 1_000 + index * 100,
              durationMs: 100,
              castFilename: artifact.filename,
              transcript: `transcript ${index + 1}`,
            })),
          },
          boundedEnv,
        )
      ).status,
    ).toBe(200);
    expect(maxInFlightPuts).toBe(4);

    await expect(
      drizzle(env.DB)
        .select()
        .from(runtimeTerminalSessions)
        .where(eq(runtimeTerminalSessions.runtimeVmId, "runtime-vm-1")),
    ).resolves.toHaveLength(6);
  });

  it("rejects the wrong host and a superseded generation that is not archiving", async () => {
    const fixture = await seedWorkshopRuntime({ generations: 2 });
    const descriptor = artifactDescriptor("console_log", "stale.log");

    const wrongHost = await beginUpload(
      fixture.token2,
      "execution-1",
      "workshop-vm-1",
      descriptor,
    );
    expect(wrongHost.status).toBe(410);

    await drizzle(env.DB)
      .update(workshopWorkspaceGenerations)
      .set({ state: "ready" })
      .where(eq(workshopWorkspaceGenerations.id, "generation-1"));
    const staleGeneration = await beginUpload(
      fixture.token1,
      "execution-1",
      "workshop-vm-1",
      descriptor,
    );
    expect(staleGeneration.status).toBe(410);
    await expect(staleGeneration.json()).resolves.toMatchObject({
      code: "run_purged",
    });
  });

  it("keeps restored generations separate and exposes raw history only to its learner", async () => {
    const fixture = await seedWorkshopRuntime({ generations: 2 });
    const first = artifactDescriptor("console_log", "generation-1.log");
    const second = artifactDescriptor("console_log", "generation-2.log");

    await beginUpload(fixture.token1, "execution-1", "workshop-vm-1", first);
    await agentRequest(
      fixture.token1,
      "/agent/runs/execution-1/vms/workshop-vm-1/artifacts/1/multipart-begin",
      "POST",
    );
    await beginUpload(fixture.token2, "execution-2", "workshop-vm-2", second);
    await agentRequest(
      fixture.token2,
      "/agent/runs/execution-2/vms/workshop-vm-2/artifacts/1/multipart-begin",
      "POST",
    );

    const db = drizzle(env.DB);
    const artifacts = await db
      .select()
      .from(runtimeArtifacts)
      .orderBy(runtimeArtifacts.executionId);
    expect(artifacts.map((artifact) => artifact.executionId)).toEqual([
      "execution-1",
      "execution-2",
    ]);
    expect(new Set(artifacts.map((artifact) => artifact.r2Key)).size).toBe(2);

    const history = await listWorkshopArtifactsForOwner({
      sessionId: "workshop-session",
      userId: "learner",
    });
    expect(history.artifacts.map((artifact) => artifact.generation)).toEqual([
      1, 2,
    ]);
    expect(history.artifacts.map((artifact) => artifact.filename)).toEqual([
      "generation-1.log",
      "generation-2.log",
    ]);

    await expect(
      listWorkshopArtifactsForOwner({
        sessionId: "workshop-session",
        userId: "facilitator",
      }),
    ).rejects.toMatchObject({
      status: 403,
      code: "workshop_artifact_owner_required",
    } satisfies Partial<AppError>);
  });
});

async function seedScenarioRuntime(input?: { vms?: 1 | 2 }): Promise<string> {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.insert(user).values(userRow("scenario-owner"));
  await grantActiveBetaAccess("scenario-owner");
  await db.insert(agentHosts).values(hostRow("scenario-host", null));
  const scenarioVmDefinitions = [
    {
      id: "scenario-vm-id",
      ordinal: 0,
      scenarioVmId: "scenario-vm-spec",
      scenarioVmName: "vm",
      runtimeVmName: "scenario-vm",
      hostname: "vm",
      launchSummary: {
        scenarioVmName: "vm",
        hostname: "vm",
        probePhaseMap: {},
        probeDescriptors: [],
      },
    },
    ...(input?.vms === 2
      ? [
          {
            id: "scenario-vm-2-id",
            ordinal: 1,
            scenarioVmId: "scenario-vm-spec-2",
            scenarioVmName: "vm-2",
            runtimeVmName: "scenario-vm-2",
            hostname: "vm-2",
            launchSummary: {
              scenarioVmName: "vm-2",
              hostname: "vm-2",
              probePhaseMap: {},
              probeDescriptors: [],
            },
          },
        ]
      : []),
  ];
  const initial = buildInitialRunState({
    vms: scenarioVmDefinitions,
  });
  const archiving = recomputeRunState({
    ...initial,
    phase: "archiving",
    vms: initial.vms.map((vm) => ({ ...vm, phase: "archived" as const })),
  });
  const runInsert = db.insert(scenarioRuns).values({
    runId: "scenario-execution",
    runtimeExecutionId: null,
    userId: "scenario-owner",
    hostId: "scenario-host",
    scenarioId: "scenario",
    scenarioName: "scenario",
    title: "Scenario",
    tagline: "Archive regression",
    briefingMarkdown: "Briefing",
    objectivesJson: "[]",
    difficulty: "easy",
    estimatedMinutes: 10,
    tagsJson: [],
    hintsJson: [],
    solutionMarkdown: "Solution",
    vmCount: scenarioVmDefinitions.length,
    state: archiving.phase,
    stateRank: RUN_PHASE_ORDER[archiving.phase],
    activeKey: null,
    stateJson: JSON.stringify(archiving),
    createdAt: now,
    updatedAt: now,
  });
  await executeScenarioRunRuntimeProjection({
    d1: env.DB,
    runId: "scenario-execution",
    statements: [drizzleQueryToD1Statement(env.DB, runInsert)],
    mode: "create",
  });
  await db.insert(runtimeVms).values([
    runtimeVmRow(1, "scenario"),
    ...(input?.vms === 2
      ? [
          {
            ...runtimeVmRow(1, "scenario"),
            id: "scenario-runtime-vm-2",
            vmId: "scenario-vm-2-id",
            ordinal: 1,
            runtimeVmName: "scenario-vm-2",
          },
        ]
      : []),
  ]);
  return issueAgentToken("scenario-host");
}

async function seedWorkshopRuntime(input: {
  generations: 1 | 2;
}): Promise<{ token1: string; token2: string }> {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db
    .insert(user)
    .values([
      userRow("learner"),
      userRow("facilitator"),
      userRow("runner-owner"),
    ]);
  await db.insert(organization).values({
    id: "organization",
    name: "Organization",
    slug: "organization",
    createdAt: new Date(now),
  });
  await db
    .insert(member)
    .values([
      memberRow("learner", "member"),
      memberRow("facilitator", "member"),
      memberRow("runner-owner", "owner"),
    ]);
  await db
    .insert(agentHosts)
    .values([
      hostRow("host-1", "organization"),
      hostRow("host-2", "organization"),
    ]);
  await db.insert(workshopTemplates).values({
    id: "workshop-template",
    organizationId: "organization",
    slug: "archive-workshop",
    title: "Archive workshop",
    summary: "Archive workshop",
    currentRevisionId: null,
    createdBy: "facilitator",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workshopTemplateRevisions).values({
    id: "workshop-revision",
    templateId: "workshop-template",
    revision: 1,
    sourceRevision: "test",
    contentHash: "a".repeat(64),
    manifestJson: workshopManifest(),
    publishedBy: "facilitator",
    publishedAt: now,
  });
  await db.insert(workshopSessions).values({
    id: "workshop-session",
    organizationId: "organization",
    templateRevisionId: "workshop-revision",
    title: "Archive workshop",
    state: "live",
    version: 1,
    scheduledStartAt: now,
    lobbyOpensAt: now - 30 * 60_000,
    createdBy: "facilitator",
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workshopSessionMembers).values([
    {
      id: "roster-learner",
      sessionId: "workshop-session",
      userId: "learner",
      role: "participant",
      workspaceEnabled: true,
      checkedInAt: now,
      provisionState: "ready",
      assignedBy: "facilitator",
      createdAt: now,
      updatedAt: now,
    },
    {
      id: "roster-facilitator",
      sessionId: "workshop-session",
      userId: "facilitator",
      role: "facilitator",
      provisionState: "not_ready",
      assignedBy: "facilitator",
      createdAt: now,
      updatedAt: now,
    },
  ]);
  await db.insert(workshopWorkspaces).values({
    id: "workspace",
    sessionId: "workshop-session",
    userId: "learner",
    state: "ready",
    lastCheckpointId: "checkpoint-0",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workshopWorkspaceGenerations).values({
    id: "generation-1",
    workspaceId: "workspace",
    ordinal: 1,
    checkpointId: "checkpoint-0",
    hostId: "host-1",
    state: "ready",
    requestedAt: now,
    readyAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .update(workshopWorkspaces)
    .set({ currentGenerationId: "generation-1" })
    .where(eq(workshopWorkspaces.id, "workspace"));
  await db.insert(runtimeExecutions).values({
    id: "execution-1",
    userId: "learner",
    organizationId: "organization",
    hostId: "host-1",
    domainKind: "workshop",
    domainId: "workspace",
    generation: 1,
    checkpointId: "checkpoint-0",
    state: "ready",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(runtimeVms).values(runtimeVmRow(1, "workshop"));
  await db
    .update(workshopWorkspaceGenerations)
    .set({ runtimeExecutionId: "execution-1" })
    .where(eq(workshopWorkspaceGenerations.id, "generation-1"));
  if (input.generations === 2) {
    await db.insert(workshopWorkspaceGenerations).values({
      id: "generation-2",
      workspaceId: "workspace",
      ordinal: 2,
      checkpointId: "checkpoint-1",
      hostId: "host-2",
      state: "ready",
      requestedAt: now + 1,
      readyAt: now + 1,
      createdAt: now + 1,
      updatedAt: now + 1,
    });
    await db
      .update(workshopWorkspaces)
      .set({
        currentGenerationId: "generation-2",
        lastCheckpointId: "checkpoint-1",
      })
      .where(eq(workshopWorkspaces.id, "workspace"));
    await db.insert(runtimeExecutions).values({
      id: "execution-2",
      userId: "learner",
      organizationId: "organization",
      hostId: "host-2",
      domainKind: "workshop",
      domainId: "workspace",
      generation: 2,
      sourceExecutionId: "execution-1",
      checkpointId: "checkpoint-1",
      state: "ready",
      createdAt: now + 1,
      updatedAt: now + 1,
    });
    await db.insert(runtimeVms).values(runtimeVmRow(2, "workshop"));
    await db
      .update(workshopWorkspaceGenerations)
      .set({ runtimeExecutionId: "execution-2" })
      .where(eq(workshopWorkspaceGenerations.id, "generation-2"));
    await db
      .update(runtimeExecutions)
      .set({ state: "archived", endedAt: now + 1, updatedAt: now + 1 })
      .where(eq(runtimeExecutions.id, "execution-1"));
    await db
      .update(workshopWorkspaceGenerations)
      .set({ state: "archived", archivedAt: now + 1, updatedAt: now + 1 })
      .where(eq(workshopWorkspaceGenerations.id, "generation-1"));
  }
  return {
    token1: await issueAgentToken("host-1"),
    token2: await issueAgentToken("host-2"),
  };
}

async function beginUpload(
  token: string,
  runId: string,
  vmName: string,
  artifact: ReturnType<typeof artifactDescriptor>,
  options?: { archiveProgressVersion?: number | null },
): Promise<Response> {
  return beginUploadArtifacts(token, runId, vmName, [artifact], options);
}

async function beginUploadArtifacts(
  token: string,
  runId: string,
  vmName: string,
  artifacts: ReturnType<typeof artifactDescriptor>[],
  options?: { archiveProgressVersion?: number | null },
  requestEnv: Cloudflare.Env = env,
): Promise<Response> {
  const body: {
    runId: string;
    vmName: string;
    artifacts: ReturnType<typeof artifactDescriptor>[];
    archiveProgressVersion?: number;
  } = {
    runId,
    vmName,
    artifacts,
  };
  // The default models the new agent. Explicit null models an old payload
  // without the capability field; any other supplied value stays visible to
  // test the strict version gate.
  if (options?.archiveProgressVersion !== null) {
    body.archiveProgressVersion = options?.archiveProgressVersion ?? 1;
  }
  const response = await handleAgentRunArtifactRequest(
    new Request("http://localhost/agent/runs/begin", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    requestEnv,
  );
  if (!response) throw new Error("agent artifact route was not matched");
  return response;
}

async function agentRequest(
  token: string,
  path: string,
  method: string,
  body?: unknown,
  requestEnv: Cloudflare.Env = env,
): Promise<Response> {
  const response = await handleAgentRunArtifactRequest(
    new Request(`http://localhost${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    requestEnv,
  );
  if (!response) throw new Error("agent artifact route was not matched");
  return response;
}

async function agentRawRequest(
  token: string,
  path: string,
  method: string,
  body: BodyInit,
): Promise<Response> {
  const response = await handleAgentRunArtifactRequest(
    new Request(`http://localhost${path}`, {
      method,
      headers: { authorization: `Bearer ${token}` },
      body,
    }),
    env,
  );
  if (!response) throw new Error("agent artifact route was not matched");
  return response;
}

async function issueAgentToken(hostId: string): Promise<string> {
  const token = `bootstrap-${hostId}`;
  const db = drizzle(env.DB);
  await db.insert(agentBootstrapTokens).values({
    id: `bootstrap-row-${hostId}`,
    hostId,
    tokenHash: await sha256Hex(token),
    expiresAt: Date.now() + 60_000,
    createdAt: Date.now(),
  });
  const response = await handleAgentBootstrap(
    new Request("http://localhost/agent/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId, bootstrapToken: token }),
    }),
    env,
  );
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

function artifactDescriptor(
  kind: string,
  filename: string,
  sizeBytes = 0,
  ordinal = 1,
) {
  return {
    ordinal,
    kind,
    filename,
    contentType: "text/plain",
    sizeBytes,
    sha256:
      sizeBytes === 0
        ? "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        : "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
  };
}

function oversizedArtifactDescriptors(): Array<
  ReturnType<typeof artifactDescriptor>
> {
  return Array.from({ length: 1025 }, (_, index) =>
    artifactDescriptor(
      "console_log",
      `pre-limit-${index + 1}.log`,
      0,
      index + 1,
    ),
  );
}

async function seedScenarioArtifactManifest(
  artifacts: ReadonlyArray<ReturnType<typeof artifactDescriptor>>,
): Promise<void> {
  const db = drizzle(env.DB);
  const createdAt = Date.now();
  const statements = artifacts.flatMap((artifact) => {
    const r2Key = buildArtifactObjectKey({
      runId: "scenario-execution",
      vmId: "scenario-vm-id",
      ordinal: artifact.ordinal,
      kind: artifact.kind,
      filename: artifact.filename,
    });
    const values = {
      id: `scenario-vm-id:${artifact.ordinal}`,
      ordinal: artifact.ordinal,
      kind: artifact.kind,
      filename: artifact.filename,
      contentType: artifact.contentType,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      r2Key,
      uploadStatus: "pending" as const,
      createdAt,
      uploadedAt: null,
    };
    return [
      drizzleQueryToD1Statement(
        env.DB,
        db.insert(runtimeArtifacts).values({
          ...values,
          executionId: "scenario-execution",
          runtimeVmId: "scenario-runtime-vm",
        }),
      ),
      drizzleQueryToD1Statement(
        env.DB,
        db.insert(scenarioRunArtifacts).values({
          ...values,
          runId: "scenario-execution",
          vmId: "scenario-vm-id",
        }),
      ),
    ];
  });
  // Keep test setup below the D1 invocation statement budget as well.
  for (let start = 0; start < statements.length; start += 500) {
    await env.DB.batch(statements.slice(start, start + 500));
  }
}

async function scenarioArtifactLedgerSnapshot(db: ReturnType<typeof drizzle>) {
  const [runtime, legacy, runtimeExecution, runtimeVm, scenarioRun] =
    await Promise.all([
      db.select().from(runtimeArtifacts).orderBy(runtimeArtifacts.ordinal),
      db
        .select()
        .from(scenarioRunArtifacts)
        .orderBy(scenarioRunArtifacts.ordinal),
      db
        .select({
          state: runtimeExecutions.state,
          archiveRequestedAt: runtimeExecutions.archiveRequestedAt,
          updatedAt: runtimeExecutions.updatedAt,
        })
        .from(runtimeExecutions)
        .where(eq(runtimeExecutions.id, "scenario-execution"))
        .limit(1),
      db
        .select({
          archiveStageRank: runtimeVms.archiveStageRank,
          artifactWritesSealed: runtimeVms.artifactWritesSealed,
          updatedAt: runtimeVms.updatedAt,
        })
        .from(runtimeVms)
        .where(eq(runtimeVms.id, "scenario-runtime-vm"))
        .limit(1),
      db
        .select({
          state: scenarioRuns.state,
          stateJson: scenarioRuns.stateJson,
          updatedAt: scenarioRuns.updatedAt,
        })
        .from(scenarioRuns)
        .where(eq(scenarioRuns.runId, "scenario-execution"))
        .limit(1),
    ]);
  return {
    runtime,
    legacy,
    runtimeExecution: runtimeExecution[0] ?? null,
    runtimeVm: runtimeVm[0] ?? null,
    scenarioRun: scenarioRun[0] ?? null,
  };
}

function userRow(id: string): typeof user.$inferInsert {
  return {
    id,
    name: id,
    email: `${id}@example.test`,
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function memberRow(userId: string, role: string): typeof member.$inferInsert {
  return {
    id: `member-${userId}`,
    organizationId: "organization",
    userId,
    role,
    createdAt: new Date(),
  };
}

function hostRow(
  id: string,
  organizationId: string | null,
): typeof agentHosts.$inferInsert {
  return {
    id,
    userId: id === "scenario-host" ? "scenario-owner" : "runner-owner",
    organizationId,
    name: id,
    role: "agent",
    scenarioEnabled: true,
    disabled: false,
    connected: true,
    activeSessionId: `session-${id}`,
    lastHeartbeatAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function runtimeVmRow(
  generation: number,
  domain: "scenario" | "workshop",
): typeof runtimeVms.$inferInsert {
  const scenario = domain === "scenario";
  return {
    id: scenario ? "scenario-runtime-vm" : `runtime-vm-${generation}`,
    executionId: scenario ? "scenario-execution" : `execution-${generation}`,
    vmId: scenario ? "scenario-vm-id" : "workspace",
    ordinal: 0,
    runtimeVmName: scenario ? "scenario-vm" : `workshop-vm-${generation}`,
    imageKeyJson: { scenario: "workshop", vm: "workspace", arch: "x86_64" },
    imageSha256: "b".repeat(64),
    cpuMillis: 4_000,
    memoryMib: 16_384,
    diskMib: 102_400,
    artifactWritesSealed: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

async function expectArchiveStageRank(
  db: ReturnType<typeof drizzle>,
  runtimeVmId: string,
  expected: number | null,
): Promise<void> {
  const [vm] = await db
    .select({ archiveStageRank: runtimeVms.archiveStageRank })
    .from(runtimeVms)
    .where(eq(runtimeVms.id, runtimeVmId));
  expect(vm?.archiveStageRank).toBe(expected);
}

function workshopManifest(): WorkshopManifestV2 {
  return {
    schemaVersion: 2,
    workshop: {
      slug: "archive-workshop",
      title: "Archive workshop",
      summary: "Archive workshop",
      prerequisites: [],
      attribution: {
        title: "Test fixture",
        url: "https://example.test/workshop",
        license: "Apache-2.0",
      },
      defaultLobbyMinutes: 30,
    },
    workspace: {
      leaseGraceMinutes: 60,
      vms: [
        {
          id: "workspace",
          name: "Workspace",
          cpuMillis: 4_000,
          memoryMib: 16_384,
          diskMib: 102_400,
        },
      ],
      runtimeProfiles: [
        {
          id: "agent-x86",
          provider: "agent_kvm",
          vmId: "workspace",
          requestedSystemImage: "workshop",
          immutableSystemImage: "workshop",
          locations: [],
          hardware: {
            architecture: "x86_64",
            cpuMillis: 4_000,
            providerCpuCount: 4,
            memoryMib: 16_384,
            diskMib: 102_400,
          },
        },
      ],
      checkpoints: [
        {
          id: "checkpoint-0",
          label: "Checkpoint 0",
          vmImages: [
            {
              vmId: "workspace",
              imageKey: {
                scenario: "workshop",
                vm: "workspace",
                arch: "x86_64",
              },
              imageSha256: "b".repeat(64),
            },
          ],
        },
      ],
      initialCheckpointId: "checkpoint-0",
      applications: [],
    },
    modules: [],
    agenda: [],
    presentation: { slides: [] },
    durationMinutes: 60,
  };
}
