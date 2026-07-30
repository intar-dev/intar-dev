/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { handleWorkspaceAgentControlPlaneRequest } from "./workspace-agent";
import {
  hetznerAllocations,
  member,
  organization,
  organizationProviderConnections,
  runtimeExecutions,
  runtimeProviderActualState,
  runtimeProviderCheckpointArtifacts,
  runtimeProviderGuestCredentials,
  runtimeVms,
  user,
  workshopSessionMembers,
  workshopSessions,
  workshopModuleProgress,
  workshopTemplateRevisions,
  workshopTemplates,
  workshopWorkspaceGenerations,
  workshopWorkspaces,
  type WorkshopManifestV1,
} from "@/db/schema";
import { loadCurrentRuntimeVmTerminalTarget } from "@/lib/runtime-executions";
import { ensureRuntimeVmAccessKeys } from "@/lib/runtime-vm-state";
import {
  buildWorkspaceAgentCloudInit,
  issueWorkspaceAgentBootstrap,
  revokeWorkspaceAgentGeneration,
} from "@/lib/workshops/workspace-agent-control-plane";
import { resetD1Database } from "@/test/d1-migrations";

const NOW = 1_800_000_000_000;
const CHECKPOINT = new TextEncoder().encode("signed checkpoint fixture");
const CHECKPOINT_SHA256 =
  "707339b1a702f2d14b682f7a13048085750e8542a5539de9da29d1e988c80f62";

describe("workspace agent guest control plane", () => {
  beforeEach(async () => {
    await resetD1Database();
    await seedGeneration();
  });

  it("stores only a bootstrap digest and rejects replay", async () => {
    const issued = await issueWorkspaceAgentBootstrap({
      executionId: "execution-1",
      generation: 1,
      checkpointArtifactId: "checkpoint-artifact-1",
      baseUrl: "https://intar.test",
      now: NOW,
    });
    expect(issued).toMatchObject({
      expiresAt: NOW + 30 * 60_000,
      identity: {
        executionId: "execution-1",
        workspaceId: "workspace-1",
        generation: 1,
      },
      endpoint: "https://intar.test/api/runtime/workspace-agent/",
    });
    const storedBefore = await drizzle(env.DB)
      .select()
      .from(runtimeProviderGuestCredentials);
    expect(JSON.stringify(storedBefore)).not.toContain(issued.capability);
    expect(storedBefore[0]?.bootstrapTokenHash).toMatch(/^[a-f0-9]{64}$/);

    const first = await bootstrapRequest(issued.capability);
    expect(first.status).toBe(200);
    const response = await first.json<{
      report_credential: string;
      checkpoint: {
        signed_url: string;
        sha256: string;
        signature_b64: string;
        signing_key_id: string;
      };
    }>();
    expect(response.checkpoint).toMatchObject({
      sha256: CHECKPOINT_SHA256,
      signature_b64: btoa(String.fromCharCode(...new Uint8Array(64))),
      signing_key_id: "test-key",
    });
    expect(response.checkpoint.signed_url).toMatch(
      /^https:\/\/intar\.test\/api\/runtime\/workspace-agent\/checkpoints\//,
    );
    const storedAfter = await drizzle(env.DB)
      .select()
      .from(runtimeProviderGuestCredentials);
    expect(JSON.stringify(storedAfter)).not.toContain(issued.capability);
    expect(JSON.stringify(storedAfter)).not.toContain(
      response.report_credential,
    );

    const replay = await bootstrapRequest(issued.capability);
    expect(replay.status).toBe(401);
    expect(await replay.text()).not.toContain(issued.capability);

    const checkpoint = await handle(
      new Request(response.checkpoint.signed_url),
    );
    expect(checkpoint.status).toBe(200);
    expect(await checkpoint.arrayBuffer()).toEqual(CHECKPOINT.buffer);
    expect(checkpoint.headers.get("cache-control")).toBe("private, no-store");
  });

  it("accepts strictly monotonic reports and redacts credentials", async () => {
    const reportCredential = await bootstrap();
    const report = reportBody(1, reportCredential);
    const accepted = await reportRequest(reportCredential, report);
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({
      accepted_sequence: 1,
      drain_recordings: false,
    });

    const db = drizzle(env.DB);
    const [actual] = await db.select().from(runtimeProviderActualState);
    expect(actual).toMatchObject({
      executionId: "execution-1",
      generation: 1,
      sequence: 1,
      phase: "ready",
      health: "healthy",
      terminalReady: true,
      sshHostKeysJson: ["ssh-ed25519 AAAATEST learner"],
    });
    expect(JSON.stringify(actual)).not.toContain(reportCredential);
    expect(JSON.stringify(actual)).not.toContain("X-Amz-Signature");
    expect(JSON.stringify(actual)).toContain("[REDACTED]");
    const [vm] = await db
      .select()
      .from(runtimeVms)
      .where(eq(runtimeVms.executionId, "execution-1"));
    expect(vm).toMatchObject({
      terminalHost: "192.0.2.20",
      terminalPort: 22,
      terminalUsername: "intar",
      terminalHostKeyOpenssh: "ssh-ed25519 AAAATEST learner",
    });
    expect(vm?.terminalPrivateKeyCiphertextB64).toMatch(/\S+/);
    expect(vm?.terminalPrivateKeyIvB64).toMatch(/\S+/);
    const terminal = await loadCurrentRuntimeVmTerminalTarget({
      executionId: "execution-1",
      expectedGeneration: 1,
      vmId: "learner",
    });
    expect(terminal).toMatchObject({
      hostId: "provider:connection-1",
      target: {
        host: "192.0.2.20",
        port: 22,
        username: "intar",
        hostKeyOpenssh: "ssh-ed25519 AAAATEST learner",
      },
    });
    expect(terminal.target.privateKeyOpenssh).toContain("PRIVATE KEY");
    const [execution, generation] = await Promise.all([
      db
        .select({ state: runtimeExecutions.state })
        .from(runtimeExecutions)
        .where(eq(runtimeExecutions.id, "execution-1")),
      db
        .select({ state: workshopWorkspaceGenerations.state })
        .from(workshopWorkspaceGenerations)
        .where(eq(workshopWorkspaceGenerations.id, "workspace-generation-1")),
    ]);
    expect(execution).toEqual([{ state: "ready" }]);
    expect(generation).toEqual([{ state: "ready" }]);

    expect((await reportRequest(reportCredential, report)).status).toBe(409);
    expect(
      (
        await reportRequest(reportCredential, {
          ...reportBody(2, reportCredential),
          identity: {
            execution_id: "execution-1",
            workspace_id: "workspace-1",
            generation: 2,
          },
        })
      ).status,
    ).toBe(409);

    await revokeWorkspaceAgentGeneration({
      executionId: "execution-1",
      generation: 1,
      now: NOW + 1_000,
    });
    expect(
      (await reportRequest(reportCredential, reportBody(2, reportCredential)))
        .status,
    ).toBe(401);
  });

  it("keeps only drain reporting and recording uploads alive after session end", async () => {
    const reportCredential = await bootstrap();
    expect(
      (await reportRequest(reportCredential, reportBody(1, reportCredential)))
        .status,
    ).toBe(200);

    const db = drizzle(env.DB);
    await db
      .update(hetznerAllocations)
      .set({
        state: "draining",
        recordingDrainRequestedAt: Date.now() - 1_000,
        updatedAt: NOW + 1_000,
      })
      .where(eq(hetznerAllocations.id, "allocation-1"));
    await db
      .update(workshopSessions)
      .set({ state: "ended", endedAt: NOW + 1_000, updatedAt: NOW + 1_000 })
      .where(eq(workshopSessions.id, "session-1"));

    const drainRequested = await reportRequest(
      reportCredential,
      reportBody(2, reportCredential),
    );
    expect(drainRequested.status).toBe(200);
    await expect(drainRequested.json()).resolves.toEqual({
      accepted_sequence: 2,
      drain_recordings: true,
    });

    const recording = new TextEncoder().encode("completed recording");
    const recordingSha256 = await digestHex(recording);
    expect(
      (
        await artifactGrantRequest(
          reportCredential,
          {
            execution_id: "execution-1",
            workspace_id: "workspace-1",
            generation: 1,
          },
          recordingSha256,
          recording.byteLength,
        )
      ).status,
    ).toBe(200);

    const completed = await reportRequest(reportCredential, {
      ...reportBody(3, reportCredential),
      recording_drain_completed: true,
      terminal_ready: false,
    });
    expect(completed.status).toBe(200);
    await expect(completed.json()).resolves.toEqual({
      accepted_sequence: 3,
      drain_recordings: false,
    });
    const [allocation] = await db
      .select()
      .from(hetznerAllocations)
      .where(eq(hetznerAllocations.id, "allocation-1"));
    expect(allocation?.state).toBe("draining");
    expect(allocation?.recordingDrainCompletedAt).not.toBeNull();

    const later = await reportRequest(
      reportCredential,
      reportBody(4, reportCredential),
    );
    expect(later.status).toBe(200);
    await expect(later.json()).resolves.toMatchObject({
      drain_recordings: false,
    });

    await db
      .update(hetznerAllocations)
      .set({ state: "deleting", updatedAt: NOW + 2_000 })
      .where(eq(hetznerAllocations.id, "allocation-1"));
    expect(
      (await reportRequest(reportCredential, reportBody(5, reportCredential)))
        .status,
    ).toBe(401);
  });

  it("projects named probes into latched workshop progress only for the current authenticated generation", async () => {
    const reportCredential = await bootstrap();
    const db = drizzle(env.DB);

    const verified = await reportRequest(
      reportCredential,
      reportBody(1, reportCredential, [
        namedProbe("workspace-ready", "pass"),
        namedProbe("service-ready", "pass"),
      ]),
    );
    expect(verified.status).toBe(200);
    const verifiedProgress = await db
      .select()
      .from(workshopModuleProgress)
      .orderBy(workshopModuleProgress.moduleId);
    expect(verifiedProgress).toHaveLength(2);
    expect(verifiedProgress.map(progressSnapshot)).toEqual([
      {
        moduleId: "00-setup",
        technicalStatus: "verified",
        currentHealth: "passing",
      },
      {
        moduleId: "01-service",
        technicalStatus: "verified",
        currentHealth: "passing",
      },
    ]);
    expect(verifiedProgress.every((row) => row.firstVerifiedAt !== null)).toBe(
      true,
    );

    const regressed = await reportRequest(
      reportCredential,
      reportBody(2, reportCredential, [
        namedProbe("workspace-ready", "pass"),
        namedProbe("service-ready", "fail"),
      ]),
    );
    expect(regressed.status).toBe(200);
    const regressedProgress = await db
      .select()
      .from(workshopModuleProgress)
      .orderBy(workshopModuleProgress.moduleId);
    expect(regressedProgress.map(progressSnapshot)).toEqual([
      {
        moduleId: "00-setup",
        technicalStatus: "verified",
        currentHealth: "passing",
      },
      {
        moduleId: "01-service",
        technicalStatus: "verified",
        currentHealth: "failing",
      },
    ]);

    const stale = await reportRequest(
      reportCredential,
      reportBody(2, reportCredential, [
        namedProbe("workspace-ready", "fail"),
        namedProbe("service-ready", "pass"),
      ]),
    );
    expect(stale.status).toBe(409);
    expect(
      (
        await db
          .select()
          .from(workshopModuleProgress)
          .orderBy(workshopModuleProgress.moduleId)
      ).map(progressSnapshot),
    ).toEqual(regressedProgress.map(progressSnapshot));

    await revokeWorkspaceAgentGeneration({
      executionId: "execution-1",
      generation: 1,
      now: NOW + 1_000,
    });
    const revoked = await reportRequest(
      reportCredential,
      reportBody(3, reportCredential, [
        namedProbe("workspace-ready", "fail"),
        namedProbe("service-ready", "pass"),
      ]),
    );
    expect(revoked.status).toBe(401);
    expect(
      (
        await db
          .select()
          .from(workshopModuleProgress)
          .orderBy(workshopModuleProgress.moduleId)
      ).map(progressSnapshot),
    ).toEqual(regressedProgress.map(progressSnapshot));
  });

  it("binds artifact grants to one generation and consumes uploads once", async () => {
    const reportCredential = await bootstrap();
    const payload = new TextEncoder().encode("runtime artifact");
    const sha256 = await digestHex(payload);

    const stale = await artifactGrantRequest(
      reportCredential,
      {
        execution_id: "execution-1",
        workspace_id: "workspace-1",
        generation: 2,
      },
      sha256,
      payload.byteLength,
    );
    expect(stale.status).toBe(409);

    const grantResponse = await artifactGrantRequest(
      reportCredential,
      {
        execution_id: "execution-1",
        workspace_id: "workspace-1",
        generation: 1,
      },
      sha256,
      payload.byteLength,
    );
    expect(grantResponse.status).toBe(200);
    const grant = await grantResponse.json<{
      artifact_id: string;
      signed_upload_url: string;
    }>();
    expect(grant.signed_upload_url).toMatch(
      /^https:\/\/intar\.test\/api\/runtime\/workspace-agent\/artifacts\/uploads\//,
    );
    const uploaded = await handle(
      new Request(grant.signed_upload_url, {
        method: "PUT",
        headers: {
          "content-length": String(payload.byteLength),
          "x-intar-artifact-sha256": sha256,
        },
        body: payload,
      }),
    );
    expect(uploaded.status).toBe(200);
    const object = await env.VM_RUN_ARTIFACTS_BUCKET.get(
      `runtime/workshops/workspace-1/generations/1/artifacts/${grant.artifact_id}`,
    );
    expect(await object?.arrayBuffer()).toEqual(payload.buffer);

    const duplicate = await artifactGrantRequest(
      reportCredential,
      {
        execution_id: "execution-1",
        workspace_id: "workspace-1",
        generation: 1,
      },
      sha256,
      payload.byteLength,
    );
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({
      identity: {
        execution_id: "execution-1",
        workspace_id: "workspace-1",
        generation: 1,
      },
      artifact_id: grant.artifact_id,
      already_uploaded: true,
    });

    const replay = await handle(
      new Request(grant.signed_upload_url, {
        method: "PUT",
        headers: {
          "content-length": String(payload.byteLength),
          "x-intar-artifact-sha256": sha256,
        },
        body: payload,
      }),
    );
    expect(replay.status).toBe(401);
  });

  it("rejects an old credential as soon as a newer workspace generation is current", async () => {
    const reportCredential = await bootstrap();
    const db = drizzle(env.DB);
    await db.insert(workshopWorkspaceGenerations).values({
      id: "workspace-generation-2",
      workspaceId: "workspace-1",
      ordinal: 2,
      checkpointId: "checkpoint-00",
      state: "queued",
      requestedAt: NOW + 1_000,
      createdAt: NOW + 1_000,
      updatedAt: NOW + 1_000,
    });
    await db
      .update(workshopWorkspaces)
      .set({ currentGenerationId: "workspace-generation-2" })
      .where(eq(workshopWorkspaces.id, "workspace-1"));

    const response = await reportRequest(
      reportCredential,
      reportBody(1, reportCredential),
    );
    expect(response.status).toBe(401);
    expect(await db.select().from(runtimeProviderActualState)).toEqual([]);
  });

  it("renders minimal cloud-init without introducing provider credentials", async () => {
    const issued = await issueWorkspaceAgentBootstrap({
      executionId: "execution-1",
      generation: 1,
      baseUrl: "https://intar.test",
      now: NOW,
    });
    const cloudInit = buildWorkspaceAgentCloudInit({
      identity: issued.identity,
      endpoint: issued.endpoint,
      bootstrapCapability: issued.capability,
      sshPublicKey: "ssh-ed25519 AAAATEST intar",
      agentBinaryUrl: "https://releases.intar.dev/workspace-agent",
      agentBinarySha256: "b".repeat(64),
      kinoBinaryUrl: "https://releases.intar.dev/kino",
      kinoBinarySha256: "c".repeat(64),
      kinoProbes: [{ moduleId: "00", probeId: "module-00-workspace-ready" }],
      checkpointSigningKeysJson: JSON.stringify({
        "test-key": btoa(String.fromCharCode(...new Uint8Array(32))),
      }),
    });
    expect(cloudInit).toContain("#cloud-config");
    expect(cloudInit).toContain(
      "https://intar.test/api/runtime/workspace-agent/",
    );
    expect(cloudInit).toContain("require_checkpoint_tmpfs = true");
    expect(cloudInit).toContain('reconstruction_user = "intar"');
    expect(cloudInit).toContain('reconstruction_home = "/home/intar"');
    expect(cloudInit).toContain('probe "module-00-workspace-ready"');
    expect(cloudInit).toContain("intar-kino-shell");
    const probeRunner = cloudInitWriteFile(
      cloudInit,
      "/usr/libexec/intar-workshop-run-probe",
    );
    expect(probeRunner).toContain(
      `/usr/bin/env -i \\
        HOME=/home/intar \\
        USER=intar \\
        LOGNAME=intar \\
        SHELL=/bin/bash \\
        PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \\
        LANG=C.UTF-8 \\
        LC_ALL=C.UTF-8 \\
        /bin/bash --noprofile --norc -c \\
          'umask 0022; exec /bin/bash -- "$1"' \\
          intar-probe \\
          "\${verifier}" </dev/null >/dev/null 2>&1`,
    );
    expect(probeRunner).toContain("HOME=/home/intar");
    expect(probeRunner).toContain("USER=intar");
    expect(probeRunner).toContain("LOGNAME=intar");
    expect(probeRunner).not.toContain("setpriv");
    expect(probeRunner).not.toContain("runuser");
    expect(probeRunner).toMatch(
      /status="\$\?"[\s\S]*printf '\{"passed":false\}\\n'[\s\S]*exit "\$\{status\}"/,
    );
    const checkpointWaiter = cloudInitWriteFile(
      cloudInit,
      "/usr/libexec/intar-workspace-wait-checkpoint",
    );
    expect(checkpointWaiter).toContain(
      `until /usr/bin/grep -Fq '"checkpoint_applied":true' "\${state}" 2>/dev/null; do`,
    );
    expect(checkpointWaiter).toContain("/usr/bin/sleep 1");
    expect(checkpointWaiter).toContain(
      `state=/var/lib/intar-workspace-agent/state.json`,
    );
    const kinoService = cloudInitWriteFile(
      cloudInit,
      "/etc/systemd/system/kino.service",
    );
    expect(kinoService).toContain("User=intar");
    expect(kinoService).toContain("Group=intar");
    expect(kinoService).toContain(
      "ExecStartPre=+/usr/libexec/intar-workspace-wait-checkpoint",
    );
    expect(kinoService).toContain("TimeoutStartSec=100min");
    expect(kinoService).toContain("TimeoutStopSec=5s");
    expect(kinoService).toContain("KillMode=control-group");
    expect(kinoService).toContain("NoNewPrivileges=true");
    expect(kinoService).toContain("Restart=on-failure");
    expect(kinoService).not.toContain("User=root");
    const recordingDrain = cloudInitWriteFile(
      cloudInit,
      "/usr/libexec/intar-workspace-recording-drain",
    );
    expect(recordingDrain).toContain(
      `systemctl stop ssh.service
      systemctl stop kino.service
      pkill -HUP -u intar -x kino 2>/dev/null || true`,
    );
    const agentService = cloudInitWriteFile(
      cloudInit,
      "/etc/systemd/system/intar-workspace-agent.service",
    );
    expect(agentService).toContain(
      "Wants=network-online.target ssh.service",
    );
    expect(agentService).toContain(
      "After=network-online.target ssh.service",
    );
    expect(agentService).not.toContain("kino.service");
    expect(cloudInit).toContain("/var/lib/intar-workshop-probes/00.sh");
    expect(cloudInit).toContain("HOME=/home/intar");
    expect(cloudInit).toContain("ProtectHome=read-only");
    expect(cloudInit).toContain("ReadWritePaths=/home/intar");
    expect(cloudInit).toContain("/var/lib/kino-recordings");
    expect(cloudInit).toContain("PermitRootLogin no");
    expect(cloudInit).toContain("PasswordAuthentication no");
    expect(cloudInit).toContain("KbdInteractiveAuthentication no");
    expect(cloudInit).toContain("AllowUsers intar");
    expect(cloudInit).toContain("AllowTcpForwarding yes");
    expect(cloudInit).toContain("[systemctl, restart, ssh.service]");
    expect(cloudInit).toContain(
      "[systemctl, enable, kino.service, intar-workspace-agent.service]",
    );
    expect(cloudInit).toContain(
      "[systemctl, start, --no-block, kino.service, intar-workspace-agent.service]",
    );
    expect(cloudInit).not.toContain(
      "[systemctl, enable, --now, kino.service, intar-workspace-agent.service]",
    );
    expect(cloudInit).not.toContain("PermitRootLogin yes");
    expect(cloudInit).not.toContain("Hetzner-Token");
    expect(cloudInit).not.toContain("hcloud_token");
  });
});

function cloudInitWriteFile(cloudInit: string, path: string): string {
  const start = cloudInit.indexOf(`  - path: ${path}\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  const nextFile = cloudInit.indexOf("\n  - path: ", start + 1);
  const writeFilesEnd = cloudInit.indexOf("\nbootcmd:", start + 1);
  const end = [nextFile, writeFilesEnd]
    .filter((candidate) => candidate >= 0)
    .reduce((nearest, candidate) => Math.min(nearest, candidate), cloudInit.length);
  return cloudInit.slice(start, end);
}

async function seedGeneration() {
  const db = drizzle(env.DB);
  const createdAt = new Date(NOW - 60_000);
  await db.insert(user).values({
    id: "learner-1",
    name: "Learner",
    email: "learner@example.test",
    emailVerified: true,
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(organization).values({
    id: "org-1",
    name: "Organization",
    slug: "org-1",
    createdAt,
  });
  await db.insert(member).values({
    id: "membership-1",
    organizationId: "org-1",
    userId: "learner-1",
    role: "owner",
    createdAt,
  });
  await db.insert(workshopTemplates).values({
    id: "template-1",
    organizationId: "org-1",
    slug: "platform",
    title: "Platform",
    summary: "fixture",
    createdBy: "learner-1",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(workshopTemplateRevisions).values({
    id: "revision-1",
    templateId: "template-1",
    revision: 1,
    sourceRevision: "fixture",
    contentHash: "a".repeat(64),
    manifestJson: manifest(),
    publishedBy: "learner-1",
    publishedAt: NOW,
  });
  await db.insert(workshopSessions).values({
    id: "session-1",
    organizationId: "org-1",
    templateRevisionId: "revision-1",
    title: "Pilot",
    state: "live",
    version: 1,
    scheduledStartAt: NOW,
    lobbyOpensAt: NOW - 30 * 60_000,
    createdBy: "learner-1",
    startedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(workshopSessionMembers).values({
    id: "roster-1",
    sessionId: "session-1",
    userId: "learner-1",
    role: "participant",
    provisionState: "provisioning",
    assignedBy: "learner-1",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(workshopWorkspaces).values({
    id: "workspace-1",
    sessionId: "session-1",
    userId: "learner-1",
    state: "provisioning",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(workshopWorkspaceGenerations).values({
    id: "workspace-generation-1",
    workspaceId: "workspace-1",
    ordinal: 1,
    checkpointId: "checkpoint-00",
    state: "provisioning",
    requestedAt: NOW,
    provisioningStartedAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db
    .update(workshopWorkspaces)
    .set({ currentGenerationId: "workspace-generation-1" })
    .where(eq(workshopWorkspaces.id, "workspace-1"));
  await db.insert(organizationProviderConnections).values({
    id: "connection-1",
    organizationId: "org-1",
    providerKind: "hetzner_cloud",
    displayName: "Pilot project",
    state: "active",
    projectFingerprint: "project-fingerprint",
    sentinelFirewallId: "firewall-1",
    currency: "EUR",
    lastValidatedAt: NOW,
    createdBy: "learner-1",
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db.insert(runtimeExecutions).values({
    id: "execution-1",
    userId: "learner-1",
    organizationId: "org-1",
    hostId: null,
    providerKind: "hetzner_cloud",
    providerConnectionId: "connection-1",
    domainKind: "workshop",
    domainId: "workspace-1",
    generation: 1,
    checkpointId: "checkpoint-00",
    state: "provisioning",
    leaseExpiresAt: NOW + 5 * 60 * 60_000,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await db
    .update(workshopWorkspaceGenerations)
    .set({ runtimeExecutionId: "execution-1" })
    .where(eq(workshopWorkspaceGenerations.id, "workspace-generation-1"));
  await db.insert(runtimeVms).values({
    id: "runtime-vm-1",
    executionId: "execution-1",
    vmId: "learner",
    ordinal: 0,
    runtimeVmName: "learner",
    imageKeyJson: { checkpoint: "checkpoint-00" },
    imageSha256: "c".repeat(64),
    cpuMillis: 4_000,
    memoryMib: 16_384,
    diskMib: 65_536,
    createdAt: NOW,
    updatedAt: NOW,
  });
  await ensureRuntimeVmAccessKeys({
    executionId: "execution-1",
    expectedGeneration: 1,
    now: NOW,
  });
  await db.insert(runtimeProviderCheckpointArtifacts).values({
    id: "checkpoint-artifact-1",
    templateRevisionId: "revision-1",
    checkpointId: "checkpoint-00",
    providerKind: "hetzner_cloud",
    r2Key: "provider-checkpoints/revision-1/checkpoint-00.tar.zst",
    sha256: CHECKPOINT_SHA256,
    sizeBytes: CHECKPOINT.byteLength,
    compression: "zstd",
    signatureB64: btoa(String.fromCharCode(...new Uint8Array(64))),
    signingKeyId: "test-key",
    workspaceAgentSha256: "d".repeat(64),
    kinoSha256: "e".repeat(64),
    status: "verified",
    coldBootVerifiedAt: NOW,
    createdAt: NOW,
  });
  await env.VM_IMAGE_REGISTRY_BUCKET.put(
    "provider-checkpoints/revision-1/checkpoint-00.tar.zst",
    CHECKPOINT,
  );
  await db.insert(hetznerAllocations).values({
    id: "allocation-1",
    executionId: "execution-1",
    connectionId: "connection-1",
    deterministicName: "intar-workspace-1-generation-1",
    serverId: "1001",
    primaryIpId: "2001",
    primaryIpv4: "192.0.2.20",
    sshKeyId: "3001",
    serverType: "cx43",
    systemImage: "debian-13",
    location: "nbg1",
    state: "bootstrapping",
    createdAt: NOW,
    updatedAt: NOW,
  });
}

async function bootstrap(): Promise<string> {
  const issued = await issueWorkspaceAgentBootstrap({
    executionId: "execution-1",
    generation: 1,
    baseUrl: "https://intar.test",
    now: NOW,
  });
  const response = await bootstrapRequest(issued.capability);
  expect(response.status).toBe(200);
  return (await response.json<{ report_credential: string }>())
    .report_credential;
}

function bootstrapRequest(capability: string): Promise<Response> {
  return handle(
    new Request("https://intar.test/api/runtime/workspace-agent/bootstrap", {
      method: "POST",
      headers: {
        authorization: `Intar-Bootstrap ${capability}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        contract_version: 1,
        identity: {
          execution_id: "execution-1",
          workspace_id: "workspace-1",
          generation: 1,
        },
        agent_version: "0.1.0",
      }),
    }),
  );
}

function reportRequest(
  credential: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return handle(
    new Request("https://intar.test/api/runtime/workspace-agent/reports", {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
  );
}

function reportBody(
  sequence: number,
  credential: string,
  probes: Array<Record<string, unknown>> = [
    {
      ...namedProbe("workspace-ready", "pass"),
      error: `credential=${credential} https://store.test/path?X-Amz-Signature=secret`,
    },
    namedProbe("service-ready", "pass"),
  ],
) {
  return {
    contract_version: 1,
    identity: {
      execution_id: "execution-1",
      workspace_id: "workspace-1",
      generation: 1,
    },
    sequence,
    phase: "ready",
    health: "healthy",
    terminal_ready: true,
    ssh_host_keys_openssh: ["ssh-ed25519 AAAATEST learner"],
    probes,
    error: `Authorization=${credential}`,
    reported_at_unix_ms: NOW,
  };
}

function namedProbe(id: string, status: "unknown" | "pass" | "fail") {
  return { id, status, observed_at_unix_ms: NOW };
}

function progressSnapshot(row: typeof workshopModuleProgress.$inferSelect) {
  return {
    moduleId: row.moduleId,
    technicalStatus: row.technicalStatus,
    currentHealth: row.currentHealth,
  };
}

function artifactGrantRequest(
  credential: string,
  identity: Record<string, unknown>,
  sha256: string,
  sizeBytes: number,
): Promise<Response> {
  return handle(
    new Request(
      "https://intar.test/api/runtime/workspace-agent/artifacts/grants",
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${credential}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          contract_version: 1,
          identity,
          kind: "terminal_recording",
          sha256,
          size_bytes: sizeBytes,
        }),
      },
    ),
  );
}

async function handle(request: Request): Promise<Response> {
  const response = await handleWorkspaceAgentControlPlaneRequest(request, env);
  if (!response) throw new Error("workspace agent route was not handled");
  return response;
}

async function digestHex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new Uint8Array(bytes).buffer as ArrayBuffer,
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function manifest(): WorkshopManifestV1 {
  return {
    schemaVersion: 1,
    workshop: {
      slug: "platform",
      title: "Platform",
      summary: "fixture",
      prerequisites: [],
      defaultLobbyMinutes: 30,
    },
    workspace: {
      leaseGraceMinutes: 60,
      vms: [],
      checkpoints: [],
      initialCheckpointId: "checkpoint-00",
      applications: [],
    },
    modules: [
      {
        id: "00-setup",
        title: "Setup",
        tier: "gate",
        outcome: "The learner workspace is ready.",
        dependsOn: [],
        participantMarkdown: "Run the setup verifier.",
        facilitatorNotesMarkdown: "Help learners reach a working baseline.",
        hints: [],
        solutionMarkdown: "Apply the canonical setup.",
        probeIds: ["workspace-ready"],
        catchUpCheckpointId: "checkpoint-00",
      },
      {
        id: "01-service",
        title: "Service",
        tier: "core",
        outcome: "The learner service is ready.",
        dependsOn: ["00-setup"],
        participantMarkdown: "Deploy the service.",
        facilitatorNotesMarkdown: "Inspect the service probe.",
        hints: [],
        solutionMarkdown: "Apply the canonical service configuration.",
        probeIds: ["service-ready"],
        catchUpCheckpointId: "checkpoint-00",
      },
    ],
    agenda: [],
    presentation: { slides: [] },
    durationMinutes: 240,
  };
}
