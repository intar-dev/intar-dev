/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { courseCatalogs, organization, vmScenarios } from "@/db/schema";
import { hardenWorkerResponse } from "@/lib/response-security";
import { resetD1Database } from "@/test/d1-migrations";

const session = vi.hoisted(() => ({ signedIn: false }));

vi.mock("@/lib/agent-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/agent-bridge")>();
  return {
    ...actual,
    requireUserContext: async () =>
      session.signedIn
        ? { ok: true, context: { userId: "play-user", isAdmin: false } }
        : { ok: false, response: new Response(null, { status: 401 }) },
  };
});

import { GET } from "./[slug]";

const TEASER_KEYS = ["available", "credit", "difficulty", "minutes", "summary", "title"];

describe("GET /api/play/:namespace/:slug", () => {
  beforeEach(async () => {
    await resetD1Database();
    session.signedIn = false;
    await seedPlayable();
  });

  it("returns only the teaser to a signed-out visitor, cacheable", async () => {
    const response = await get("intar", "repair-nginx");
    expect(response.status).toBe(200);
    const body = (await response.clone().json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(TEASER_KEYS);
    expect(body).toEqual({
      title: "Repair nginx",
      summary: "Bring the web server back.",
      difficulty: "easy",
      minutes: 25,
      credit: null,
      available: true,
    });
    // The Worker's hardening keeps the public policy for this teaser only.
    const hardened = hardenWorkerResponse(
      new Request("https://intar.dev/api/play/intar/repair-nginx"),
      response,
      { BETTER_AUTH_URL: "https://intar.dev" } as Pick<Cloudflare.Env, "BETTER_AUTH_URL">,
    );
    expect(hardened.headers.get("cache-control")).toBe("public, max-age=60");
    expect(hardened.headers.get("vary")).toBe("Cookie");
  });

  it("adds the briefing for a session and is private, never hints or solution", async () => {
    session.signedIn = true;
    const response = await get("intar", "repair-nginx");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual([...TEASER_KEYS, "briefing_markdown"].sort());
    expect(body.briefing_markdown).toBe("# Theory\n\nThe lecture body.");
    for (const secret of ["SECRET-HINT", "SECRET-SOLUTION", "SCENARIO-BRIEFING"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("reports runs held during a drain as unavailable", async () => {
    await env.DB.prepare(
      "INSERT INTO runtime_operation_gates (key, state, updated_at) VALUES ('image_cutover', 'drained', 1)",
    ).run();
    const body = (await (await get("intar", "repair-nginx")).json()) as { available: boolean };
    expect(body.available).toBe(false);
  });

  it.each([
    ["another namespace", "rawkode-academy", "repair-nginx", ""],
    ["an unsafe slug", "intar", "..", ""],
    ["an unknown scenario", "intar", "missing", ""],
    ["a scenario no public lecture links", "intar", "unlinked", ""],
    ["a disabled scenario", "intar", "repair-nginx", "UPDATE vm_scenarios SET enabled = 0"],
    ["an unpublished scenario", "intar", "repair-nginx", "UPDATE vm_scenarios SET enabled_at = NULL"],
    ["an organization scenario", "intar", "org-only", ""],
  ])("returns 404 for %s, signed in or out", async (_name, namespace, slug, sql) => {
    if (sql) await env.DB.prepare(sql).run();
    for (const signedIn of [false, true]) {
      session.signedIn = signedIn;
      const response = await get(namespace, slug);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "scenario not found", code: "play_not_found" });
    }
  });
});

function get(namespace: string, slug: string): Promise<Response> {
  const request = new Request(
    `https://intar.dev/api/play/${namespace}/${slug}`,
  );
  return GET({ request, params: { namespace, slug } } as never) as Promise<Response>;
}

async function seedPlayable(): Promise<void> {
  const db = drizzle(env.DB);
  const now = Date.now();
  await db.insert(organization).values({
    id: "play-org",
    name: "Play org",
    slug: "play-org",
    createdAt: new Date(now),
  });
  const scenario = (scenarioId: string, organizationId: string | null) => ({
    scenarioId,
    organizationId,
    title: "Scenario title",
    description: "Scenario description",
    difficulty: "medium",
    estimatedMinutes: 60,
    tagsJson: [],
    hintsJson: [{ id: "h1", title: "Hint", bodyMarkdown: "SECRET-HINT" }] as never,
    briefingMarkdown: "SCENARIO-BRIEFING",
    solutionMarkdown: "SECRET-SOLUTION",
    enabled: true,
    enabledAt: now,
  });
  await db.insert(vmScenarios).values([
    scenario("repair-nginx", null),
    scenario("unlinked", null),
    scenario("org-only", "play-org"),
  ]);
  const lecture = (lectureId: string, scenarioId?: string) => ({
    lectureId,
    title: "Repair nginx",
    summary: "Bring the web server back.",
    bodyMarkdown: "# Theory\n\nThe lecture body.",
    category: "linux",
    tags: [],
    difficulty: "easy" as const,
    estimatedMinutes: 25,
    ...(scenarioId ? { scenarioId } : {}),
  });
  await db.insert(courseCatalogs).values([
    {
      scopeKey: "public",
      organizationId: null,
      sourceRevision: "play-fixture",
      catalogJson: {
        version: 2,
        courses: [{
          courseId: "linux",
          title: "Linux",
          summary: "Linux",
          bodyMarkdown: "Linux",
          sequential: false,
          lectures: [lecture("01-nginx", "repair-nginx"), lecture("02-theory")],
        }],
      },
    },
    {
      scopeKey: "organization:play-org",
      organizationId: "play-org",
      sourceRevision: "play-fixture",
      catalogJson: {
        version: 2,
        courses: [{
          courseId: "private",
          title: "Private",
          summary: "Private",
          bodyMarkdown: "Private",
          sequential: false,
          lectures: [lecture("01-org", "org-only")],
        }],
      },
    },
  ]);
}
