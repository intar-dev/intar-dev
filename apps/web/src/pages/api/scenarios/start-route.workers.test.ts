/// <reference types="@cloudflare/vitest-plugin/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KINO_CONFIG_MEDIA_TYPE } from "@/control-plane/image-registry/push";
import { user } from "@/db/schema";
import {
  HOST, KINO, LEARNER, connect, disconnect, enrollHost, machineImage, revisionDoc, seedScenario, specBlob, store,
} from "@/lib/scenario-runs/revision-test-fixtures";
import { POST as start } from "@/pages/api/scenarios/[namespace]/[slug]/start";
import { ensureFixtureMember } from "@/test/account-fixtures";
import { resetD1Database } from "@/test/d1-migrations";

const mocks = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/agent-bridge", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/agent-bridge")>()),
  requireUserContext: mocks.auth,
}));

const post = (body: unknown, key: string) => start({
  request: new Request("https://intar.test/api/scenarios/intar/web/start", {
    method: "POST", headers: { "content-type": "application/json", "idempotency-key": key }, body: JSON.stringify(body),
  }),
  params: { namespace: "intar", slug: "web" },
  locals: { cfContext: { waitUntil: () => undefined } },
} as never);
const runs = () => env.DB.prepare("SELECT launch_source, ref FROM scenario_runs").all();

describe("the start route", () => {
  let ws: WebSocket | undefined;

  beforeEach(async () => {
    await resetD1Database();
    await drizzle(env.DB).insert(user).values({ id: LEARNER, name: LEARNER, email: `${LEARNER}@example.test`, metalPlacement: "personal" });
    await ensureFixtureMember({ d1: env.DB, userId: LEARNER });
    expect(await store("application/vnd.intar.kino.v1", KINO_CONFIG_MEDIA_TYPE, { guest_contract: 3, version: "run-test" },
      [["application/octet-stream", "kino binary"]])).toBe(KINO);
    const images = { web: await machineImage("web"), client: await machineImage("client") };
    const specs = { web: await specBlob("web"), client: await specBlob("client") };
    await seedScenario("intar/web", null, revisionDoc(images, specs));
    await enrollHost(HOST, LEARNER);
    ws = await connect(HOST);
    mocks.auth.mockResolvedValue({
      ok: true,
      context: { userId: LEARNER, sessionId: "browser", role: "user", isAdmin: false, organizationIds: [], activeOrganizationId: null },
    });
  });
  afterEach(async () => {
    if (ws) await disconnect(ws, HOST);
    ws = undefined;
  });

  it("refuses a play start, as an old play page still sends it, and creates no run", async () => {
    for (const [index, body] of [
      { launchSource: "play" }, { launchSource: "play", ref: "stream-42" }, { ref: "stream-42" }, { launchSource: "course" },
    ].entries()) {
      const refused = await post(body, `play-key-${index}`);
      expect(refused.status, JSON.stringify(body)).toBe(400);
      expect(await refused.json()).toMatchObject({ code: "invalid_launch_source" });
    }
    expect((await runs()).results).toEqual([]);

    // The same scenario still starts from its course.
    expect((await post({}, "course-key")).status).toBe(202);
    expect((await runs()).results).toEqual([{ launch_source: "course", ref: null }]);
  });
});
