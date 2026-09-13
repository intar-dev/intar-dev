/**
 * Fake Cloudflare D1 REST API for the rehearsal entrypoint test.
 *
 * It replaces global fetch in the child process, so the real CLI runs with real
 * arguments and environment variables while every request is answered from an
 * in-memory SQLite database. The client, the applier, and the entrypoint are
 * the production code paths; only the network is replaced.
 */
import { Database } from "bun:sqlite";
import type { D1Row, D1Value } from "./d1-rest-client";

const database = new Database(":memory:", { strict: true });
const requests: string[] = [];
const databaseId = "11111111-2222-3333-4444-555555555555";

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = init?.method ?? "GET";
  requests.push(method + " " + url);
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

  if (url.endsWith("/d1/database") && method === "POST") {
    return json({ success: true, result: { uuid: databaseId, name: body.name } });
  }
  if (url.includes("/d1/database/" + databaseId) && method === "DELETE") {
    return json({ success: true, result: {} });
  }
  if (url.includes("/query")) {
    // The client sends one statement directly and several as { batch }.
    const statements: Array<Record<string, unknown>> = Array.isArray(body.batch)
      ? (body.batch as Array<Record<string, unknown>>)
      : Array.isArray(body)
        ? (body as unknown as Array<Record<string, unknown>>)
        : [body];
    const results = statements.map((statement) => {
      const sql = String(statement.sql);
      const params = (statement.params ?? []) as D1Value[];
      try {
        const threaded = database.query(sql);
        const rows = threaded.all(...params) as D1Row[];
        return { success: true, results: rows, meta: { changes: rows.length } };
      } catch (error) {
        return {
          success: false,
          results: [],
          error: error instanceof Error ? error.message : String(error),
        };
      }
    });
    const failed = results.some((result) => result.success !== true);
    return json(
      {
        success: !failed,
        result: results,
        errors: failed
          ? [
              {
                code: 7500,
                message: results
                  .map((result) => String(result.error ?? ""))
                  .join("; "),
              },
            ]
          : [],
      },
      failed ? 400 : 200,
    );
  }
  return json({ success: false, errors: [{ code: 7000, message: "unexpected " + method + " " + url }] }, 400);
}) as typeof fetch;

// The statements the process sent, for the test to assert on.
process.on("exit", () => {
  const evidencePath = process.env.REHEARSAL_REQUEST_LOG;
  if (evidencePath) {
    const rows = database
      .query("SELECT count(*) AS count FROM __drizzle_migrations")
      .all() as Array<{ count: number }>;
    Bun.write(
      evidencePath,
      JSON.stringify({ requests, ledgerRows: rows[0]?.count ?? -1 }, null, 2),
    );
  }
});

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}
