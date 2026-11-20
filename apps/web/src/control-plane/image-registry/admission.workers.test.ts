import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { resetD1Database } from "@/test/d1-migrations";
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

  describe("next to a pipeline", () => {
    const pipeline = (id: string) => ({ kind: "pipeline", id }) as const;

    beforeEach(async () => {
      await env.DB.prepare(
        `INSERT INTO scenario_sources
           (scope_key, github_installation_id, github_repository_id, github_repository, default_branch, mode)
         VALUES ('public', 1, 1, 'intar/scenarios', 'main', 'push')`,
      ).run();
      await setRegistryEnforcement(env, "enforce");
    });

    it("does not wait for a pipeline's open session or its blob writers", async () => {
      await pipelineSession("live", { expiresAt: Date.now() + 60_000 });
      const session = await createRegistryUploadSession(env, { owner: pipeline("live") });
      expect(session.ok).toBe(true);
      if (!session.ok) return;
      // In flight, never reported, and ended inconclusively.
      await writerRow({ ownerKind: "pipeline", operation: "blob_exists", sessionId: session.sessionId });
      await writerRow({ ownerKind: "pipeline", operation: "blob_put", sessionId: session.sessionId });
      await writerRow({ ownerKind: "pipeline", operation: "blob_put", expiresAt: 1 });
      await writerRow({ ownerKind: "pipeline", operation: "blob_put", outcome: "unknown", releasedAt: 1 });
      await writerRow({ ownerKind: "pipeline", operation: "blob_exists", outcome: "unknown", releasedAt: 1 });

      const idle = await readRegistryIdleState(env);
      expect(idle).toMatchObject({ idle: true, openSessions: 0, pendingWriters: 0, blockedReason: null });
      const acquired = await acquireRegistrySweep(env, { owner: "collector-a" });
      expect(acquired.ok).toBe(true);
      if (!acquired.ok) return;
      // The sweep may also delete: a hold that let it start must not stop it.
      expect(acquired.lease).toMatchObject({ deleteAllowed: true, blockedReason: null });
      const deletable = await assertRegistrySweepDeletable(env, {
        sweepToken: acquired.lease.sweepToken,
        objectKeys: ["oci/sha256/aa"],
      });
      expect(deletable.ok).toBe(true);
      // The pipeline's session is still its own. Of its rows only the one
      // long past its lease is gone: nothing else would remove it.
      expect(await sessionState(session.sessionId)).toBe("open");
      expect(await writerRowIds()).toHaveLength(4);
    });

    it("closes the admission sessions of a pipeline whose credential has ended", async () => {
      await pipelineSession("live", { expiresAt: Date.now() + 60_000 });
      await pipelineSession("expired", { expiresAt: Date.now() - 1 });
      await pipelineSession("closed", { expiresAt: Date.now() + 60_000, closedAt: Date.now() });
      const sessions: Record<string, string> = {};
      // "gone": its pipeline session row was deleted with its source.
      for (const id of ["live", "expired", "closed", "gone"]) {
        const created = await createRegistryUploadSession(env, { owner: pipeline(id) });
        if (!created.ok) throw new Error("the session must open");
        sessions[id] = created.sessionId;
      }

      expect((await acquireRegistrySweep(env, { owner: "collector-a" })).ok).toBe(true);
      expect(await sessionState(sessions.live!)).toBe("open");
      for (const id of ["expired", "closed", "gone"]) {
        expect(await env.DB.prepare(
          "SELECT state, close_reason, closed_at IS NOT NULL AS closed FROM image_registry_upload_sessions WHERE id = ?1",
        ).bind(sessions[id]).first()).toEqual({ state: "abandoned", close_reason: "pipeline_session_ended", closed: 1 });
      }
    });

    it("closes them even when the sweep cannot start", async () => {
      await pipelineSession("expired", { expiresAt: Date.now() - 1 });
      const ended = await createRegistryUploadSession(env, { owner: pipeline("expired") });
      const builder = await createRegistryUploadSession(env, { owner: { kind: "builder", id: "builder-a" } });
      if (!ended.ok || !builder.ok) throw new Error("the sessions must open");

      const blocked = await acquireRegistrySweep(env, { owner: "collector-a" });
      expect(blocked.ok).toBe(false);
      expect(await sessionState(ended.sessionId)).toBe("abandoned");
      // An expired lease of a builder is still not release authority.
      await env.DB.prepare("UPDATE image_registry_upload_sessions SET expires_at = 1 WHERE id = ?1")
        .bind(builder.sessionId).run();
      expect((await acquireRegistrySweep(env, { owner: "collector-a" })).ok).toBe(false);
      expect(await sessionState(builder.sessionId)).toBe("open");
    });

    it.each([
      ["manifest_put", "pending"],
      ["manifest_put", "unknown"],
      ["build_result", "pending"],
      ["build_result", "unknown"],
      // No route admits a pipeline for these; a row of one holds all the same.
      ["chunk_put", "pending"],
      ["publish", "unknown"],
    ] as const)("waits for a pipeline's %s writer that is %s", async (operation, outcome) => {
      const id = await writerRow({
        ownerKind: "pipeline", operation, outcome, releasedAt: outcome === "unknown" ? 1 : null,
      });
      const idle = await readRegistryIdleState(env);
      expect(idle).toMatchObject({ idle: false, pendingWriters: 1, blockedReason: "registry_write_unresolved" });
      const blocked = await acquireRegistrySweep(env, { owner: "collector-a" });
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.code).toBe("registry_admission_busy");

      await env.DB.prepare("DELETE FROM image_registry_operation_writers WHERE id = ?1").bind(id).run();
      expect((await acquireRegistrySweep(env, { owner: "collector-a" })).ok).toBe(true);
    });

    it.each(["builder", "publish_token"] as const)("still waits for an open session of a %s", async (kind) => {
      const session = await createRegistryUploadSession(env, { owner: { kind, id: `${kind}-a` } });
      if (!session.ok) throw new Error("the session must open");
      // Its lease running out changes nothing.
      await env.DB.prepare("UPDATE image_registry_upload_sessions SET expires_at = 1").run();

      const blocked = await acquireRegistrySweep(env, { owner: "collector-a" });
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.code).toBe("registry_admission_busy");
      expect(blocked.counts).toMatchObject({ openSessions: 1, staleOpenSessions: 1 });
      expect(await sessionState(session.sessionId)).toBe("open");

      await completeRegistryUploadSession(env, {
        owner: { kind, id: `${kind}-a` }, sessionId: session.sessionId, outcome: "abandoned",
      });
      expect((await acquireRegistrySweep(env, { owner: "collector-a" })).ok).toBe(true);
    });

    it.each([
      ["builder", "blob_exists", "pending"],
      ["builder", "blob_put", "pending"],
      ["builder", "blob_put", "unknown"],
      ["builder", "manifest_put", "pending"],
      ["builder", "build_result", "unknown"],
      ["publish_token", "blob_exists", "unknown"],
      ["publish_token", "blob_put", "pending"],
      ["publish_token", "blob_put", "unknown"],
      ["publish_token", "manifest_put", "unknown"],
      ["system", "run_start", "pending"],
    ] as const)("still waits for a %s's %s writer that is %s", async (ownerKind, operation, outcome) => {
      const id = await writerRow({ ownerKind, operation, outcome, releasedAt: outcome === "unknown" ? 1 : null });
      const blocked = await acquireRegistrySweep(env, { owner: "collector-a" });
      expect(blocked.ok).toBe(false);
      if (blocked.ok) return;
      expect(blocked.code).toBe("registry_admission_busy");
      expect(blocked.counts.pendingWriters).toBe(1);

      await env.DB.prepare("DELETE FROM image_registry_operation_writers WHERE id = ?1").bind(id).run();
      expect((await acquireRegistrySweep(env, { owner: "collector-a" })).ok).toBe(true);
    });

    it("stops a sweep's deletes for a writer that holds it, not for a pipeline's blob", async () => {
      const acquired = await acquireRegistrySweep(env, { owner: "collector-a" });
      if (!acquired.ok) throw new Error("the sweep must start");
      const check = () =>
        assertRegistrySweepDeletable(env, { sweepToken: acquired.lease.sweepToken, objectKeys: ["oci/sha256/aa"] });

      await writerRow({ ownerKind: "pipeline", operation: "blob_put", outcome: "unknown", releasedAt: 1 });
      expect((await check()).ok).toBe(true);
      await writerRow({ ownerKind: "builder", operation: "blob_put", outcome: "unknown", releasedAt: 1 });
      const blocked = await check();
      expect(blocked.ok).toBe(false);
      if (!blocked.ok) expect(blocked.code).toBe("registry_write_unresolved");
    });
  });
});

async function pipelineSession(
  id: string,
  input: { expiresAt: number; closedAt?: number },
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO pipeline_upload_sessions
       (id, token_hash, scope_key, github_repository_id, github_repository, ref, sha, rev,
        run_id, run_attempt, runner_environment, job_workflow_sha, expires_at, closed_at)
     VALUES (?1, ?1, 'public', 1, 'intar/scenarios', 'refs/heads/main', 'sha', 'rev',
        '1', 1, 'github-hosted', 'sha', ?2, ?3)`,
  )
    .bind(id, input.expiresAt, input.closedAt ?? null)
    .run();
}

/** A writer row as an admitted request leaves it, written directly. */
async function writerRow(input: {
  ownerKind: string;
  operation: string;
  outcome?: "pending" | "unknown";
  releasedAt?: number | null;
  expiresAt?: number;
  sessionId?: string;
}): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO image_registry_operation_writers
       (id, session_id, owner_kind, owner_id, operation, epoch, outcome,
        created_at, heartbeat_at, expires_at, released_at)
     VALUES (?1, ?2, ?3, 'owner', ?4, 0, ?5, ?6, ?6, ?7, ?8)`,
  )
    .bind(
      id,
      input.sessionId ?? null,
      input.ownerKind,
      input.operation,
      input.outcome ?? "pending",
      now,
      input.expiresAt ?? now + 60_000,
      input.releasedAt ?? null,
    )
    .run();
  return id;
}

async function sessionState(id: string): Promise<string | null> {
  return env.DB.prepare("SELECT state FROM image_registry_upload_sessions WHERE id = ?1")
    .bind(id)
    .first<string>("state");
}

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
