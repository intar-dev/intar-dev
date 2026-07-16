import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organization, user } from "./core";
import { agentHosts } from "./platform";
import { type ScenarioRunHintSnapshot, jsonText, nowMsDefault } from "./shared";

export const scenarioRuns = sqliteTable(
  "scenario_runs",
  {
    runId: text("run_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "restrict",
    }),
    hostId: text("host_id")
      .notNull()
      .references(() => agentHosts.id, { onDelete: "restrict" }),
    scenarioId: text("scenario_id").notNull(),
    scenarioName: text("scenario_name").notNull(),
    title: text("title").notNull(),
    tagline: text("tagline").notNull(),
    briefingMarkdown: text("briefing_markdown").notNull(),
    objectivesJson: text("objectives_json").notNull(),
    difficulty: text("difficulty").notNull(),
    estimatedMinutes: integer("estimated_minutes").notNull(),
    tagsJson: jsonText<string[]>("tags_json").notNull(),
    hintsJson: jsonText<ScenarioRunHintSnapshot[]>("hints_json").notNull(),
    solutionMarkdown: text("solution_markdown").notNull(),
    revealedHintsJson: jsonText<string[]>("revealed_hints_json")
      .default([])
      .notNull(),
    solutionRevealedAt: integer("solution_revealed_at"),
    solutionAssisted: integer("solution_assisted", { mode: "boolean" })
      .default(false)
      .notNull(),
    vmCount: integer("vm_count").notNull(),
    state: text("state").notNull(),
    stateRank: integer("state_rank").notNull(),
    // The owning user id while the run is active, null once terminal; the
    // unique index enforces one active run per user across all scenarios.
    activeKey: text("active_key"),
    stateJson: text("state_json").notNull(),
    deleteRequestedAt: integer("delete_requested_at"),
    solvedAt: integer("solved_at"),
    completedAt: integer("completed_at"),
    failedAt: integer("failed_at"),
    hiddenAt: integer("hidden_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("scenario_runs_active_key_uidx").on(table.activeKey),
    index("scenario_runs_user_scenario_idx").on(
      table.userId,
      table.scenarioId,
      table.createdAt,
    ),
    index("scenario_runs_host_idx").on(table.hostId, table.createdAt),
    index("scenario_runs_organization_idx").on(
      table.organizationId,
      table.createdAt,
    ),
  ],
);

export const scenarioRunSshKeys = sqliteTable(
  "scenario_run_ssh_keys",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => scenarioRuns.runId, { onDelete: "cascade" }),
    vmId: text("vm_id").notNull(),
    runtimeVmName: text("runtime_vm_name").notNull(),
    publicKeyOpenssh: text("public_key_openssh").notNull(),
    privateKeyCiphertextB64: text("private_key_ciphertext_b64").notNull(),
    privateKeyIvB64: text("private_key_iv_b64").notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("scenario_run_ssh_keys_run_vm_uidx").on(
      table.runId,
      table.vmId,
    ),
    index("scenario_run_ssh_keys_run_runtime_idx").on(
      table.runId,
      table.runtimeVmName,
    ),
  ],
);

export const scenarioRunProbeSnapshots = sqliteTable(
  "scenario_run_probe_snapshots",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => scenarioRuns.runId, { onDelete: "cascade" }),
    vmId: text("vm_id").notNull(),
    runtimeVmName: text("runtime_vm_name").notNull(),
    messageId: text("message_id").notNull(),
    collectionState: text("collection_state"),
    collectionError: text("collection_error"),
    summaryJson: text("summary_json"),
    snapshotJson: text("snapshot_json").notNull(),
    generatedAt: integer("generated_at"),
    observedAt: integer("observed_at").notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("scenario_run_probe_snapshots_run_vm_message_uidx").on(
      table.runId,
      table.vmId,
      table.messageId,
    ),
    index("scenario_run_probe_snapshots_run_vm_idx").on(
      table.runId,
      table.vmId,
      table.createdAt,
    ),
  ],
);

export const scenarioRunArtifacts = sqliteTable(
  "scenario_run_artifacts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => scenarioRuns.runId, { onDelete: "cascade" }),
    vmId: text("vm_id").notNull(),
    ordinal: integer("ordinal").notNull(),
    kind: text("kind").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    r2Key: text("r2_key").notNull(),
    uploadStatus: text("upload_status").notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    uploadedAt: integer("uploaded_at"),
  },
  (table) => [
    uniqueIndex("scenario_run_artifacts_vm_ordinal_uidx").on(
      table.vmId,
      table.ordinal,
    ),
    index("scenario_run_artifacts_run_idx").on(
      table.runId,
      table.vmId,
      table.ordinal,
    ),
    index("scenario_run_artifacts_r2_key_idx").on(table.r2Key),
  ],
);

export const scenarioRunArtifactUploads = sqliteTable(
  "scenario_run_artifact_uploads",
  {
    artifactId: text("artifact_id")
      .primaryKey()
      .references(() => scenarioRunArtifacts.id, { onDelete: "cascade" }),
    r2UploadId: text("r2_upload_id"),
    uploadedPartsJson: text("uploaded_parts_json").notNull(),
    nextExpectedPart: integer("next_expected_part").notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
);

/** Plain-text transcript of one SSH session, rendered agent-side from the
 * raw recording. Session metadata lives in the run state document
 * (`vm.sessionTimeline`); only the potentially large text sits here so the
 * run page can lazy-load it per session. */
export const scenarioRunSessionTranscripts = sqliteTable(
  "scenario_run_session_transcripts",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => scenarioRuns.runId, { onDelete: "cascade" }),
    vmId: text("vm_id").notNull(),
    sessionIndex: integer("session_index").notNull(),
    transcript: text("transcript").notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("scenario_run_session_transcripts_session_uidx").on(
      table.runId,
      table.vmId,
      table.sessionIndex,
    ),
  ],
);
