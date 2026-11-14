/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KINO_CONFIG_MEDIA_TYPE } from "@/control-plane/image-registry/push";
import { member, organization, user } from "@/db/schema";
import { jsonResponse } from "@/lib/agent-bridge";
import { setPublicPlay } from "@/lib/organization-entitlements";
import { ensureFixtureMember } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";
import {
  HINT_BODY, HOST, KINO, LEARNER, SOLUTION, STRANGER, TASK_BODY, connect, disconnect, enrollHost, machineImage, revisionDoc,
  seedScenario, specBlob, store,
} from "@/lib/scenario-runs/revision-test-fixtures";
import { GET as readPlay } from "@/pages/api/play/[namespace]/[slug]";
import { POST as start } from "@/pages/api/scenarios/[scenarioId]/start";

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/agent-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-bridge")>()),
  requireUserContext: mocks.auth,
}));

const signedOut = () => mocks.auth.mockResolvedValue({
  ok: false, response: jsonResponse({ error: "unauthorized", code: "signed_out" }, { status: 401 }),
});
const as = (userId: string) => mocks.auth.mockResolvedValue({
  ok: true,
  context: { userId, sessionId: "browser", role: "user", isAdmin: false, organizationIds: userId === STRANGER ? ["acme"] : [],
    activeOrganizationId: null },
});
const play = (namespace: string, slug: string) =>
  readPlay({ request: new Request(`https://intar.test/api/play/${namespace}/${slug}`), params: { namespace, slug } } as never);
const startPlay = (scenarioId: string, body: unknown, key = "play-key-1") => start({
  request: new Request(`https://intar.test/api/scenarios/${encodeURIComponent(scenarioId)}/start`, {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body),
  }),
  params: { scenarioId: encodeURIComponent(scenarioId) },
  locals: { cfContext: { waitUntil: () => undefined } },
} as never);

const CREDIT = "Based on a stream by Example Academy";
const SCRIPT_TEXT = "#!/bin/sh systemctl restart nginx";

describe("play pages", () => {
  let ws: WebSocket | undefined;

  beforeEach(async () => {
    await resetD1Database();
    const db = drizzle(env.DB);
    for (const id of [LEARNER, STRANGER]) {
      await db.insert(user).values({ id, name: id, email: `${id}@example.test`, metalPlacement: "personal" });
      await ensureFixtureMember({ d1: env.DB, userId: id });
    }
    await db.insert(user).values({ id: "operator", name: "operator", email: "operator@example.test", role: "admin" });
    await db.insert(organization).values({ id: "acme", name: "Acme", slug: "acme", createdAt: new Date() });
    await db.insert(member).values({ id: "m-acme", organizationId: "acme", userId: STRANGER, role: "member", createdAt: new Date() });
    expect(await store("application/vnd.intar.kino.v1", KINO_CONFIG_MEDIA_TYPE, { guest_contract: 3, version: "run-test" },
      [["application/octet-stream", "kino binary"]])).toBe(KINO);
    const images = { web: await machineImage("web"), client: await machineImage("client") };
    const specs = { web: await specBlob("web"), client: await specBlob("client") };
    const doc = { ...revisionDoc(images, specs), credit: CREDIT, tags: ["nginx"], play: true };
    doc.tasks[1] = { ...doc.tasks[1]!, body: SCRIPT_TEXT };
    for (const [id, organizationId] of [
      ["intar/web", null], ["intar/off", null], ["intar/private", null], ["intar/unlive", null],
      ["acme/web", "acme"],
    ] as const) {
      // The course catalog row of a scope goes in with its first scenario.
      await seedScenario(id, organizationId, doc).catch((error: unknown) => {
        if (!/course_catalogs/i.test(String((error as { cause?: unknown }).cause ?? error))) throw error;
      });
    }
    await env.DB.batch([
      env.DB.prepare("UPDATE scenarios SET play = 1 WHERE id IN ('intar/web', 'intar/off', 'intar/unlive', 'acme/web')"),
      env.DB.prepare("UPDATE scenarios SET enabled = 0 WHERE id = 'intar/off'"),
      env.DB.prepare("UPDATE scenarios SET live_rev = NULL WHERE id = 'intar/unlive'"),
    ]);
  });
  afterEach(async () => {
    if (ws) await disconnect(ws, HOST);
    ws = undefined;
  });

  it("shows a signed-out visitor only the public fields", async () => {
    signedOut();
    const response = await play("intar", "web");
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(JSON.parse(text)).toEqual({
      scenario: { id: "intar/web", title: "Web", summary: "Fix the web server", difficulty: "easy", minutes: 10, credit: CREDIT },
      signedIn: false,
    });
    for (const secret of [SOLUTION, HINT_BODY, TASK_BODY, SCRIPT_TEXT, "Fix it.", "sha256:", "nginx", '"serve"', '"fetch"', "machines", "hints", "tasks", "spec"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("adds the briefing and tags after sign-in, and nothing else", async () => {
    as(LEARNER);
    const text = await (await play("intar", "web")).text();
    expect(JSON.parse(text)).toEqual({
      scenario: { id: "intar/web", title: "Web", summary: "Fix the web server", difficulty: "easy", minutes: 10, credit: CREDIT,
        tags: ["nginx"], briefing: "Fix it." },
      signedIn: true,
    });
    for (const secret of [SOLUTION, HINT_BODY, TASK_BODY, SCRIPT_TEXT, "sha256:"]) expect(text).not.toContain(secret);
  });

  it("answers the same 404 for unknown, disabled, private, unlive and unentitled scenarios", async () => {
    const answers = new Set<string>();
    for (const signIn of [signedOut, () => as(STRANGER)]) {
      signIn();
      for (const [namespace, slug] of [
        ["intar", "missing"], ["intar", "off"], ["intar", "private"], ["intar", "unlive"], ["acme", "web"],
        ["INTAR", "web"], ["intar", "Web"], ["nobody", "web"], ["intar", "web/../x"],
      ] as const) {
        const response = await play(namespace, slug);
        expect(response.status, `${namespace}/${slug}`).toBe(404);
        answers.add(await response.text());
      }
    }
    expect([...answers]).toEqual([JSON.stringify({ error: "scenario not found", code: "scenario_not_found" })]);
  });

  it("opens an organization's play scenario only while it holds public play", async () => {
    signedOut();
    await setPublicPlay({ organizationId: "acme", actorUserId: "operator", granted: true });
    expect((await play("acme", "web")).status).toBe(200);
    await setPublicPlay({ organizationId: "acme", actorUserId: "operator", granted: false });
    expect((await play("acme", "web")).status).toBe(404);
  });

  it("starts a play run only signed in, with launch_source play and the ref", async () => {
    signedOut();
    expect((await startPlay("intar/web", { launchSource: "play" })).status).toBe(401);
    as(LEARNER);
    for (const ref of ["x".repeat(65), "", "has space", "a/b", 7, null]) {
      const refused = await startPlay("intar/web", { launchSource: "play", ref });
      expect(refused.status, String(ref)).toBe(400);
      expect(await refused.json()).toMatchObject({ code: "invalid_ref" });
    }
    expect((await startPlay("intar/web", { ref: "stream" })).status).toBe(400);
    expect((await startPlay("intar/web", { launchSource: "course" })).status).toBe(400);
    expect((await startPlay("intar/web", { launchSource: "play", organizationId: "acme" })).status).toBe(400);
    // Not open to play: the same refusal as an unknown scenario.
    for (const id of ["intar/private", "intar/off", "acme/web"]) {
      expect((await startPlay(id, { launchSource: "play" }, `k-${id}`)).status, id).toBe(404);
    }

    await enrollHost(HOST, LEARNER);
    ws = await connect(HOST);
    const accepted = await startPlay("intar/web", { launchSource: "play", ref: "stream-42" });
    expect(accepted.status).toBe(202);
    const { runId } = (await accepted.json()) as { runId: string };
    const row = await env.DB.prepare("SELECT launch_source, ref, course_id, organization_id, active_key FROM scenario_runs WHERE run_id = ?1")
      .bind(runId).first();
    expect(row).toEqual({ launch_source: "play", ref: "stream-42", course_id: null, organization_id: null, active_key: LEARNER });

    // It takes the learner's one active run like any other start.
    const second = await startPlay("intar/web", { launchSource: "play" }, "play-key-2");
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ code: "scenario_run_active_conflict" });
  });
});
