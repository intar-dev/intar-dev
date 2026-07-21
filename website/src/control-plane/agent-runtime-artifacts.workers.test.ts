/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { handleAgentRunArtifactRequest } from "@/control-plane/agent-run-artifacts";
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
  scenarioRuns,
  user,
  workshopSessionMembers,
  workshopSessions,
  workshopTemplateRevisions,
  workshopTemplates,
  workshopWorkspaceGenerations,
  workshopWorkspaces,
  type WorkshopManifestV1,
} from "@/db/schema";
import { AppError } from "@/lib/app-error";
import { listWorkshopArtifactsForOwner } from "@/lib/workshops/artifacts";
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

    expect(
      (await beginUpload(token, "scenario-execution", "scenario-vm", descriptor))
        .status,
    ).toBe(200);
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

  it("archives a workshop recording and terminal timeline on its exact generation", async () => {
    const fixture = await seedWorkshopRuntime({ generations: 1 });
    const descriptor = artifactDescriptor(
      "ssh_recording_segment",
      "session-1.cast",
      5,
    );

    expect(
      (await beginUpload(fixture.token1, "execution-1", "workshop-vm-1", descriptor))
        .status,
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

async function seedScenarioRuntime(): Promise<string> {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.insert(user).values(userRow("scenario-owner"));
  await db.insert(agentHosts).values(hostRow("scenario-host", null));
  const initial = buildInitialRunState({
    vms: [
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
    ],
  });
  const archiving = recomputeRunState({
    ...initial,
    phase: "archiving",
    vms: initial.vms.map((vm) => ({ ...vm, phase: "archived" as const })),
  });
  await db.insert(scenarioRuns).values({
    runId: "scenario-execution",
    runtimeExecutionId: "scenario-execution",
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
    vmCount: 1,
    state: archiving.phase,
    stateRank: RUN_PHASE_ORDER[archiving.phase],
    activeKey: null,
    stateJson: JSON.stringify(archiving),
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(runtimeVms).values(runtimeVmRow(1, "scenario"));
  return issueAgentToken("scenario-host");
}

async function seedWorkshopRuntime(input: {
  generations: 1 | 2;
}): Promise<{ token1: string; token2: string }> {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.insert(user).values([
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
  await db.insert(member).values([
    memberRow("learner", "member"),
    memberRow("facilitator", "member"),
    memberRow("runner-owner", "owner"),
  ]);
  await db.insert(agentHosts).values([
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
): Promise<Response> {
  const response = await handleAgentRunArtifactRequest(
    new Request("http://localhost/agent/runs/begin", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ runId, vmName, artifacts: [artifact] }),
    }),
    env,
  );
  if (!response) throw new Error("agent artifact route was not matched");
  return response;
}

async function agentRequest(
  token: string,
  path: string,
  method: string,
  body?: unknown,
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
    env,
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

function artifactDescriptor(kind: string, filename: string, sizeBytes = 0) {
  return {
    ordinal: 1,
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

function workshopManifest(): WorkshopManifestV1 {
  return {
    schemaVersion: 1,
    workshop: {
      slug: "archive-workshop",
      title: "Archive workshop",
      summary: "Archive workshop",
      prerequisites: [],
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
