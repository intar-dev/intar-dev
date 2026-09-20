import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { notifyRunStatusListeners } from "../../apps/web/src/control-plane/host-runtime-do/run-status-fanout";
import type { RunStatusSocketAttachment } from "../../apps/web/src/control-plane/host-runtime-do/base";

test("1,000 listeners use bounded queries and still lose access when revoked", async () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE scenario_runs (run_id TEXT PRIMARY KEY, host_id TEXT, user_id TEXT);
    CREATE TABLE session (id TEXT PRIMARY KEY, user_id TEXT, expires_at INTEGER);
    CREATE TABLE access_allowlist (user_id TEXT PRIMARY KEY, state TEXT, source_invite_id TEXT, source_lease_id TEXT, granted_at INTEGER);
    INSERT INTO scenario_runs VALUES ('run', 'host', 'alice');
    INSERT INTO session VALUES ('session', 'alice', 9007199254740991);
    INSERT INTO access_allowlist VALUES ('alice', 'active', 'invite', 'lease', 1);
  `);
  let queries = 0;
  let activeQueries = 0;
  let maxConcurrentQueries = 0;
  const db = {
    prepare: (query: string) => ({
      bind: (...values: unknown[]) => ({
        all: async () => {
          queries++;
          maxConcurrentQueries = Math.max(maxConcurrentQueries, ++activeQueries);
          await Promise.resolve();
          activeQueries--;
          return { results: sqlite.prepare(query).all(...values as never[]) };
        },
      }),
    }),
  } as unknown as D1Database;
  const makeSocket = (overrides: Partial<RunStatusSocketAttachment> = {}) => ({
    readyState: WebSocket.OPEN as number,
    messages: [] as string[],
    code: null as number | null,
    send(message: string) { this.messages.push(message); },
    close(code: number) { this.code = code; this.readyState = WebSocket.CLOSED; },
    attachment: {
      kind: "run-status", hostId: "host", runId: "run", userId: "alice",
      sessionId: "session", betaSourceInviteId: "invite",
      betaSourceLeaseId: "lease", betaAdmissionGrantedAt: 1,
      expiresAt: Number.MAX_SAFE_INTEGER,
      ...overrides,
    } satisfies RunStatusSocketAttachment,
  });
  const sockets = Array.from({ length: 1_000 }, () => makeSocket());
  const invalid = [
    makeSocket({ userId: "bob" }),
    makeSocket({ sessionId: "deleted-session" }),
    makeSocket({ betaSourceLeaseId: "old-lease" }),
    makeSocket({ hostId: "another-host" }),
    makeSocket({ runId: "another-run" }),
    makeSocket({ expiresAt: 0 }),
  ];
  const notify = (listeners: ReturnType<typeof makeSocket>[]) => notifyRunStatusListeners(
    db, listeners as unknown as WebSocket[],
    socket => (socket as unknown as ReturnType<typeof makeSocket>).attachment,
    { runId: "run", hostId: "host", revision: 2 },
  );
  try {
    await notify([...sockets, ...invalid]);
    expect(queries).toBe(8);
    expect(maxConcurrentQueries).toBe(1);
    expect(sockets.every(socket => socket.messages.length === 1)).toBe(true);
    expect(invalid.every(socket => socket.code === 1008 && socket.messages.length === 0)).toBe(true);
    sqlite.exec("DELETE FROM session");
    await notify(sockets);
    expect(queries).toBe(16);
    expect(sockets.every(socket => socket.code === 1008 && socket.messages.length === 1)).toBe(true);
    await notify(sockets);
    expect(queries).toBe(16);
  } finally {
    sqlite.close();
  }
});
