import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { resetD1Database } from "@/test/d1-migrations";

const cleanup = vi.hoisted(() => ({ destroyScenarioRunForUser: vi.fn(), wakeHostRuntime: vi.fn() }));
vi.mock("@/lib/scenario-runs/lifecycle", () => ({ destroyScenarioRunForUser: cleanup.destroyScenarioRunForUser }));
vi.mock("@/lib/host-runtime-wake", () => ({ wakeHostRuntime: cleanup.wakeHostRuntime }));
import {
  getOrganizationDetail,
  leaveOrganization,
  removeOrganizationMember,
  restoreOrganizationMember,
  restoreRemovedMemberAsPlatformAdmin,
  updateOrganizationMemberRole,
} from "./organizations";
import { auth } from "./auth";

// A test that fails before its spied batch runs must not leave the spy armed.
afterEach(() => vi.restoreAllMocks());

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
it("records a removal that only an admin's restore lifts", async () => {
  await removeOrganizationMember({ organizationId: "org-a", memberId: "learner-member", actorUserId: "owner" });
  expect(await env.DB.prepare("SELECT removed_by FROM organization_member_removals WHERE organization_id = 'org-a' AND user_id = 'learner'").first()).toEqual({ removed_by: "owner" });
  await expect(restoreOrganizationMember({ organizationId: "org-a", userId: "learner", actorUserId: "other" })).rejects.toMatchObject({ status: 403 });
  await restoreOrganizationMember({ organizationId: "org-a", userId: "learner", actorUserId: "owner" });
  expect(await env.DB.prepare("SELECT user_id FROM organization_member_removals").first()).toBeNull();
  await expect(restoreOrganizationMember({ organizationId: "org-a", userId: "learner", actorUserId: "owner" })).rejects.toMatchObject({ code: "removed_member_not_found" });
});
it("records nothing when a member leaves or the owner cannot be removed", async () => {
  await leaveOrganization({ organizationId: "org-a", userId: "learner" });
  await expect(removeOrganizationMember({ organizationId: "org-a", memberId: "owner-member", actorUserId: "owner" })).rejects.toMatchObject({ code: "cannot_remove_owner" });
  expect(await env.DB.prepare("SELECT user_id FROM organization_member_removals").first()).toBeNull();
});
it("signs out anyone with an identity at the organization's provider", async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO user (id, name, email) VALUES ('github-only', 'GitHub only', 'github.only@example.test')"),
    env.DB.prepare("INSERT INTO member (id, organization_id, user_id, role, created_at) VALUES ('github-only-member', 'org-a', 'github-only', 'member', 1)"),
    env.DB.prepare("INSERT INTO sso_provider (id, issuer, domain, oidc_config, user_id, provider_id, organization_id, domain_verified) VALUES ('org-a-idp-row', 'https://idp.a.test', 'a.test', '{}', 'owner', 'org-a-idp', 'org-a', 1)"),
    env.DB.prepare("INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ('learner-idp', 'learner-sub', 'org-a-idp', 'learner', 1, 1), ('other-idp', 'other-sub', 'org-a-idp', 'other', 1, 1), ('other-github', 'other-gh', 'github', 'other', 1, 1), ('github-only-github', 'github-only-gh', 'github', 'github-only', 1, 1)"),
    env.DB.prepare("INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at) VALUES ('learner-session', 'learner-token', 'learner', 9999999999999, 1, 1), ('other-session', 'other-token', 'other', 9999999999999, 1, 1), ('github-only-session', 'github-only-token', 'github-only', 9999999999999, 1, 1)"),
  ]);
  for (const memberId of ["learner-member", "other-member", "github-only-member"]) {
    await removeOrganizationMember({ organizationId: "org-a", memberId, actorUserId: "owner" });
  }
  // A session doesn't record which identity opened it, so the provider may
  // have opened one of someone who has GitHub too. It never opened one of
  // someone without an identity at it.
  const sessions = await env.DB.prepare("SELECT user_id FROM session ORDER BY user_id").all();
  expect(sessions.results).toEqual([{ user_id: "github-only" }]);
});
it("signs nobody out when the removal is refused", async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO sso_provider (id, issuer, domain, oidc_config, user_id, provider_id, organization_id, domain_verified) VALUES ('org-a-idp-row', 'https://idp.a.test', 'a.test', '{}', 'owner', 'org-a-idp', 'org-a', 1)"),
    env.DB.prepare("INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ('learner-idp', 'learner-sub', 'org-a-idp', 'learner', 1, 1)"),
    env.DB.prepare("INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at) VALUES ('learner-session', 'learner-token', 'learner', 9999999999999, 1, 1)"),
  ]);
  const batch = env.DB.batch.bind(env.DB);
  // The learner leaves while the removal runs.
  vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
    await env.DB.prepare("DELETE FROM member WHERE id = 'learner-member'").run();
    return batch(statements);
  });
  await expect(removeOrganizationMember({ organizationId: "org-a", memberId: "learner-member", actorUserId: "owner" })).rejects.toMatchObject({ code: "organization_membership_changed" });
  expect(await env.DB.prepare("SELECT expires_at FROM session WHERE id = 'learner-session'").first()).toEqual({ expires_at: 9999999999999 });
});
it("refuses to let an admin remove themselves, since a removal sticks", async () => {
  await env.DB.prepare("UPDATE member SET role = 'admin' WHERE id = 'other-member'").run();
  await expect(removeOrganizationMember({ organizationId: "org-a", memberId: "other-member", actorUserId: "other" })).rejects.toMatchObject({ code: "cannot_remove_self" });
  expect(await env.DB.prepare("SELECT id FROM member WHERE id = 'other-member'").first()).toEqual({ id: "other-member" });
  expect(await env.DB.prepare("SELECT user_id FROM organization_member_removals").first()).toBeNull();
});
it("never changes how a platform admin signs in", async () => {
  // Platform admins sign in with GitHub only, so their organization roles and
  // memberships don't affect it.
  await env.DB.batch([
    env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = 'learner'"),
    env.DB.prepare("UPDATE member SET role = 'admin' WHERE id = 'learner-member'"),
    env.DB.prepare("INSERT INTO sso_provider (id, issuer, domain, oidc_config, user_id, provider_id, organization_id, domain_verified) VALUES ('org-a-idp-row', 'https://idp.a.test', 'a.test', '{}', 'owner', 'org-a-idp', 'org-a', 1)"),
    env.DB.prepare("INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ('learner-idp', 'learner-sub', 'org-a-idp', 'learner', 1, 1), ('learner-github', 'learner-gh', 'github', 'learner', 1, 1)"),
    env.DB.prepare("INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at) VALUES ('learner-session', 'learner-token', 'learner', 9999999999999, 1, 1)"),
  ]);
  await updateOrganizationMemberRole({ organizationId: "org-a", memberId: "learner-member", actorUserId: "owner", role: "member" });
  await leaveOrganization({ organizationId: "org-a", userId: "learner" });
  expect(await env.DB.prepare("SELECT id FROM session WHERE id = 'learner-session'").first()).toEqual({ id: "learner-session" });
});
it("never signs out a platform admin an organization removes", async () => {
  await env.DB.batch([
    env.DB.prepare("UPDATE user SET role = 'admin' WHERE id = 'learner'"),
    env.DB.prepare("INSERT INTO sso_provider (id, issuer, domain, oidc_config, user_id, provider_id, organization_id, domain_verified) VALUES ('org-a-idp-row', 'https://idp.a.test', 'a.test', '{}', 'owner', 'org-a-idp', 'org-a', 1)"),
    env.DB.prepare("INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at) VALUES ('learner-idp', 'learner-sub', 'org-a-idp', 'learner', 1, 1), ('learner-github', 'learner-gh', 'github', 'learner', 1, 1)"),
    env.DB.prepare("INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at) VALUES ('learner-session', 'learner-token', 'learner', 9999999999999, 1, 1)"),
    env.DB.prepare("INSERT INTO session (id, token, user_id, impersonated_by, expires_at, created_at, updated_at) VALUES ('impersonation', 'impersonation-token', 'other', 'learner', 9999999999999, 1, 1)"),
  ]);
  await removeOrganizationMember({ organizationId: "org-a", memberId: "learner-member", actorUserId: "owner" });
  expect((await env.DB.prepare("SELECT id FROM session ORDER BY id").all()).results).toEqual([{ id: "impersonation" }, { id: "learner-session" }]);
  expect(await env.DB.prepare("SELECT user_id FROM organization_member_removals").first()).toEqual({ user_id: "learner" });
});
it("lets a platform admin restore someone without being a member", async () => {
  await env.DB.prepare("INSERT INTO user (id, name, email, role) VALUES ('platform-admin', 'Admin', 'admin@example.test', 'admin')").run();
  await removeOrganizationMember({ organizationId: "org-a", memberId: "learner-member", actorUserId: "owner" });
  await expect(restoreRemovedMemberAsPlatformAdmin({ organizationId: "org-a", userId: "learner", actorUserId: "other" })).rejects.toMatchObject({ code: "admin_required" });
  await restoreRemovedMemberAsPlatformAdmin({ organizationId: "org-a", userId: "learner", actorUserId: "platform-admin" });
  expect(await env.DB.prepare("SELECT user_id FROM organization_member_removals").first()).toBeNull();
  await expect(restoreRemovedMemberAsPlatformAdmin({ organizationId: "org-a", userId: "learner", actorUserId: "platform-admin" })).rejects.toMatchObject({ code: "removed_member_not_found" });
});
it("shows removed people to organization admins only", async () => {
  await removeOrganizationMember({ organizationId: "org-a", memberId: "learner-member", actorUserId: "owner" });
  const asOwner = await getOrganizationDetail({ organizationKey: "org-a", userId: "owner" });
  expect(asOwner.removedMembers).toMatchObject([{ userId: "learner", email: "learner@example.test" }]);
  const asMember = await getOrganizationDetail({ organizationKey: "org-a", userId: "other" });
  expect(asMember.removedMembers).toEqual([]);
});
