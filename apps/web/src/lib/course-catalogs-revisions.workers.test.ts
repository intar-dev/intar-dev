/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { courseCatalogs, member, organization, user } from "@/db/schema";
import { listCourseCatalogForUser, loadCourseLectureDetailForUser } from "@/lib/course-catalogs";
import { resetD1Database } from "@/test/d1-migrations";

const lecture = (lectureId: string, scenarioId?: string) => ({
  lectureId, ...(scenarioId ? { scenarioId } : {}), title: lectureId, summary: "", bodyMarkdown: `Body of ${lectureId}`, category: "test", tags: [],
  estimatedMinutes: 10,
});
const catalog = (courseId: string, lectures: ReturnType<typeof lecture>[]) => ({
  version: 2 as const,
  courses: [{ courseId, title: courseId, summary: "", bodyMarkdown: "", sequential: false, lectures }],
});

async function scenario(id: string, organizationId: string | null, state: "ready" | "building" | null) {
  const [namespace, slug] = id.split("/");
  await env.DB.prepare(`INSERT INTO scenarios (id, namespace, slug, organization_id, scope_key, enabled, play, live_rev)
    VALUES (?1, ?2, ?3, ?4, ?5, 1, 0, ?6)`)
    .bind(id, namespace, slug, organizationId, organizationId ? `organization:${organizationId}` : "public", state ? "r1" : null).run();
  if (state) {
    await env.DB.prepare(`INSERT INTO scenario_revisions (scenario_id, rev, guest_contract, doc_json, state) VALUES (?1, 'r1', 3, '{}', ?2)`)
      .bind(id, state).run();
  }
}

describe("course catalogs on scenario revisions", () => {
  beforeEach(async () => {
    await resetD1Database();
    const db = drizzle(env.DB);
    await db.insert(user).values(["member", "outsider"].map((id) => ({ id, name: id, email: `${id}@example.test` })));
    await db.insert(organization).values({ id: "acme", name: "Acme", slug: "acme", createdAt: new Date() });
    await db.insert(member).values({ id: "m", organizationId: "acme", userId: "member", role: "member", createdAt: new Date() });
    await scenario("intar/ready", null, "ready");
    await scenario("intar/building", null, "building");
    await scenario("intar/unlive", null, null);
    await scenario("acme/private", "acme", "ready");
    await db.insert(courseCatalogs).values([
      { scopeKey: "public", organizationId: null, sourceRevision: "t",
        catalogJson: catalog("public-course", [
          lecture("ready", "intar/ready"), lecture("building", "intar/building"), lecture("unlive", "intar/unlive"),
          lecture("missing", "intar/missing"), lecture("theory"),
        ]) },
      { scopeKey: "organization:acme", organizationId: "acme", sourceRevision: "t",
        catalogJson: catalog("acme-course", [lecture("private", "acme/private")]) },
    ]);
  });

  const states = async (userId: string) => {
    const { courses } = await listCourseCatalogForUser({ db: drizzle(env.DB), userId, organizationId: null });
    return Object.fromEntries(courses.map((course) => [course.courseId,
      Object.fromEntries(course.lectures.map((entry) => [entry.lectureId, entry.state]))]));
  };

  it("marks a lecture ready only while its scenario has a startable live revision", async () => {
    expect((await states("outsider"))["public-course"]).toEqual({
      ready: "available", building: "waiting_for_scenario", unlive: "waiting_for_scenario", missing: "waiting_for_scenario",
      theory: "available",
    });
  });

  it("shows an organization's private course to its members and to nobody else", async () => {
    expect(Object.keys(await states("member")).sort()).toEqual(["acme-course", "public-course"]);
    expect((await states("member"))["acme-course"]).toEqual({ private: "available" });
    expect(Object.keys(await states("outsider"))).toEqual(["public-course"]);

    const detail = (userId: string) => loadCourseLectureDetailForUser({
      db: drizzle(env.DB), userId, organizationId: "acme", courseId: "acme-course", lectureId: "private", courseScope: "private",
    });
    await expect(detail("member")).resolves.toMatchObject({ ok: true, detail: { lecture: { scenarioId: "acme/private", state: "available" } } });
    await expect(detail("outsider")).rejects.toMatchObject({ status: 404, code: "course_not_found" });
  });

  it("keeps a lecture waiting while its scenario is disabled", async () => {
    await env.DB.prepare("UPDATE scenarios SET enabled = 0 WHERE id = 'intar/ready'").run();
    expect((await states("outsider"))["public-course"]?.ready).toBe("waiting_for_scenario");
  });
});
