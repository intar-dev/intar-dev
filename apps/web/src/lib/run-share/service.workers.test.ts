import { env } from "cloudflare:workers";
import type { APIContext } from "astro";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetHostRuntimeTestDatabase,
  seedHost,
  seedRun,
} from "@/control-plane/host-runtime-do/test-fixtures";
import { StaticFeatureToggleService } from "@/lib/feature-toggles";
import { parseShareViewerFrame } from "@/lib/run-share/protocol";
import {
  disableRunShare,
  enableRunShare,
  handleShareIngest,
  isShareWatchable,
  RUN_SHARING_FLAG,
  runShareStub,
  stopRunSharesForUser,
} from "@/lib/run-share/service";
import { GET as watchRoute } from "@/pages/api/shares/stream";
import { revokeFixtureAccount } from "@/test/account-fixtures";

const on = new StaticFeatureToggleService({ [RUN_SHARING_FLAG]: true });
const owner = { runId: "run-1", userId: "user-1", toggles: on };

async function shareIdOf(runId: string): Promise<string | null> {
  const row = await env.DB.prepare(
    "SELECT share_id FROM scenario_runs WHERE run_id = ?1",
  )
    .bind(runId)
    .first<{ share_id: string | null }>();
  return row?.share_id ?? null;
}

async function watch(shareId: string) {
  const response = await runShareStub(shareId).fetch(
    "https://run-share.internal/watch",
    { headers: { upgrade: "websocket", "x-share-viewer-network": "c".repeat(24) } },
  );
  const ws = response.webSocket;
  if (!ws) return { status: response.status, frames: [] as string[] };
  const frames: string[] = [];
  ws.accept();
  ws.addEventListener("message", (event) => {
    frames.push(String(event.data));
  });
  return { status: response.status, frames };
}

function watchRequest(shareId: string, ip = "198.51.100.7") {
  return watchRoute({
    request: new Request(`http://localhost/api/shares/stream?s=${shareId}`, {
      headers: { upgrade: "websocket", "cf-connecting-ip": ip },
    }),
  } as unknown as APIContext);
}

describe("run sharing", () => {
  beforeEach(async () => {
    await resetHostRuntimeTestDatabase();
    await seedHost("host-1");
    await seedRun({
      db: drizzle(env.DB),
      hostId: "host-1",
      runId: "run-1",
      now: Date.now(),
    });
  });

  it("stays off until the flag allows it", async () => {
    await expect(
      enableRunShare({ runId: "run-1", userId: "user-1" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(await shareIdOf("run-1")).toBeNull();
  });

  it("only lets the owner share an active run", async () => {
    await expect(
      enableRunShare({ ...owner, userId: "someone-else" }),
    ).rejects.toMatchObject({ status: 404 });
    await env.DB.prepare("UPDATE scenario_runs SET active_key = NULL").run();
    await expect(enableRunShare(owner)).rejects.toMatchObject({ status: 409 });
  });

  it("publishes the mission once and returns the same link again", async () => {
    const url = await enableRunShare(owner);
    const shareId = await shareIdOf("run-1");
    expect(shareId).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(url).toBe(`http://localhost/watch#${shareId}`);
    expect(await enableRunShare(owner)).toBe(url);

    const viewer = await watch(shareId!);
    expect(viewer.status).toBe(101);
    await vi.waitFor(() => expect(viewer.frames.length).toBe(1));
    const [hello] = parseShareViewerFrame(viewer.frames[0]!);
    expect(hello).toEqual({
      type: "hello",
      truncated: false,
      mission: {
        title: "Broken Nginx",
        tagline: "",
        scenario_name: "broken-nginx",
        lecture_title: null,
        markdown: "",
        objectives: [],
        vms: [{ id: "vm-1", name: "webserver" }],
      },
    });
  });

  it("closes the link when the owner's account is revoked", async () => {
    await enableRunShare(owner);
    const shareId = (await shareIdOf("run-1"))!;
    expect(await isShareWatchable(shareId)).toBe(true);
    expect((await watchRequest(shareId)).status).toBe(101);

    await revokeFixtureAccount({ d1: env.DB, userId: "user-1" });
    expect(await isShareWatchable(shareId)).toBe(false);
    expect((await watchRequest(shareId)).status).toBe(404);
  });

  it("lets Stargate write only to a share its run still points at", async () => {
    const ingest = (shareId: string) =>
      handleShareIngest(
        new Request(`http://localhost/share-ingest?s=${shareId}`, {
          headers: {
            upgrade: "websocket",
            authorization: "Bearer bm90LXRoZS1yaWdodC10b2tlbi1hdC1hbGwtcmVhbGx5eA",
          },
        }),
      );
    expect((await ingest("Zm9vYmFyYmF6cXV4cXV1eA")).status).toBe(404);

    await enableRunShare(owner);
    const shareId = (await shareIdOf("run-1"))!;
    // The gate lets it through to the share, which refuses the wrong token.
    expect((await ingest(shareId)).status).toBe(401);

    await revokeFixtureAccount({ d1: env.DB, userId: "user-1" });
    expect((await ingest(shareId)).status).toBe(404);
  });

  it("answers 404 for an unknown or malformed share", async () => {
    expect((await watchRequest("Zm9vYmFyYmF6cXV4cXV1eA")).status).toBe(404);
    expect((await watchRequest("../../etc")).status).toBe(404);
  });

  it("wipes the share before forgetting it", async () => {
    await enableRunShare(owner);
    const shareId = (await shareIdOf("run-1"))!;
    await disableRunShare(owner);
    expect(await shareIdOf("run-1")).toBeNull();
    expect((await watch(shareId)).status).toBe(404);
    // Sharing again mints a new link; the old one stays dead.
    await enableRunShare(owner);
    expect(await shareIdOf("run-1")).not.toBe(shareId);
  });

  it("stops every share of a revoked user, finished runs included", async () => {
    await enableRunShare(owner);
    const shareId = (await shareIdOf("run-1"))!;
    await env.DB.prepare("UPDATE scenario_runs SET active_key = NULL").run();

    await stopRunSharesForUser("user-1");
    expect(await shareIdOf("run-1")).toBeNull();
    expect((await watch(shareId)).status).toBe(404);
  });
});
