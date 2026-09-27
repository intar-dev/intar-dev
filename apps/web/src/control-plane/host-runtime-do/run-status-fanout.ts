import type { RunStatusSocketAttachment } from "./base";

// Bound query size and concurrent D1 work when many tabs watch the same run.
const STATUS_BATCH_SIZE = 128;

export async function notifyRunStatusListeners(
  db: D1Database,
  listeners: WebSocket[],
  readAttachment: (socket: WebSocket) => RunStatusSocketAttachment | null,
  input: { runId: string; hostId: string; revision: number },
): Promise<void> {
  for (let offset = 0; offset < listeners.length; offset += STATUS_BATCH_SIZE) {
    const batch: { socket: WebSocket; attachment: RunStatusSocketAttachment }[] = [];
    for (const socket of listeners.slice(offset, offset + STATUS_BATCH_SIZE)) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const attachment = readAttachment(socket);
      if (!attachment || attachment.expiresAt <= Date.now() || attachment.runId !== input.runId || attachment.hostId !== input.hostId) {
        close(socket, 1008, "invalid run status subscription");
        continue;
      }
      batch.push({ socket, attachment });
    }
    if (!batch.length) continue;
    let authorized: Set<number>;
    let revision = input.revision;
    try {
      // Use one current authorization snapshot per batch. No TTL cache can
      // keep a revoked browser session alive across status updates. The
      // active-account predicate is spelled out so this module stays free of
      // Worker imports.
      // The same read supplies the committed revision, so a caller that
      // cannot know it (revision 0) still pushes the current one.
      const result = await db.prepare(
        `SELECT CAST(subscriber.key AS INTEGER) AS position,
           run.updated_at AS revision
         FROM json_each(?1) subscriber
         JOIN scenario_runs run ON run.run_id = ?2 AND run.host_id = ?3
           AND run.user_id = json_extract(subscriber.value, '$.userId')
         JOIN session auth_session
           ON auth_session.id = json_extract(subscriber.value, '$.sessionId')
           AND auth_session.user_id = run.user_id AND auth_session.expires_at > ?4
         JOIN user run_owner ON run_owner.id = run.user_id
           AND run_owner.deleted_at IS NULL AND coalesce(run_owner.banned, 0) = 0`,
      ).bind(
        JSON.stringify(batch.map(({ attachment }) => attachment)),
        input.runId, input.hostId, Date.now(),
      ).all<{ position: number; revision: number }>();
      authorized = new Set(result.results.map(row => row.position));
      for (const row of result.results) revision = Math.max(revision, row.revision);
    } catch {
      for (const { socket } of batch) close(socket, 1011, "run status authorization failed");
      continue;
    }
    const message = JSON.stringify({
      type: "invalidate",
      runId: input.runId,
      revision,
    });
    for (const [position, { socket, attachment }] of batch.entries()) {
      if (!authorized.has(position) || attachment.expiresAt <= Date.now()) {
        close(socket, 1008, "run status access is no longer active");
        continue;
      }
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        socket.send(message);
      } catch {
        close(socket, 1011, "run status notification failed");
      }
    }
  }
}

function close(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // A disconnected listener must not prevent delivery to the other tabs.
  }
}
