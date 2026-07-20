import { and, asc, eq } from "drizzle-orm";
import {
  runtimeArtifacts,
  runtimeExecutions,
  runtimeTerminalSessions,
  runtimeVms,
  workshopSessions,
  workshopWorkspaceGenerations,
  workshopWorkspaces,
} from "@/db/schema";
import { appError } from "@/lib/app-error";
import { requireWorkshopSessionMember, workshopDb } from "./shared";

export interface WorkshopArtifactRecord {
  id: string;
  executionId: string;
  generationId: string;
  generation: number;
  checkpointId: string | null;
  vmId: string;
  vmName: string;
  ordinal: number;
  kind: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  uploadedAt: number;
  contentUrl: string;
}

export interface WorkshopTerminalSessionRecord {
  id: string;
  executionId: string;
  generationId: string;
  generation: number;
  vmId: string;
  vmName: string;
  ordinal: number;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  recordingArtifactId: string | null;
  transcriptUrl: string | null;
}

export async function listWorkshopArtifactsForOwner(input: {
  sessionId: string;
  userId: string;
}): Promise<{
  artifacts: WorkshopArtifactRecord[];
  terminalSessions: WorkshopTerminalSessionRecord[];
}> {
  await requireWorkshopArtifactOwner(input);
  const db = workshopDb();
  const ownership = workshopArtifactOwnershipPredicate(input);
  const [artifactRows, sessionRows] = await Promise.all([
    db
      .select({
        id: runtimeArtifacts.id,
        executionId: runtimeArtifacts.executionId,
        generationId: workshopWorkspaceGenerations.id,
        generation: workshopWorkspaceGenerations.ordinal,
        checkpointId: workshopWorkspaceGenerations.checkpointId,
        vmId: runtimeVms.vmId,
        vmName: runtimeVms.runtimeVmName,
        ordinal: runtimeArtifacts.ordinal,
        kind: runtimeArtifacts.kind,
        filename: runtimeArtifacts.filename,
        contentType: runtimeArtifacts.contentType,
        sizeBytes: runtimeArtifacts.sizeBytes,
        sha256: runtimeArtifacts.sha256,
        uploadedAt: runtimeArtifacts.uploadedAt,
      })
      .from(runtimeArtifacts)
      .innerJoin(runtimeVms, eq(runtimeVms.id, runtimeArtifacts.runtimeVmId))
      .innerJoin(
        runtimeExecutions,
        eq(runtimeExecutions.id, runtimeArtifacts.executionId),
      )
      .innerJoin(
        workshopWorkspaceGenerations,
        eq(
          workshopWorkspaceGenerations.runtimeExecutionId,
          runtimeExecutions.id,
        ),
      )
      .innerJoin(
        workshopWorkspaces,
        eq(workshopWorkspaces.id, workshopWorkspaceGenerations.workspaceId),
      )
      .innerJoin(
        workshopSessions,
        eq(workshopSessions.id, workshopWorkspaces.sessionId),
      )
      .where(and(ownership, eq(runtimeArtifacts.uploadStatus, "uploaded")))
      .orderBy(
        asc(workshopWorkspaceGenerations.ordinal),
        asc(runtimeVms.ordinal),
        asc(runtimeArtifacts.ordinal),
      ),
    db
      .select({
        id: runtimeTerminalSessions.id,
        executionId: runtimeTerminalSessions.executionId,
        generationId: workshopWorkspaceGenerations.id,
        generation: workshopWorkspaceGenerations.ordinal,
        vmId: runtimeVms.vmId,
        vmName: runtimeVms.runtimeVmName,
        ordinal: runtimeTerminalSessions.ordinal,
        startedAt: runtimeTerminalSessions.startedAt,
        endedAt: runtimeTerminalSessions.endedAt,
        exitCode: runtimeTerminalSessions.exitCode,
        recordingArtifactId: runtimeTerminalSessions.recordingArtifactId,
        transcriptR2Key: runtimeTerminalSessions.transcriptR2Key,
      })
      .from(runtimeTerminalSessions)
      .innerJoin(
        runtimeVms,
        eq(runtimeVms.id, runtimeTerminalSessions.runtimeVmId),
      )
      .innerJoin(
        runtimeExecutions,
        eq(runtimeExecutions.id, runtimeTerminalSessions.executionId),
      )
      .innerJoin(
        workshopWorkspaceGenerations,
        eq(
          workshopWorkspaceGenerations.runtimeExecutionId,
          runtimeExecutions.id,
        ),
      )
      .innerJoin(
        workshopWorkspaces,
        eq(workshopWorkspaces.id, workshopWorkspaceGenerations.workspaceId),
      )
      .innerJoin(
        workshopSessions,
        eq(workshopSessions.id, workshopWorkspaces.sessionId),
      )
      .where(ownership)
      .orderBy(
        asc(workshopWorkspaceGenerations.ordinal),
        asc(runtimeVms.ordinal),
        asc(runtimeTerminalSessions.ordinal),
      ),
  ]);

  return {
    artifacts: artifactRows
      .filter((row): row is typeof row & { uploadedAt: number } =>
        Number.isFinite(row.uploadedAt),
      )
      .map((row) => ({
        ...row,
        contentUrl: workshopArtifactContentUrl(input.sessionId, row.id),
      })),
    terminalSessions: sessionRows.map(({ transcriptR2Key, ...row }) => ({
      ...row,
      transcriptUrl: transcriptR2Key
        ? workshopTranscriptContentUrl(input.sessionId, row.id)
        : null,
    })),
  };
}

export async function loadWorkshopArtifactForOwner(input: {
  sessionId: string;
  userId: string;
  artifactId: string;
}): Promise<{
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  r2Key: string;
}> {
  await requireWorkshopArtifactOwner(input);
  const rows = await workshopDb()
    .select({
      id: runtimeArtifacts.id,
      filename: runtimeArtifacts.filename,
      contentType: runtimeArtifacts.contentType,
      sizeBytes: runtimeArtifacts.sizeBytes,
      r2Key: runtimeArtifacts.r2Key,
    })
    .from(runtimeArtifacts)
    .innerJoin(
      runtimeExecutions,
      eq(runtimeExecutions.id, runtimeArtifacts.executionId),
    )
    .innerJoin(
      workshopWorkspaceGenerations,
      eq(
        workshopWorkspaceGenerations.runtimeExecutionId,
        runtimeExecutions.id,
      ),
    )
    .innerJoin(
      workshopWorkspaces,
      eq(workshopWorkspaces.id, workshopWorkspaceGenerations.workspaceId),
    )
    .innerJoin(
      workshopSessions,
      eq(workshopSessions.id, workshopWorkspaces.sessionId),
    )
    .where(
      and(
        workshopArtifactOwnershipPredicate(input),
        eq(runtimeArtifacts.id, input.artifactId),
        eq(runtimeArtifacts.uploadStatus, "uploaded"),
      ),
    )
    .limit(1);
  const artifact = rows[0];
  if (!artifact) {
    throw appError(404, "workshop_artifact_not_found", "artifact not found");
  }
  return artifact;
}

export async function loadWorkshopTerminalTranscriptForOwner(input: {
  sessionId: string;
  userId: string;
  terminalSessionId: string;
}): Promise<{ r2Key: string }> {
  await requireWorkshopArtifactOwner(input);
  const rows = await workshopDb()
    .select({ r2Key: runtimeTerminalSessions.transcriptR2Key })
    .from(runtimeTerminalSessions)
    .innerJoin(
      runtimeExecutions,
      eq(runtimeExecutions.id, runtimeTerminalSessions.executionId),
    )
    .innerJoin(
      workshopWorkspaceGenerations,
      eq(
        workshopWorkspaceGenerations.runtimeExecutionId,
        runtimeExecutions.id,
      ),
    )
    .innerJoin(
      workshopWorkspaces,
      eq(workshopWorkspaces.id, workshopWorkspaceGenerations.workspaceId),
    )
    .innerJoin(
      workshopSessions,
      eq(workshopSessions.id, workshopWorkspaces.sessionId),
    )
    .where(
      and(
        workshopArtifactOwnershipPredicate(input),
        eq(runtimeTerminalSessions.id, input.terminalSessionId),
      ),
    )
    .limit(1);
  const r2Key = rows[0]?.r2Key;
  if (!r2Key) {
    throw appError(
      404,
      "workshop_terminal_transcript_not_found",
      "terminal transcript not found",
    );
  }
  return { r2Key };
}

async function requireWorkshopArtifactOwner(input: {
  sessionId: string;
  userId: string;
}): Promise<void> {
  const access = await requireWorkshopSessionMember(input);
  if (access.role !== "participant") {
    throw appError(
      403,
      "workshop_artifact_owner_required",
      "raw workshop artifacts are learner-owned",
    );
  }
}

function workshopArtifactOwnershipPredicate(input: {
  sessionId: string;
  userId: string;
}) {
  return and(
    eq(workshopWorkspaces.sessionId, input.sessionId),
    eq(workshopWorkspaces.userId, input.userId),
    eq(runtimeExecutions.domainKind, "workshop"),
    eq(runtimeExecutions.domainId, workshopWorkspaces.id),
    eq(runtimeExecutions.userId, input.userId),
    eq(runtimeExecutions.generation, workshopWorkspaceGenerations.ordinal),
    eq(runtimeExecutions.organizationId, workshopSessions.organizationId),
  );
}

function workshopArtifactContentUrl(
  sessionId: string,
  artifactId: string,
): string {
  return `/api/workshops/${encodeURIComponent(sessionId)}/artifacts/${encodeURIComponent(artifactId)}/content`;
}

function workshopTranscriptContentUrl(
  sessionId: string,
  terminalSessionId: string,
): string {
  return `/api/workshops/${encodeURIComponent(sessionId)}/terminal-sessions/${encodeURIComponent(terminalSessionId)}/transcript`;
}
