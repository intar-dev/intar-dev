import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { WorkshopManifestV2 } from "@intar/workshop-contracts";
import { organization, user } from "./core";
import { jsonText, nowMsDefault } from "./shared";

export type WorkshopSessionState =
  | "draft"
  | "lobby"
  | "live"
  | "ended"
  | "cancelled";
export type WorkshopSessionRole = "participant" | "helper" | "facilitator";
export type WorkshopProvisionState =
  | "not_ready"
  | "queued"
  | "provisioning"
  | "ready"
  | "failed"
  | "ended";
export type WorkshopWorkspaceState =
  | "queued"
  | "provisioning"
  | "ready"
  | "recovering"
  | "ending"
  | "ended"
  | "failed";
export type WorkshopWorkspaceGenerationState =
  | "queued"
  | "provisioning"
  | "ready"
  | "archiving"
  | "archived"
  | "failed";
export type WorkshopTechnicalStatus =
  | "not_started"
  | "working"
  | "verified"
  | "caught_up"
  | "manually_completed"
  | "skipped";
export type WorkshopCurrentHealth = "unknown" | "passing" | "failing";
export type WorkshopExplainBackStatus =
  | "not_required"
  | "pending"
  | "completed";
export type WorkshopHelpRequestStatus =
  | "open"
  | "claimed"
  | "resolved"
  | "cancelled";

export const workshopTemplates = sqliteTable(
  "workshop_templates",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    summary: text("summary").notNull(),
    currentRevisionId: text("current_revision_id"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("workshop_templates_org_slug_uidx").on(
      table.organizationId,
      table.slug,
    ),
    index("workshop_templates_org_updated_idx").on(
      table.organizationId,
      table.updatedAt,
    ),
  ],
);

export const workshopTemplateRevisions = sqliteTable(
  "workshop_template_revisions",
  {
    id: text("id").primaryKey(),
    templateId: text("template_id")
      .notNull()
      .references(() => workshopTemplates.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    sourceRevision: text("source_revision").notNull(),
    contentHash: text("content_hash").notNull(),
    manifestJson: jsonText<WorkshopManifestV2>("manifest_json").notNull(),
    publishedBy: text("published_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    publishedAt: integer("published_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("workshop_template_revisions_number_uidx").on(
      table.templateId,
      table.revision,
    ),
    index("workshop_template_revisions_content_idx").on(
      table.templateId,
      table.contentHash,
    ),
    index("workshop_template_revisions_template_published_idx").on(
      table.templateId,
      table.publishedAt,
    ),
    check(
      "workshop_template_revisions_revision_positive",
      sql`${table.revision} > 0`,
    ),
  ],
);

export const workshopSessions = sqliteTable(
  "workshop_sessions",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    templateRevisionId: text("template_revision_id")
      .notNull()
      .references(() => workshopTemplateRevisions.id, {
        onDelete: "restrict",
      }),
    title: text("title").notNull(),
    state: text("state")
      .$type<WorkshopSessionState>()
      .default("draft")
      .notNull(),
    version: integer("version").default(1).notNull(),
    scheduledStartAt: integer("scheduled_start_at").notNull(),
    lobbyOpensAt: integer("lobby_opens_at").notNull(),
    currentAgendaItemId: text("current_agenda_item_id"),
    currentModuleId: text("current_module_id"),
    currentSlideId: text("current_slide_id"),
    releasedModuleIdsJson: jsonText<string[]>("released_module_ids_json")
      .default([])
      .notNull(),
    revealedHintIdsJson: jsonText<string[]>("revealed_hint_ids_json")
      .default([])
      .notNull(),
    revealedSolutionModuleIdsJson: jsonText<string[]>(
      "revealed_solution_module_ids_json",
    )
      .default([])
      .notNull(),
    timerStartedAt: integer("timer_started_at"),
    timerEndsAt: integer("timer_ends_at"),
    timerPausedAt: integer("timer_paused_at"),
    timerRemainingMs: integer("timer_remaining_ms"),
    announcement: text("announcement"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    startedAt: integer("started_at"),
    endedAt: integer("ended_at"),
    cancelledAt: integer("cancelled_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("workshop_sessions_org_state_start_idx").on(
      table.organizationId,
      table.state,
      table.scheduledStartAt,
    ),
    index("workshop_sessions_revision_idx").on(table.templateRevisionId),
    check(
      "workshop_sessions_state_valid",
      sql`${table.state} in ('draft', 'lobby', 'live', 'ended', 'cancelled')`,
    ),
    check("workshop_sessions_version_positive", sql`${table.version} > 0`),
    check(
      "workshop_sessions_lobby_before_start",
      sql`${table.lobbyOpensAt} <= ${table.scheduledStartAt}`,
    ),
  ],
);

export const workshopSessionMembers = sqliteTable(
  "workshop_session_members",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => workshopSessions.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    role: text("role").$type<WorkshopSessionRole>().notNull(),
    workspaceEnabled: integer("workspace_enabled", { mode: "boolean" })
      .default(false)
      .notNull(),
    checkedInAt: integer("checked_in_at"),
    lastSeenAt: integer("last_seen_at"),
    provisionState: text("provision_state")
      .$type<WorkshopProvisionState>()
      .default("not_ready")
      .notNull(),
    provisionError: text("provision_error"),
    assignedBy: text("assigned_by")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("workshop_session_members_session_user_uidx").on(
      table.sessionId,
      table.userId,
    ),
    index("workshop_session_members_session_role_idx").on(
      table.sessionId,
      table.role,
      table.provisionState,
    ),
    index("workshop_session_members_session_workspace_idx").on(
      table.sessionId,
      table.workspaceEnabled,
      table.provisionState,
    ),
    index("workshop_session_members_session_last_seen_idx").on(
      table.sessionId,
      table.lastSeenAt,
    ),
    check(
      "workshop_session_members_role_valid",
      sql`${table.role} in ('participant', 'helper', 'facilitator')`,
    ),
    check(
      "workshop_session_members_provision_state_valid",
      sql`${table.provisionState} in ('not_ready', 'queued', 'provisioning', 'ready', 'failed', 'ended')`,
    ),
  ],
);

export const workshopWorkspaces = sqliteTable(
  "workshop_workspaces",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => workshopSessions.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    state: text("state")
      .$type<WorkshopWorkspaceState>()
      .default("queued")
      .notNull(),
    currentGenerationId: text("current_generation_id"),
    lastCheckpointId: text("last_checkpoint_id"),
    recoveryMessage: text("recovery_message"),
    terminalRouteUsernamesJson: jsonText<string[]>(
      "terminal_route_usernames_json",
    )
      .default([])
      .notNull(),
    applicationRouteIdsJson: jsonText<string[]>("application_route_ids_json")
      .default([])
      .notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
    endedAt: integer("ended_at"),
  },
  (table) => [
    uniqueIndex("workshop_workspaces_session_user_uidx").on(
      table.sessionId,
      table.userId,
    ),
    index("workshop_workspaces_session_state_idx").on(
      table.sessionId,
      table.state,
    ),
    check(
      "workshop_workspaces_state_valid",
      sql`${table.state} in ('queued', 'provisioning', 'ready', 'recovering', 'ending', 'ended', 'failed')`,
    ),
    check(
      "workshop_workspaces_terminal_routes_json_valid",
      sql`json_valid(${table.terminalRouteUsernamesJson})`,
    ),
    check(
      "workshop_workspaces_application_routes_json_valid",
      sql`json_valid(${table.applicationRouteIdsJson})`,
    ),
  ],
);

export const workshopWorkspaceGenerations = sqliteTable(
  "workshop_workspace_generations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workshopWorkspaces.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    runtimeExecutionId: text("runtime_execution_id"),
    checkpointId: text("checkpoint_id"),
    hostId: text("host_id"),
    state: text("state")
      .$type<WorkshopWorkspaceGenerationState>()
      .default("queued")
      .notNull(),
    error: text("error"),
    requestedAt: integer("requested_at").default(nowMsDefault).notNull(),
    provisioningStartedAt: integer("provisioning_started_at"),
    readyAt: integer("ready_at"),
    archiveRequestedAt: integer("archive_requested_at"),
    archivedAt: integer("archived_at"),
    failedAt: integer("failed_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("workshop_workspace_generations_ordinal_uidx").on(
      table.workspaceId,
      table.ordinal,
    ),
    uniqueIndex("workshop_workspace_generations_execution_uidx").on(
      table.runtimeExecutionId,
    ),
    index("workshop_workspace_generations_workspace_state_idx").on(
      table.workspaceId,
      table.state,
    ),
    check(
      "workshop_workspace_generations_ordinal_positive",
      sql`${table.ordinal} > 0`,
    ),
    check(
      "workshop_workspace_generations_state_valid",
      sql`${table.state} in ('queued', 'provisioning', 'ready', 'archiving', 'archived', 'failed')`,
    ),
  ],
);

export const workshopModuleProgress = sqliteTable(
  "workshop_module_progress",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => workshopSessions.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    moduleId: text("module_id").notNull(),
    technicalStatus: text("technical_status")
      .$type<WorkshopTechnicalStatus>()
      .default("not_started")
      .notNull(),
    currentHealth: text("current_health")
      .$type<WorkshopCurrentHealth>()
      .default("unknown")
      .notNull(),
    explainBackStatus: text("explain_back_status")
      .$type<WorkshopExplainBackStatus>()
      .default("not_required")
      .notNull(),
    revealedHintIdsJson: jsonText<string[]>("revealed_hint_ids_json")
      .default([])
      .notNull(),
    startedAt: integer("started_at"),
    firstVerifiedAt: integer("first_verified_at"),
    caughtUpAt: integer("caught_up_at"),
    explainBackCompletedAt: integer("explain_back_completed_at"),
    healthObservedAt: integer("health_observed_at"),
    completedAt: integer("completed_at"),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("workshop_module_progress_session_user_module_uidx").on(
      table.sessionId,
      table.userId,
      table.moduleId,
    ),
    index("workshop_module_progress_session_module_idx").on(
      table.sessionId,
      table.moduleId,
      table.technicalStatus,
    ),
    check(
      "workshop_module_progress_technical_status_valid",
      sql`${table.technicalStatus} in ('not_started', 'working', 'verified', 'caught_up', 'manually_completed', 'skipped')`,
    ),
    check(
      "workshop_module_progress_current_health_valid",
      sql`${table.currentHealth} in ('unknown', 'passing', 'failing')`,
    ),
    check(
      "workshop_module_progress_explain_back_status_valid",
      sql`${table.explainBackStatus} in ('not_required', 'pending', 'completed')`,
    ),
  ],
);

export const workshopHelpRequests = sqliteTable(
  "workshop_help_requests",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => workshopSessions.id, { onDelete: "cascade" }),
    requesterUserId: text("requester_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    moduleId: text("module_id"),
    message: text("message").notNull(),
    status: text("status")
      .$type<WorkshopHelpRequestStatus>()
      .default("open")
      .notNull(),
    activeKey: text("active_key"),
    claimedBy: text("claimed_by").references(() => user.id, {
      onDelete: "restrict",
    }),
    claimedAt: integer("claimed_at"),
    resolvedAt: integer("resolved_at"),
    cancelledAt: integer("cancelled_at"),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("workshop_help_requests_active_key_uidx").on(table.activeKey),
    index("workshop_help_requests_session_status_idx").on(
      table.sessionId,
      table.status,
      table.createdAt,
    ),
    check(
      "workshop_help_requests_status_valid",
      sql`${table.status} in ('open', 'claimed', 'resolved', 'cancelled')`,
    ),
  ],
);

export const workshopAssistGrants = sqliteTable(
  "workshop_assist_grants",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => workshopSessions.id, { onDelete: "cascade" }),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workshopWorkspaces.id, { onDelete: "cascade" }),
    helpRequestId: text("help_request_id")
      .notNull()
      .references(() => workshopHelpRequests.id, { onDelete: "cascade" }),
    learnerUserId: text("learner_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    helperUserId: text("helper_user_id")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    grantedAt: integer("granted_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    revokedBy: text("revoked_by").references(() => user.id, {
      onDelete: "restrict",
    }),
    terminalRouteUsernamesJson: jsonText<string[]>(
      "terminal_route_usernames_json",
    )
      .default([])
      .notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
    updatedAt: integer("updated_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    uniqueIndex("workshop_assist_grants_help_request_uidx").on(
      table.helpRequestId,
    ),
    index("workshop_assist_grants_helper_expiry_idx").on(
      table.helperUserId,
      table.expiresAt,
    ),
    index("workshop_assist_grants_workspace_expiry_idx").on(
      table.workspaceId,
      table.expiresAt,
    ),
    check(
      "workshop_assist_grants_duration_valid",
      sql`${table.expiresAt} > ${table.grantedAt} AND ${table.expiresAt} <= ${table.grantedAt} + 1800000`,
    ),
    check(
      "workshop_assist_grants_terminal_routes_json_valid",
      sql`json_valid(${table.terminalRouteUsernamesJson})`,
    ),
  ],
);

export const workshopEvents = sqliteTable(
  "workshop_events",
  {
    id: text("id").primaryKey(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "restrict" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => workshopSessions.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => user.id, {
      onDelete: "restrict",
    }),
    type: text("type").notNull(),
    payloadJson: jsonText<Record<string, unknown>>("payload_json")
      .default({})
      .notNull(),
    createdAt: integer("created_at").default(nowMsDefault).notNull(),
  },
  (table) => [
    index("workshop_events_session_created_idx").on(
      table.sessionId,
      table.createdAt,
    ),
    index("workshop_events_org_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
  ],
);
