/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  handleAgentRunCliRequest,
  handleWorkspaceRunCliRequest,
} from "@/control-plane/run-cli";
import { handleWorkspaceAgentControlPlaneRequest } from "@/control-plane/workspace-agent";
import { handleAgentBootstrap, sha256Hex } from "@/control-plane/auth";
import {
  revealScenarioRunHintForUser,
  revealScenarioRunSolutionForUser,
} from "@/lib/scenario-hints";
import { revealWorkshopHintForRunCli } from "@/lib/workshops/progress";
import {
  agentBootstrapTokens,
  agentHosts,
  accessAllowlist,
  runtimeExecutions,
  runtimeVmActualState,
  runtimeVms,
  member,
  organization,
  scenarioRuns,
  user,
  workshopSessionMembers,
  workshopSessions,
  workshopModuleProgress,
  workshopTemplateRevisions,
  workshopTemplates,
  workshopWorkspaceGenerations,
  workshopWorkspaces,
  type WorkshopManifestV2,
} from "@/db/schema";
import type { RunCliResponseV1 } from "@/generated/run-cli";
import { RUN_PHASE_ORDER, buildInitialRunState, recomputeRunState } from "@/lib/run-state";
import { grantFixtureBetaAccess } from "@/test/beta-access-fixtures";
import { resetD1Database } from "@/test/d1-migrations";

const JAIL_GENERATION = "jail-generation-1";

describe("private KVM run CLI control plane", () => {
  beforeEach(resetD1Database);

  it("requires an agent bearer and a current VM jail generation", async () => {
    const token = await seedScenarioRun();

    const unauthenticated = await callRunCli(null, statusRequest());
    expect(unauthenticated.status).toBe(401);

    const staleGeneration = await callRunCli(token, statusRequest(), {
      jailGeneration: "jail-generation-stale",
    });
    expect(staleGeneration.status).toBe(200);
    await expect(staleGeneration.json<RunCliResponseV1>()).resolves.toEqual(
      expect.objectContaining({
        protocol_version: 1,
        request_id: "status-1",
        result: {
          kind: "error",
          error: expect.objectContaining({ code: "unavailable" }),
        },
      }),
    );

    const accepted = await callRunCli(token, statusRequest());
    expect(accepted.status).toBe(200);
    expect(accepted.headers.get("cache-control")).toBe("private, no-store");
    const response = await accepted.json<RunCliResponseV1>();
    expect(response).toMatchObject({
      protocol_version: 1,
      request_id: "status-1",
      result: {
        kind: "ok",
        view: {
          run: { kind: "scenario", title: "Broken service", context: "web" },
          checks: [
            {
              probe_id: "web-ready",
              alias: "check-1",
              label: "Make the web service reachable",
              status: "fail",
            },
          ],
          hint_groups: [
            expect.objectContaining({
              alias: "general",
              entries: [
                expect.objectContaining({ state: "ready" }),
                expect.objectContaining({ state: "locked" }),
              ],
            }),
            expect.objectContaining({ alias: "check-1" }),
          ],
          solution: { state: "sealed", assisted: false },
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain("raw secret probe output");
  });

  it("keeps scenario hints sealed and uses the existing sequential reveal service", async () => {
    const token = await seedScenarioRun();

    const revealed = await callRunCli(token, {
      protocol_version: 1,
      request_id: "hint-1",
      action: { kind: "hint_reveal", alias: "general", expected_ordinal: 1 },
    });
    expect(revealed.status).toBe(200);
    const response = await revealed.json<RunCliResponseV1>();
    const groups = response.result.kind === "ok" ? response.result.view.hint_groups : [];
    const general = groups.find((group) => group.alias === "general");
    expect(general?.entries).toEqual([
      expect.objectContaining({
        state: "revealed",
        title: "Check the service state",
        body_markdown: "Inspect the process before changing files.",
      }),
      expect.objectContaining({ state: "ready" }),
    ]);
    expect(general?.entries[1]?.title).toBeUndefined();
    expect(general?.entries[1]?.body_markdown).toBeUndefined();

    const retry = await callRunCli(token, {
      protocol_version: 1,
      request_id: "hint-retry-1",
      action: { kind: "hint_reveal", alias: "general", expected_ordinal: 1 },
    });
    expect(retry.status).toBe(200);
    const retryBody = await retry.json<RunCliResponseV1>();
    const retryGeneral =
      retryBody.result.kind === "ok"
        ? retryBody.result.view.hint_groups.find(
            (group) => group.alias === "general",
          )
        : null;
    expect(retryGeneral?.entries.map((entry) => entry.state)).toEqual([
      "revealed",
      "ready",
    ]);
    const [afterRetry] = await drizzle(env.DB)
      .select({ revealed: scenarioRuns.revealedHintsJson })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, "run-1"));
    expect(afterRetry?.revealed).toEqual(["scenario:first"]);

    const second = await callRunCli(token, {
      protocol_version: 1,
      request_id: "hint-2",
      action: { kind: "hint_reveal", alias: "general", expected_ordinal: 2 },
    });
    expect(second.status).toBe(200);
    const secondBody = await second.json<RunCliResponseV1>();
    const secondGeneral =
      secondBody.result.kind === "ok"
        ? secondBody.result.view.hint_groups.find(
            (group) => group.alias === "general",
          )
        : null;
    expect(secondGeneral?.entries.map((entry) => entry.state)).toEqual([
      "revealed",
      "revealed",
    ]);
  });

  it("marks only a scenario solution reveal as assisted", async () => {
    const token = await seedScenarioRun();
    const response = await callRunCli(token, {
      protocol_version: 1,
      request_id: "solution-1",
      action: { kind: "solution_reveal" },
    });
    expect(response.status).toBe(200);
    await expect(response.json<RunCliResponseV1>()).resolves.toMatchObject({
      result: {
        kind: "ok",
        view: {
          solution: {
            state: "revealed",
            assisted: true,
            body_markdown: "Restart the service and verify it.",
          },
        },
      },
    });
  });

  it("strips terminal controls and bidi overrides from learner-facing content", async () => {
    const token = await seedScenarioRun();
    const db = drizzle(env.DB);
    await db
      .update(scenarioRuns)
      .set({
        title: "Broken\u001b[31m service\u202e",
        hintsJson: [
          {
            key: "scenario:first",
            scope: "scenario",
            probeName: null,
            id: "first",
            title: "Check\u001b[32m state\u202e",
            bodyMarkdown: "Safe\u001b[0m text\u202e\nnext line",
          },
        ],
        solutionMarkdown: "Fix\u001b[31m it\u202e",
      })
      .where(eq(scenarioRuns.runId, "run-1"));

    const hint = await callRunCli(token, {
      protocol_version: 1,
      request_id: "sanitize-hint",
      action: { kind: "hint_reveal", alias: "general", expected_ordinal: 1 },
    });
    const hintText = await hint.text();
    expect(hintText).not.toContain("\u001b");
    expect(hintText).not.toContain("\u202e");
    expect(hintText).toContain("Safe text");

    const solution = await callRunCli(token, {
      protocol_version: 1,
      request_id: "sanitize-solution",
      action: { kind: "solution_reveal" },
    });
    const solutionText = await solution.text();
    expect(solutionText).not.toContain("\u001b");
    expect(solutionText).not.toContain("\u202e");
  });

  it("rejects oversized, malformed, deleted, and builder-agent requests", async () => {
    const token = await seedScenarioRun();
    const oversized = await callRunCli(
      token,
      `${JSON.stringify(statusRequest()).slice(0, -1)},"padding":"${"x".repeat(256 * 1024)}"}`,
    );
    expect(oversized.status).toBe(413);
    await expect(oversized.json<RunCliResponseV1>()).resolves.toMatchObject({
      result: { kind: "error", error: { code: "frame_too_large" } },
    });

    const malformed = await callRunCli(token, statusRequest(), {
      contentType: "text/plain",
    });
    expect(malformed.status).toBe(400);

    const db = drizzle(env.DB);
    await db
      .update(scenarioRuns)
      .set({ deleteRequestedAt: Date.now() })
      .where(eq(scenarioRuns.runId, "run-1"));
    const deleted = await callRunCli(token, statusRequest());
    expect(deleted.status).toBe(200);
    await expect(deleted.json<RunCliResponseV1>()).resolves.toMatchObject({
      result: { kind: "error", error: { code: "unavailable" } },
    });

    await db
      .update(agentHosts)
      .set({ role: "builder" })
      .where(eq(agentHosts.id, "host-1"));
    const builder = await callRunCli(token, statusRequest());
    expect(builder.status).toBe(403);
  });

  it("preserves participant workshop hints and facilitator-only solutions", async () => {
    await seedWorkshopRunCli();
    const hint = await handleWorkspaceRunCliRequest({
      request: new Request("https://intar.test/api/runtime/workspace-agent/cli", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocol_version: 1,
          request_id: "workshop-hint-1",
          action: { kind: "hint_reveal", alias: "hint-1", expected_ordinal: 1 },
        }),
      }),
      subject: {
        executionId: "workspace-execution-1",
        workspaceId: "workspace-1",
        generation: 1,
        sessionId: "workshop-session-1",
        userId: "workshop-learner-1",
      },
      requireWorkshopEnabled: async () => {},
    });
    expect(hint.status).toBe(200);
    await expect(hint.json<RunCliResponseV1>()).resolves.toMatchObject({
      result: {
        kind: "ok",
        view: {
          run: { kind: "workshop", context: "Repair service" },
          hint_groups: [
            {
              alias: "hint-1",
              can_reveal: false,
              entries: [
                {
                  state: "revealed",
                  title: "Read the service log",
                  body_markdown: "Read the service log before you edit it.",
                },
              ],
            },
          ],
          solution: { state: "unavailable", assisted: false },
        },
      },
    });

    const retry = await handleWorkspaceRunCliRequest({
      request: new Request("https://intar.test/api/runtime/workspace-agent/cli", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocol_version: 1,
          request_id: "workshop-hint-retry",
          action: { kind: "hint_reveal", alias: "hint-1", expected_ordinal: 1 },
        }),
      }),
      subject: workshopSubject(),
      requireWorkshopEnabled: async () => {},
    });
    await expect(retry.json<RunCliResponseV1>()).resolves.toMatchObject({
      result: {
        kind: "ok",
        view: { hint_groups: [{ alias: "hint-1", entries: [{ state: "revealed" }] }] },
      },
    });

    const solution = await handleWorkspaceRunCliRequest({
      request: new Request("https://intar.test/api/runtime/workspace-agent/cli", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocol_version: 1,
          request_id: "workshop-solution-1",
          action: { kind: "solution_reveal" },
        }),
      }),
      subject: {
        executionId: "workspace-execution-1",
        workspaceId: "workspace-1",
        generation: 1,
        sessionId: "workshop-session-1",
        userId: "workshop-learner-1",
      },
      requireWorkshopEnabled: async () => {},
    });
    expect(solution.status).toBe(200);
    await expect(solution.json<RunCliResponseV1>()).resolves.toMatchObject({
      result: { kind: "error", error: { code: "locked" } },
    });
  });

  it("keeps the direct-cloud route bearer-only outside browser origin checks", async () => {
    const response = await handleWorkspaceAgentControlPlaneRequest(
      new Request("https://intar.test/api/runtime/workspace-agent/cli", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(statusRequest()),
      }),
      withRunCliEnforcement("on"),
    );
    expect(response?.status).toBe(401);
    expect(response?.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("hides the direct-cloud CLI route before final rollout enforcement", async () => {
    const response = await handleWorkspaceAgentControlPlaneRequest(
      new Request("https://intar.test/api/runtime/workspace-agent/cli", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(statusRequest()),
      }),
      withRunCliEnforcement("off"),
    );
    expect(response?.status).toBe(404);
  });

  it("does not reveal scenario content when a jail generation changes during the write", async () => {
    await seedScenarioRun();
    const stale = async () => {
      await env.DB
        .prepare(
          `UPDATE runtime_vm_actual_state
           SET report_json = json_set(report_json, '$.runtime_constraints.generation', ?)
           WHERE runtime_vm_id = ?`,
        )
        .bind("jail-generation-2", "runtime-vm-1")
        .run();
    };
    const fence = {
      executionId: "execution-1",
      hostId: "host-1",
      runtimeVmName: "web-runtime",
      jailGeneration: JAIL_GENERATION,
      userId: "learner-1",
    };
    await expect(
      revealScenarioRunHintForUser({
        runId: "run-1",
        userId: "learner-1",
        hintKey: "scenario:first",
        mutationFence: fence,
        beforeMutation: stale,
      }),
    ).rejects.toMatchObject({ code: "scenario_run_cli_fence_stale" });
    await env.DB
      .prepare(
        `UPDATE runtime_vm_actual_state
         SET report_json = json_set(report_json, '$.runtime_constraints.generation', ?)
         WHERE runtime_vm_id = ?`,
      )
      .bind(JAIL_GENERATION, "runtime-vm-1")
      .run();
    await expect(
      revealScenarioRunSolutionForUser({
        runId: "run-1",
        userId: "learner-1",
        mutationFence: fence,
        beforeMutation: stale,
      }),
    ).rejects.toMatchObject({ code: "scenario_run_cli_fence_stale" });
    const [run] = await drizzle(env.DB)
      .select({
        revealed: scenarioRuns.revealedHintsJson,
        solutionRevealedAt: scenarioRuns.solutionRevealedAt,
        solutionAssisted: scenarioRuns.solutionAssisted,
      })
      .from(scenarioRuns)
      .where(eq(scenarioRuns.runId, "run-1"));
    expect(run).toMatchObject({
      revealed: [],
      solutionRevealedAt: null,
      solutionAssisted: false,
    });
  });

  it("does not reveal a workshop hint after its workspace generation is replaced", async () => {
    await seedWorkshopRunCli();
    await expect(
      revealWorkshopHintForRunCli({
        sessionId: "workshop-session-1",
        userId: "workshop-learner-1",
        moduleId: "repair-service",
        hintId: "service-log",
        mutationFence: workshopFence(),
        beforeMutation: async () => {
          const now = Date.now();
          await drizzle(env.DB).insert(workshopWorkspaceGenerations).values({
            id: "workspace-generation-2",
            workspaceId: "workspace-1",
            ordinal: 2,
            checkpointId: "initial",
            state: "queued",
            requestedAt: now,
            createdAt: now,
            updatedAt: now,
          });
          await drizzle(env.DB)
            .update(workshopWorkspaces)
            .set({ currentGenerationId: "workspace-generation-2" })
            .where(eq(workshopWorkspaces.id, "workspace-1"));
        },
      }),
    ).rejects.toMatchObject({ code: "workshop_run_cli_fence_stale" });
    await expect(
      drizzle(env.DB).select().from(workshopModuleProgress),
    ).resolves.toEqual([]);
  });

  it("does not reveal a workshop hint when beta access is revoked during the write", async () => {
    await seedWorkshopRunCli();
    await expect(
      revealWorkshopHintForRunCli({
        sessionId: "workshop-session-1",
        userId: "workshop-learner-1",
        moduleId: "repair-service",
        hintId: "service-log",
        mutationFence: workshopFence(),
        beforeMutation: async () => {
          await drizzle(env.DB)
            .delete(accessAllowlist)
            .where(eq(accessAllowlist.userId, "workshop-learner-1"));
        },
      }),
    ).rejects.toMatchObject({ code: "workshop_run_cli_fence_stale" });
    await expect(
      drizzle(env.DB).select().from(workshopModuleProgress),
    ).resolves.toEqual([]);
  });

  it("rejects facilitator workspaces before their projection can expose hint bodies", async () => {
    await seedWorkshopRunCli();
    await drizzle(env.DB)
      .update(workshopSessionMembers)
      .set({ role: "facilitator" })
      .where(eq(workshopSessionMembers.id, "workshop-roster-1"));
    const response = await handleWorkspaceRunCliRequest({
      request: new Request("https://intar.test/api/runtime/workspace-agent/cli", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(statusRequest()),
      }),
      subject: workshopSubject(),
      requireWorkshopEnabled: async () => {},
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("Read the service log before you edit it.");
    expect(JSON.parse(text)).toMatchObject({
      result: { kind: "error" },
    });
  });

  it("rejects an admin participant before its facilitator projection can expose hint bodies", async () => {
    await seedWorkshopRunCli();
    await drizzle(env.DB)
      .update(member)
      .set({ role: "owner" })
      .where(eq(member.id, "workshop-member-1"));
    const response = await handleWorkspaceRunCliRequest({
      request: new Request("https://intar.test/api/runtime/workspace-agent/cli", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(statusRequest()),
      }),
      subject: workshopSubject(),
      requireWorkshopEnabled: async () => {},
    });
    const text = await response.text();
    expect(text).not.toContain("Read the service log before you edit it.");
    expect(JSON.parse(text)).toMatchObject({ result: { kind: "error" } });
  });

  it("rejects a revoked scenario learner before returning a run view", async () => {
    const token = await seedScenarioRun();
    await drizzle(env.DB)
      .delete(accessAllowlist)
      .where(eq(accessAllowlist.userId, "learner-1"));
    const response = await callRunCli(token, statusRequest());
    await expect(response.json<RunCliResponseV1>()).resolves.toMatchObject({
      result: { kind: "error", error: { code: "unavailable" } },
    });
  });

  it("rejects an oversized aggregate view before returning learner Markdown", async () => {
    const token = await seedScenarioRun();
    const body = "x".repeat(60 * 1024);
    const hints = Array.from({ length: 5 }, (_, index) => ({
      key: `scenario:large-${index}`,
      scope: "scenario" as const,
      probeName: null,
      id: `large-${index}`,
      title: `Large hint ${index + 1}`,
      bodyMarkdown: body,
    }));
    await drizzle(env.DB)
      .update(scenarioRuns)
      .set({
        hintsJson: hints,
        revealedHintsJson: hints.map((hint) => hint.key),
      })
      .where(eq(scenarioRuns.runId, "run-1"));
    const response = await callRunCli(token, statusRequest());
    expect(response.status).toBe(200);
    await expect(response.json<RunCliResponseV1>()).resolves.toMatchObject({
      result: { kind: "error", error: { code: "frame_too_large" } },
    });
  });

  it("changes the opaque retry scope for a replacement VM and a focused workshop module", async () => {
    const token = await seedScenarioRun();
    const first = await callRunCli(token, statusRequest());
    const firstScope = retryScopeOf(await first.json<RunCliResponseV1>());
    await env.DB
      .prepare(
        `UPDATE runtime_vm_actual_state
         SET report_json = json_set(report_json, '$.runtime_constraints.generation', ?)
         WHERE runtime_vm_id = ?`,
      )
      .bind("jail-generation-2", "runtime-vm-1")
      .run();
    const replaced = await callRunCli(token, statusRequest(), {
      jailGeneration: "jail-generation-2",
    });
    const replacedScope = retryScopeOf(await replaced.json<RunCliResponseV1>());
    expect(replacedScope).not.toBe(firstScope);

    await resetD1Database();
    await seedWorkshopRunCli();
    const workshopFirst = await handleWorkspaceRunCliRequest({
      request: new Request("https://intar.test/api/runtime/workspace-agent/cli", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(statusRequest()),
      }),
      subject: workshopSubject(),
      requireWorkshopEnabled: async () => {},
    });
    const workshopFirstScope = retryScopeOf(
      await workshopFirst.json<RunCliResponseV1>(),
    );
    const manifest = workshopManifest();
    manifest.modules.push({
      ...manifest.modules[0]!,
      id: "repair-next",
      title: "Repair next service",
      hints: [],
    });
    await drizzle(env.DB)
      .update(workshopTemplateRevisions)
      .set({ manifestJson: manifest })
      .where(eq(workshopTemplateRevisions.id, "workshop-revision-1"));
    await drizzle(env.DB)
      .update(workshopSessions)
      .set({
        currentModuleId: "repair-next",
        releasedModuleIdsJson: ["repair-service", "repair-next"],
      })
      .where(eq(workshopSessions.id, "workshop-session-1"));
    const workshopNext = await handleWorkspaceRunCliRequest({
      request: new Request("https://intar.test/api/runtime/workspace-agent/cli", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(statusRequest()),
      }),
      subject: workshopSubject(),
      requireWorkshopEnabled: async () => {},
    });
    const workshopNextScope = retryScopeOf(
      await workshopNext.json<RunCliResponseV1>(),
    );
    expect(workshopNextScope).not.toBe(workshopFirstScope);
    expect(workshopNextScope).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });
});

function retryScopeOf(response: RunCliResponseV1): string {
  if (response.result.kind !== "ok") throw new Error("expected a CLI view");
  return response.result.view.retry_scope;
}

function workshopSubject() {
  return {
    executionId: "workspace-execution-1",
    workspaceId: "workspace-1",
    generation: 1,
    sessionId: "workshop-session-1",
    userId: "workshop-learner-1",
  };
}

function workshopFence() {
  return {
    ...workshopSubject(),
  };
}

async function seedWorkshopRunCli(): Promise<void> {
  const db = drizzle(env.DB);
  const now = Date.now();
  const createdAt = new Date(now);
  await db.insert(user).values({
    id: "workshop-learner-1",
    name: "Workshop learner",
    email: "workshop-learner@example.test",
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(user).values({
    id: "workshop-host-owner-1",
    name: "Workshop host owner",
    email: "workshop-host-owner@example.test",
    createdAt,
    updatedAt: createdAt,
  });
  await db.insert(organization).values({
    id: "workshop-org-1",
    name: "Workshop organization",
    slug: "workshop-org-1",
    createdAt,
  });
  await db.insert(agentHosts).values({
    id: "workshop-host-1",
    userId: "workshop-host-owner-1",
    organizationId: "workshop-org-1",
    name: "Workshop host",
    role: "agent",
    scenarioEnabled: true,
    disabled: false,
    connected: true,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(member).values({
    id: "workshop-member-1",
    organizationId: "workshop-org-1",
    userId: "workshop-learner-1",
    role: "member",
    createdAt,
  });
  await grantFixtureBetaAccess({
    d1: env.DB,
    userId: "workshop-learner-1",
    now,
  });
  await db.insert(workshopTemplates).values({
    id: "workshop-template-1",
    organizationId: "workshop-org-1",
    slug: "service-repair",
    title: "Service repair",
    summary: "Fixture workshop",
    createdBy: "workshop-learner-1",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workshopTemplateRevisions).values({
    id: "workshop-revision-1",
    templateId: "workshop-template-1",
    revision: 1,
    sourceRevision: "fixture",
    contentHash: "c".repeat(64),
    manifestJson: workshopManifest(),
    publishedBy: "workshop-learner-1",
    publishedAt: now,
  });
  await db.insert(workshopSessions).values({
    id: "workshop-session-1",
    organizationId: "workshop-org-1",
    templateRevisionId: "workshop-revision-1",
    title: "Repair lab",
    state: "live",
    version: 1,
    scheduledStartAt: now,
    lobbyOpensAt: now - 1,
    currentModuleId: "repair-service",
    releasedModuleIdsJson: ["repair-service"],
    createdBy: "workshop-learner-1",
    startedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workshopSessionMembers).values({
    id: "workshop-roster-1",
    sessionId: "workshop-session-1",
    userId: "workshop-learner-1",
    role: "participant",
    workspaceEnabled: true,
    provisionState: "ready",
    assignedBy: "workshop-learner-1",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workshopWorkspaces).values({
    id: "workspace-1",
    sessionId: "workshop-session-1",
    userId: "workshop-learner-1",
    state: "ready",
    currentGenerationId: "workspace-generation-1",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(runtimeExecutions).values({
    id: "workspace-execution-1",
    userId: "workshop-learner-1",
    organizationId: "workshop-org-1",
    hostId: "workshop-host-1",
    providerKind: "agent_kvm",
    providerConnectionId: null,
    domainKind: "workshop",
    domainId: "workspace-1",
    generation: 1,
    sourceExecutionId: null,
    checkpointId: "initial",
    state: "ready",
    leaseExpiresAt: null,
    archiveRequestedAt: null,
    endedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(workshopWorkspaceGenerations).values({
    id: "workspace-generation-1",
    workspaceId: "workspace-1",
    ordinal: 1,
    runtimeExecutionId: "workspace-execution-1",
    checkpointId: "initial",
    hostId: "workshop-host-1",
    state: "ready",
    requestedAt: now,
    readyAt: now,
    createdAt: now,
    updatedAt: now,
  });
}

function workshopManifest(): WorkshopManifestV2 {
  return {
    schemaVersion: 2,
    workshop: {
      slug: "service-repair",
      title: "Service repair",
      summary: "Fixture workshop",
      prerequisites: [],
      attribution: {
        title: "Fixture",
        url: "https://example.test/workshop",
        license: "Apache-2.0",
      },
      defaultLobbyMinutes: 5,
    },
    workspace: {
      leaseGraceMinutes: 30,
      vms: [
        {
          id: "learner",
          name: "Learner",
          cpuMillis: 1000,
          memoryMib: 1024,
          diskMib: 4096,
        },
      ],
      runtimeProfiles: [],
      checkpoints: [
        { id: "initial", label: "Initial", vmImages: [] },
      ],
      initialCheckpointId: "initial",
      applications: [],
    },
    modules: [
      {
        id: "repair-service",
        title: "Repair service",
        tier: "core",
        outcome: "The service works.",
        dependsOn: [],
        participantMarkdown: "Repair the service.",
        facilitatorNotesMarkdown: "Observe the repair.",
        hints: [
          {
            id: "service-log",
            title: "Read the service log",
            bodyMarkdown: "Read the service log before you edit it.",
          },
        ],
        solutionMarkdown: "Restart the service.",
        probeIds: [],
        catchUpCheckpointId: "initial",
      },
    ],
    agenda: [],
    presentation: { slides: [] },
    durationMinutes: 60,
  };
}

async function seedScenarioRun(): Promise<string> {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.insert(user).values([
    {
      id: "learner-1",
      name: "Learner",
      email: "learner@example.test",
    },
    {
      id: "host-owner-1",
      name: "Host owner",
      email: "host-owner@example.test",
    },
  ]);
  await grantFixtureBetaAccess({ d1: env.DB, userId: "host-owner-1", now });
  await grantFixtureBetaAccess({ d1: env.DB, userId: "learner-1", now });
  await db.insert(agentHosts).values({
    id: "host-1",
    userId: "host-owner-1",
    name: "KVM runner",
    role: "agent",
    scenarioEnabled: true,
    disabled: false,
    connected: true,
    createdAt: now,
    updatedAt: now,
  });

  const initial = buildInitialRunState({
    vms: [
      {
        id: "vm-1",
        ordinal: 0,
        scenarioVmId: "scenario-vm-1",
        scenarioVmName: "web",
        runtimeVmName: "web-runtime",
        hostname: "web",
        launchSummary: {
          scenarioVmName: "web",
          hostname: "web",
          probePhaseMap: { "web-ready": "scenario" },
          probeDescriptors: [
            {
              id: "web-ready",
              label: "Make the web service reachable",
              kind: "http",
              phase: "scenario",
            },
          ],
        },
      },
    ],
  });
  const state = recomputeRunState({
    ...initial,
    phase: "active_full",
    vms: initial.vms.map((vm) => ({
      ...vm,
      phase: "ready",
      runtimeConstraints: {
        generation: JAIL_GENERATION,
        phase: "steady",
        steadyCpuMillis: 500,
        effectiveCpuMillis: 500,
        quotaVerifiedAt: now,
        leaseExpiresAt: null,
      },
      scenarioProbes: vm.scenarioProbes.map((probe) => ({
        ...probe,
        status: "fail",
      })),
    })),
  });

  await db.insert(runtimeExecutions).values({
    id: "execution-1",
    userId: "learner-1",
    organizationId: null,
    hostId: "host-1",
    providerKind: "agent_kvm",
    providerConnectionId: null,
    domainKind: "scenario",
    domainId: "run-1",
    generation: 1,
    sourceExecutionId: null,
    checkpointId: null,
    state: "ready",
    leaseExpiresAt: null,
    archiveRequestedAt: null,
    endedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(runtimeVms).values({
    id: "runtime-vm-1",
    executionId: "execution-1",
    vmId: "vm-1",
    ordinal: 0,
    runtimeVmName: "web-runtime",
    imageKeyJson: { scenario: "broken", vm: "web", arch: "x86_64" },
    imageSha256: "a".repeat(64),
    cpuMillis: 500,
    memoryMib: 512,
    diskMib: 1024,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(scenarioRuns).values({
    runId: "run-1",
    userId: "learner-1",
    organizationId: null,
    runtimeExecutionId: "execution-1",
    hostId: "host-1",
    scenarioId: "broken-service",
    scenarioName: "broken-service",
    title: "Broken service",
    tagline: "Repair the service",
    briefingMarkdown: "Briefing",
    objectivesJson: "[]",
    difficulty: "easy",
    estimatedMinutes: 10,
    tagsJson: [],
    hintsJson: [
      {
        key: "scenario:first",
        scope: "scenario",
        probeName: null,
        id: "first",
        title: "Check the service state",
        bodyMarkdown: "Inspect the process before changing files.",
      },
      {
        key: "scenario:second",
        scope: "scenario",
        probeName: null,
        id: "second",
        title: "Read the service log",
        bodyMarkdown: "Read the service log before retrying.",
      },
      {
        key: "probe:web:web-ready:repair",
        scope: "probe",
        probeName: "web-ready",
        id: "repair",
        title: "Inspect the listener",
        bodyMarkdown: "Inspect the active listener.",
      },
    ],
    solutionMarkdown: "Restart the service and verify it.",
    revealedHintsJson: [],
    solutionRevealedAt: null,
    solutionAssisted: false,
    vmCount: 1,
    state: state.phase,
    stateRank: RUN_PHASE_ORDER[state.phase],
    activeKey: "learner-1",
    stateJson: JSON.stringify(state),
    archiveEnteredAt: null,
    deleteRequestedAt: null,
    solvedAt: null,
    completedAt: null,
    failedAt: null,
    hiddenAt: null,
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(runtimeVmActualState).values({
    runtimeVmId: "runtime-vm-1",
    executionId: "execution-1",
    hostId: "host-1",
    phase: "ready",
    desiredVersion: 1,
    reportJson: {
      run_id: "execution-1",
      vm_name: "web-runtime",
      phase: "ready",
      terminal: { state: "pending", observed_at_unix_ms: now },
      runtime_constraints: {
        generation: JAIL_GENERATION,
        phase: "steady",
        steady_cpu_millis: 500,
        effective_cpu_millis: 500,
        quota_verified_at_unix_ms: now,
      },
      ssh_host_keys_openssh: [],
      probes: [
        {
          id: "web-ready",
          phase: "scenario",
          status: "fail",
          checked_at_unix_ms: now,
          message: "raw secret probe output",
        },
      ],
      updated_at_unix_ms: now,
    },
    observedAt: now,
    updatedAt: now,
  });

  const bootstrapToken = "run-cli-bootstrap";
  await db.insert(agentBootstrapTokens).values({
    id: "bootstrap-1",
    hostId: "host-1",
    tokenHash: await sha256Hex(bootstrapToken),
    expiresAt: now + 60_000,
    createdAt: now,
  });
  const bootstrap = await handleAgentBootstrap(
    new Request("https://intar.test/agent/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ hostId: "host-1", bootstrapToken }),
    }),
    env,
  );
  expect(bootstrap.status).toBe(200);
  return (await bootstrap.json<{ accessToken: string }>()).accessToken;
}

function statusRequest() {
  return {
    protocol_version: 1,
    request_id: "status-1",
    action: { kind: "status" } as const,
  };
}

function withRunCliEnforcement(value: "on" | "off"): Cloudflare.Env {
  const override = Object.create(env) as Cloudflare.Env;
  Object.defineProperty(override, "LEARNER_RUN_CLI_V1_ENFORCEMENT", {
    value,
  });
  return override;
}

async function callRunCli(
  token: string | null,
  body: Record<string, unknown> | string,
  options?: { jailGeneration?: string; contentType?: string },
): Promise<Response> {
  return handleAgentRunCliRequest(
    new Request("https://intar.test/agent/runs/execution-1/vms/web-runtime/cli", {
      method: "POST",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        "content-type": options?.contentType ?? "application/json",
        "x-intar-jail-generation": options?.jailGeneration ?? JAIL_GENERATION,
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    env,
  ).then((response) => {
    if (!response) throw new Error("expected run CLI route response");
    return response;
  });
}
