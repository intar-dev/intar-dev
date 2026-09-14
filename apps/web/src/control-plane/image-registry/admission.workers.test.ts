import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetD1Database } from "@/test/d1-migrations";
import { handleImageRegistryRequest } from "@/control-plane/image-registry";
import {
  REGISTRY_ADMISSION_KEY,
  REGISTRY_CLOSED_SESSION_RETAIN_MS,
  REGISTRY_SESSION_HEADER,
  acquireRegistrySweep,
  admitRegistryOperation,
  assertRegistrySweepDeletable,
  compactRegistryAdmissionHistory,
  completeRegistryUploadSession,
  createRegistryUploadSession,
  finishRegistrySweep,
  readRegistryAdmissionState,
  readRegistryIdleState,
  reapRegistryAdmission,
  recordRegistryGcProgress,
  setRegistryEnforcement,
  setRegistryPause,
} from "@/lib/image-registry-admission";

const PUBLISH_TOKEN = "test-publish-token";

describe("image registry admission", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("refuses a sweep while an upload session is open", async () => {
    const session = await createRegistryUploadSession(env, {
      owner: { kind: "publish_token", id: "publish-token" },
      intent: "image_publish",
    });
    expect(session.ok).toBe(true);

    const blocked = await acquireRegistrySweep(env, { owner: "collector-a" });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("sweep must not start next to a session");
    expect(blocked.code).toBe("registry_admission_busy");
    expect(blocked.counts.openSessions).toBe(1);

    if (session.ok) {
      await completeRegistryUploadSession(env, {
        owner: { kind: "publish_token", id: "publish-token" },
        sessionId: session.sessionId,
        outcome: "abandoned",
      });
    }
    const acquired = await acquireRegistrySweep(env, { owner: "collector-a" });
    expect(acquired.ok).toBe(true);
  });

  it("refuses a sweep while a writer is unresolved", async () => {
    const admitted = await admitRegistryOperation(
      writeRequest(),
      env,
      { operation: "chunk_put" },
    );
    expect(admitted.ok).toBe(true);

    const blocked = await acquireRegistrySweep(env, { owner: "collector-a" });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("sweep must not start next to a writer");
    expect(blocked.code).toBe("registry_admission_busy");

    if (admitted.ok) await admitted.lease.complete("ok");
    const acquired = await acquireRegistrySweep(env, { owner: "collector-a" });
    expect(acquired.ok).toBe(true);
  });

  it("rejects writers while a sweep holds the gate", async () => {
    const acquired = await acquireRegistrySweep(env, { owner: "collector-a" });
    expect(acquired.ok).toBe(true);

    const denied = await admitRegistryOperation(
      writeRequest(),
      env,
      { operation: "chunk_put" },
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("a writer must not enter during a sweep");
    expect(denied.response.status).toBe(409);
    await expect(denied.response.json()).resolves.toMatchObject({
      code: "registry_sweep_in_progress",
    });
  });

  it("keeps a stalled sweep held and only an operator resolves it", async () => {
    const acquired = await acquireRegistrySweep(env, { owner: "collector-a" });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    // The collector stops heartbeating, as a paused in-flight delete loop would.
    await expireSweepHeartbeat();

    const takeover = await acquireRegistrySweep(env, { owner: "collector-b" });
    expect(takeover.ok).toBe(false);
    if (takeover.ok) throw new Error("an expired lease is not release authority");
    expect(takeover.code).toBe("registry_sweep_active");
    expect(takeover.state.sweep.stalled).toBe(true);

    // The old collector must also stop deleting instead of trusting its timer.
    const staleDelete = await assertRegistrySweepDeletable(env, {
      sweepToken: acquired.lease.sweepToken,
      objectKeys: ["images/broken-nginx-web-x86_64/aaaa.raw.zst"],
    });
    expect(staleDelete.ok).toBe(false);
    if (staleDelete.ok) throw new Error("a stalled sweep must not delete");
    expect(staleDelete.code).toBe("registry_sweep_stalled");

    // No writer may slip in while the gate is held by an unresolved sweep.
    const denied = await admitRegistryOperation(
      writeRequest(),
      env,
      { operation: "chunk_put" },
    );
    expect(denied.ok).toBe(false);

    const idle = await readRegistryIdleState(env);
    expect(idle.idle).toBe(false);
    expect(idle.sweepStalled).toBe(true);

    const reaped = await reapRegistryAdmission(env, {
      graceMs: 0,
      resolveStalledSweeps: true,
    });
    expect(reaped.resolvedSweeps).toEqual([acquired.lease.sweepToken]);

    const afterReap = await readRegistryAdmissionState(env);
    expect(afterReap.sweep.active).toBe(false);
    const reacquired = await acquireRegistrySweep(env, { owner: "collector-b" });
    expect(reacquired.ok).toBe(true);
  });

  it("requires a session header once enforcement is on", async () => {
    await setRegistryEnforcement(env, "enforce");

    const denied = await admitRegistryOperation(
      writeRequest(),
      env,
      { operation: "chunk_put" },
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("enforce mode must require a session");
    expect(denied.response.status).toBe(400);
    await expect(denied.response.json()).resolves.toMatchObject({
      code: "registry_session_required",
    });

    const session = await createRegistryUploadSession(env, {
      owner: { kind: "publish_token", id: "publish-token" },
    });
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    const admitted = await admitRegistryOperation(
      writeRequest(session.sessionId),
      env,
      { operation: "chunk_put" },
    );
    expect(admitted.ok).toBe(true);
  });

  it("holds every isolate when the registry is paused", async () => {
    await setRegistryPause(env, { paused: true, reason: "deploy" });

    const idle = await readRegistryIdleState(env);
    expect(idle.paused).toBe(true);
    expect(idle.idle).toBe(false);

    const denied = await admitRegistryOperation(
      writeRequest(),
      env,
      { operation: "chunk_put" },
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("a paused registry must not admit writes");
    await expect(denied.response.json()).resolves.toMatchObject({
      code: "registry_paused",
    });

    const sweep = await acquireRegistrySweep(env, { owner: "collector-a" });
    expect(sweep.ok).toBe(false);

    await setRegistryPause(env, { paused: false });
    const resumed = await readRegistryIdleState(env);
    expect(resumed.paused).toBe(false);
    expect(resumed.idle).toBe(true);
  });

  it("keeps gc counters monotonic across a retried report", async () => {
    const acquired = await acquireRegistrySweep(env, { owner: "collector-a" });
    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;

    await recordRegistryGcProgress(env, {
      sweepToken: acquired.lease.sweepToken,
      counters: { scannedObjects: 10, deletedObjects: 4, bytesReclaimed: 4096 },
    });
    await recordRegistryGcProgress(env, {
      sweepToken: acquired.lease.sweepToken,
      counters: { scannedObjects: 12, deletedObjects: 5, bytesReclaimed: 5120 },
    });
    await finishRegistrySweep(env, {
      sweepToken: acquired.lease.sweepToken,
      outcome: "completed",
      counters: { scannedObjects: 12, deletedObjects: 6, bytesReclaimed: 6144 },
    });

    const run = await env.DB.prepare(
      `SELECT state, scanned_objects, deleted_objects, bytes_reclaimed
         FROM image_registry_gc_runs WHERE sweep_token = ?1`,
    )
      .bind(acquired.lease.sweepToken)
      .first<{
        state: string;
        scanned_objects: number;
        deleted_objects: number;
        bytes_reclaimed: number;
      }>();
    expect(run).toMatchObject({
      state: "completed",
      scanned_objects: 12,
      deleted_objects: 6,
      bytes_reclaimed: 6144,
    });

    const state = await readRegistryAdmissionState(env);
    expect(state.sweep.active).toBe(false);
  });

  it("treats a closed session as superseded for its own uploader", async () => {
    const session = await createRegistryUploadSession(env, {
      owner: { kind: "publish_token", id: "publish-token" },
    });
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    await completeRegistryUploadSession(env, {
      owner: { kind: "publish_token", id: "publish-token" },
      sessionId: session.sessionId,
      outcome: "abandoned",
    });

    const denied = await admitRegistryOperation(
      writeRequest(session.sessionId),
      env,
      { operation: "chunk_put" },
    );
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error("a closed session must not admit writes");
    await expect(denied.response.json()).resolves.toMatchObject({
      code: "registry_session_closed",
    });
  });

  it("admits operator pointer work without an upload session", async () => {
    // Forcing an operator promotion or rollback to open an upload session would
    // make the collector unreachable while that request runs, so operator
    // operations are admitted session-less even in enforce mode.
    await setRegistryEnforcement(env, "enforce");

    const pointer = await admitRegistryOperation(
      writeRequest(),
      env,
      { operation: "pointer_mutation" },
    );
    expect(pointer.ok).toBe(true);
    if (!pointer.ok) return;
    expect(pointer.lease.sessionId).toBeNull();
    await pointer.lease.complete("ok");

    const guestTools = await admitRegistryOperation(
      writeRequest(),
      env,
      { operation: "guest_tools" },
    );
    expect(guestTools.ok).toBe(true);
    if (guestTools.ok) await guestTools.lease.complete("ok");

    // The object-creating upload path still demands a session.
    const upload = await admitRegistryOperation(
      writeRequest(),
      env,
      { operation: "chunk_put" },
    );
    expect(upload.ok).toBe(false);
  });

  it("leaves bounded coordination rows after a finished large upload", async () => {
    // A large upload is hundreds of chunk writes plus a manifest and a publish.
    // Each settled write deletes its own marker row, so D1 does not inherit the
    // growth that the chunk-upload path was moved to R2 to avoid.
    const session = await createRegistryUploadSession(env, {
      owner: { kind: "publish_token", id: "publish-token" },
      intent: "image_publish",
    });
    expect(session.ok).toBe(true);
    if (!session.ok) return;

    const chunkWrites = 40;
    for (let index = 0; index < chunkWrites; index += 1) {
      const admitted = await admitRegistryOperation(
        writeRequest(session.sessionId),
        env,
        { operation: "chunk_put" },
      );
      expect(admitted.ok).toBe(true);
      if (!admitted.ok) return;
      await admitted.lease.complete("ok");
    }
    const manifest = await admitRegistryOperation(
      writeRequest(session.sessionId),
      env,
      { operation: "manifest_put" },
    );
    expect(manifest.ok).toBe(true);
    if (manifest.ok) await manifest.lease.complete("ok");

    expect(await writerRowIds()).toEqual([]);

    const closed = await completeRegistryUploadSession(env, {
      owner: { kind: "publish_token", id: "publish-token" },
      sessionId: session.sessionId,
      outcome: "published",
    });
    expect(closed.ok).toBe(true);

    // One closed session stays for the retention window so a repeated complete
    // still answers, and the sweep is free immediately.
    expect(await sessionRowCount()).toBe(1);
    expect(await writerRowIds()).toEqual([]);
    const idle = await readRegistryIdleState(env);
    expect(idle.idle).toBe(true);

    // An aged closed session is compacted away by the next close.
    await env.DB.prepare(
      "UPDATE image_registry_upload_sessions SET closed_at = closed_at - ?1",
    )
      .bind(REGISTRY_CLOSED_SESSION_RETAIN_MS + 60_000)
      .run();
    const second = await createRegistryUploadSession(env, {
      owner: { kind: "publish_token", id: "publish-token" },
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    await completeRegistryUploadSession(env, {
      owner: { kind: "publish_token", id: "publish-token" },
      sessionId: second.sessionId,
      outcome: "abandoned",
    });
    expect(await sessionRowCount()).toBe(1);
  });

  it("keeps an inconclusive write blocking until an operator resolves it", async () => {
    const session = await createRegistryUploadSession(env, {
      owner: { kind: "publish_token", id: "publish-token" },
    });
    expect(session.ok).toBe(true);
    if (!session.ok) return;

    const admitted = await admitRegistryOperation(
      writeRequest(session.sessionId),
      env,
      { operation: "chunk_put" },
    );
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    // The handler threw after it may have written the object.
    await admitted.lease.complete("unknown");

    expect(await writerRowIds()).toEqual([admitted.lease.operationId]);

    // The session closes normally; the inconclusive write is what still blocks.
    await completeRegistryUploadSession(env, {
      owner: { kind: "publish_token", id: "publish-token" },
      sessionId: session.sessionId,
      outcome: "abandoned",
    });
    const idle = await readRegistryIdleState(env);
    expect(idle.idle).toBe(false);
    expect(idle.blockedReason).toBe("registry_write_unresolved");

    const blocked = await acquireRegistrySweep(env, { owner: "collector-a" });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("an unknown write must block the sweep");
    expect(blocked.code).toBe("registry_admission_busy");

    // Nothing on a timer clears it: not the session close above, not compaction.
    await compactRegistryAdmissionHistory(env, { retainClosedSessionsMs: 0 });
    expect(await writerRowIds()).toEqual([admitted.lease.operationId]);

    const reaped = await reapRegistryAdmission(env, { graceMs: 0 });
    expect(reaped.reapedWriters).toEqual([admitted.lease.operationId]);
    expect(await writerRowIds()).toEqual([]);
    expect((await readRegistryIdleState(env)).idle).toBe(true);
  });

  it("requires a valid owned open session on the publish route", async () => {
    // The route must judge the session itself, not the presence of the header.
    await setRegistryEnforcement(env, "enforce");

    const withoutSession = await publishRequest();
    expect(withoutSession.status).toBe(400);
    await expect(withoutSession.json()).resolves.toMatchObject({
      code: "registry_session_required",
    });

    const unknown = await publishRequest("not-a-session");
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toMatchObject({
      code: "registry_session_unknown",
    });

    // A session that belongs to another credential is not this caller's session.
    const foreign = await createRegistryUploadSession(env, {
      owner: { kind: "builder", id: "builder-other" },
    });
    expect(foreign.ok).toBe(true);
    if (!foreign.ok) return;
    const borrowed = await publishRequest(foreign.sessionId);
    expect(borrowed.status).toBe(403);
    await expect(borrowed.json()).resolves.toMatchObject({
      code: "registry_session_owner_mismatch",
    });

    const expiring = await createRegistryUploadSession(env, {
      owner: { kind: "publish_token", id: "publish-token" },
    });
    expect(expiring.ok).toBe(true);
    if (!expiring.ok) return;
    await env.DB.prepare(
      "UPDATE image_registry_upload_sessions SET expires_at = ?1 WHERE id = ?2",
    )
      .bind(Date.now() - 1, expiring.sessionId)
      .run();
    const expired = await publishRequest(expiring.sessionId);
    expect(expired.status).toBe(409);
    await expect(expired.json()).resolves.toMatchObject({
      code: "registry_session_superseded",
    });

    const abandoned = await createRegistryUploadSession(env, {
      owner: { kind: "publish_token", id: "publish-token" },
    });
    expect(abandoned.ok).toBe(true);
    if (!abandoned.ok) return;
    await completeRegistryUploadSession(env, {
      owner: { kind: "publish_token", id: "publish-token" },
      sessionId: abandoned.sessionId,
      outcome: "abandoned",
    });
    const closed = await publishRequest(abandoned.sessionId);
    expect(closed.status).toBe(409);
    await expect(closed.json()).resolves.toMatchObject({
      code: "registry_session_closed",
    });

    // An owned open session passes admission and reaches the handler, which
    // then rejects this session-less request for its own reason. That proves the
    // route admitted it on the session and not on the header.
    const open = await createRegistryUploadSession(env, {
      owner: { kind: "publish_token", id: "publish-token" },
    });
    expect(open.ok).toBe(true);
    if (!open.ok) return;
    const reached = await publishRequest(open.sessionId);
    expect(reached.status).toBe(400);
    await expect(reached.json()).resolves.toMatchObject({
      error: "multipart form data is required",
    });
  });

  it("refuses a token publish on the live route while a sweep holds the gate", async () => {
    // The live route is what matters: a raw handler call proves nothing about the
    // router. A sweep can only start when no session is open, so during a sweep a
    // client cannot obtain one, and the route must still refuse the token.
    const sweep = await acquireRegistrySweep(env, { owner: "collector-a" });
    expect(sweep.ok).toBe(true);

    const withoutSession = await publishRequest();
    expect(withoutSession.status).toBe(409);
    await expect(withoutSession.json()).resolves.toMatchObject({
      code: "registry_sweep_in_progress",
    });

    // A header value is not protection either: a stale session id gets the same
    // refusal, because the sweep outranks whatever the request carries.
    const withStaleSession = await publishRequest("stale-session-id");
    expect(withStaleSession.status).toBe(409);
    await expect(withStaleSession.json()).resolves.toMatchObject({
      code: "registry_sweep_in_progress",
    });

    // Neither refusal left a writer row behind.
    expect(await writerRowIds()).toEqual([]);

    if (!sweep.ok) return;
    await finishRegistrySweep(env, {
      sweepToken: sweep.lease.sweepToken,
      outcome: "completed",
    });

    // With the sweep finished, a session-carrying publish is admitted again and
    // reaches the handler, which rejects the empty body for its own reason. That
    // is the proof the route judges admission rather than the request path.
    const session = await createRegistryUploadSession(env, {
      owner: { kind: "publish_token", id: "publish-token" },
      intent: "image_publish",
    });
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    const afterSweep = await publishRequest(session.sessionId);
    expect(afterSweep.status).toBe(400);
    await expect(afterSweep.json()).resolves.toMatchObject({
      error: "multipart form data is required",
    });
  });

  it("keeps a publish write protected while its own session closes", async () => {
    // This is the state a publish is in while it writes: the handler takes this
    // lease before it stores the first object.
    const session = await createRegistryUploadSession(env, {
      owner: { kind: "publish_token", id: "publish-token" },
    });
    expect(session.ok).toBe(true);
    if (!session.ok) return;
    const admitted = await admitRegistryOperation(
      writeRequest(session.sessionId),
      env,
      { operation: "publish" },
    );
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;

    // The uploader closes the session, and the enforcement mode changes, while
    // the publish is still writing. Neither may expose the registry.
    await completeRegistryUploadSession(env, {
      owner: { kind: "publish_token", id: "publish-token" },
      sessionId: session.sessionId,
      outcome: "published",
    });
    await setRegistryEnforcement(env, "enforce");

    const idle = await readRegistryIdleState(env);
    expect(idle.idle).toBe(false);
    expect(idle.blockedReason).toBe("registry_write_unresolved");
    const sweep = await acquireRegistrySweep(env, { owner: "collector-a" });
    expect(sweep.ok).toBe(false);
    if (sweep.ok) throw new Error("a publish in flight must block the sweep");
    expect(sweep.code).toBe("registry_admission_busy");

    await admitted.lease.complete("ok");
    const after = await acquireRegistrySweep(env, { owner: "collector-a" });
    expect(after.ok).toBe(true);
  });

  it("keeps a report_only request blocking after the enforcement flip", async () => {
    // Admitted while enforcement was off, so it carries no session.
    const admitted = await admitRegistryOperation(writeRequest(), env, {
      operation: "chunk_put",
    });
    expect(admitted.ok).toBe(true);
    if (!admitted.ok) return;
    expect(admitted.lease.sessionId).toBeNull();

    // It is still tracked, so the flip cannot expose it to a starting sweep.
    await setRegistryEnforcement(env, "enforce");
    const blocked = await acquireRegistrySweep(env, { owner: "collector-a" });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("an in-flight request must stay protected");

    await admitted.lease.complete("ok");
    expect((await acquireRegistrySweep(env, { owner: "collector-a" })).ok).toBe(
      true,
    );
  });
});

function writeRequest(sessionId?: string): Request {
  const headers = new Headers({ authorization: `Bearer ${PUBLISH_TOKEN}` });
  if (sessionId) headers.set(REGISTRY_SESSION_HEADER, sessionId);
  return new Request("https://intar.test/registry/v1/image-chunks/exists", {
    method: "POST",
    headers,
  });
}

async function writerRowIds(): Promise<string[]> {
  const rows = await env.DB.prepare(
    "SELECT id FROM image_registry_operation_writers ORDER BY created_at",
  ).all<{ id: string }>();
  return (rows.results ?? []).map((row) => row.id);
}

async function publishRequest(sessionId?: string): Promise<Response> {
  const headers = new Headers({ authorization: `Bearer ${PUBLISH_TOKEN}` });
  if (sessionId) headers.set(REGISTRY_SESSION_HEADER, sessionId);
  const response = await handleImageRegistryRequest(
    new Request("https://intar.test/registry/v1/publish", {
      method: "POST",
      headers,
    }),
    env,
  );
  if (!response) throw new Error("publish route did not match");
  return response;
}

async function sessionRowCount(): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM image_registry_upload_sessions",
  ).first<{ count: number }>();
  return row?.count ?? 0;
}

async function expireSweepHeartbeat(): Promise<void> {
  await env.DB.prepare(
    `UPDATE image_registry_admission
        SET sweep_expires_at = ?1, sweep_heartbeat_at = ?1
      WHERE key = ?2`,
  )
    .bind(Date.now() - 1, REGISTRY_ADMISSION_KEY)
    .run();
}
