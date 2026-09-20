import { env } from "cloudflare:workers";
import { beforeEach, expect, it, vi } from "vitest";
import { resetD1Database } from "@/test/d1-migrations";

const cleanup = vi.hoisted(() => ({ destroyScenarioRunForUser: vi.fn(), wakeHostRuntime: vi.fn() }));
vi.mock("@/lib/scenario-runs/lifecycle", () => ({ destroyScenarioRunForUser: cleanup.destroyScenarioRunForUser }));
vi.mock("@/lib/host-runtime-wake", () => ({ wakeHostRuntime: cleanup.wakeHostRuntime }));
import { leaveOrganization, removeOrganizationMember } from "./organizations";
import { auth } from "./auth";

beforeEach(async () => {
  vi.clearAllMocks();
  cleanup.destroyScenarioRunForUser.mockResolvedValue({ accepted: true });
  cleanup.wakeHostRuntime.mockResolvedValue(undefined);
  await resetD1Database();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO user (id, name, email, metal_placement) VALUES ('owner', 'Owner', 'owner@example.test', 'personal'), ('learner', 'Learner', 'learner@example.test', 'personal'), ('other', 'Other', 'other@example.test', 'personal')"),
    env.DB.prepare("INSERT INTO organization (id, name, slug, created_at) VALUES ('org-a', 'A', 'a', 1), ('org-b', 'B', 'b', 1)"),
    env.DB.prepare("INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('owner-member', 'org-a', 'owner', 'owner', 1), ('learner-member', 'org-a', 'learner', 'member', 1), ('other-member', 'org-a', 'other', 'member', 1)"),
    env.DB.prepare("INSERT INTO agent_hosts (id, user_id, name, scope, credential_generation) VALUES ('host', 'learner', 'Server', 'personal', 1)"),
  ]);
  for (const [runId, userId, orgId] of [["target", "learner", "org-a"], ["other-org", "learner", "org-b"], ["public", "learner", null], ["other-user", "other", "org-a"]]) {
    await env.DB.prepare(`INSERT INTO scenario_runs
      (run_id, user_id, organization_id, host_id, scenario_id, scenario_name, title, tagline, briefing_markdown,
       objectives_json, difficulty, estimated_minutes, tags_json, hints_json, solution_markdown, vm_count, state, state_rank, state_json)
      VALUES (?, ?, ?, 'host', 'scenario', 'Scenario', 'Title', '', '', '[]', 'beginner', 1, '[]', '[]', '', 0, 'provisioning', 1, '{}')`)
      .bind(runId!, userId!, orgId ?? null).run();
  }
});
it.each(["remove", "leave"])("%s stops only the former member's organization runs", async operation => {
  if (operation === "remove") await removeOrganizationMember({ organizationId: "org-a", memberId: "learner-member", actorUserId: "owner" });
  else await leaveOrganization({ organizationId: "org-a", userId: "learner" });
  expect(cleanup.destroyScenarioRunForUser.mock.calls).toEqual([[{ runId: "target", userId: "learner" }]]);
  expect(cleanup.wakeHostRuntime.mock.calls).toEqual([["host"]]);
  const pending = await env.DB.prepare("SELECT run_id FROM scenario_runs WHERE delete_requested_at IS NOT NULL").all();
  expect(pending.results).toEqual([{ run_id: "target" }]);
  expect(await env.DB.prepare("SELECT id FROM member WHERE id = 'learner-member'").first()).toBeNull();
  expect(await env.DB.prepare("SELECT metal_placement FROM user WHERE id = 'learner'").first()).toEqual({ metal_placement: "personal" });
});
it("keeps shutdown intent durable when immediate cleanup fails, including after rejoin", async () => {
  cleanup.destroyScenarioRunForUser.mockRejectedValue(new Error("route cleanup failed"));
  await expect(removeOrganizationMember({ organizationId: "org-a", memberId: "learner-member", actorUserId: "owner" })).rejects.toMatchObject({ code: "organization_run_cleanup_pending" });
  expect(cleanup.wakeHostRuntime).toHaveBeenCalledWith("host");
  await env.DB.prepare("INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('rejoined', 'org-a', 'learner', 'member', 2)").run();
  expect((await env.DB.prepare("SELECT delete_requested_at FROM scenario_runs WHERE run_id = 'target'").first<{ delete_requested_at: number }>())?.delete_requested_at).toBeGreaterThan(0);
});
it("rejects alternate auth plugin mutations before they can remove membership", async () => {
  await expect(auth.api.leaveOrganization({ body: { organizationId: "org-a" }, headers: new Headers() })).rejects.toMatchObject({ status: "FORBIDDEN" });
  await expect(auth.api.removeMember({ body: { organizationId: "org-a", memberIdOrEmail: "learner-member" }, headers: new Headers() })).rejects.toMatchObject({ status: "FORBIDDEN" });
  expect(await env.DB.prepare("SELECT id FROM member WHERE id = 'learner-member'").first()).toEqual({ id: "learner-member" });
  expect(cleanup.destroyScenarioRunForUser).not.toHaveBeenCalled();
});
