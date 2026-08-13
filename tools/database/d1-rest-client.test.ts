import { describe, expect, test } from "bun:test";
import { CloudflareD1RestClient } from "./d1-rest-client";

describe("CloudflareD1RestClient", () => {
  test("uses the current REST batch envelope", async () => {
    let requestBody: unknown;
    const client = new CloudflareD1RestClient({
      accountId: "account",
      databaseId: "database",
      token: "secret",
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json({
          success: true,
          errors: [],
          messages: [],
          result: [
            { success: true, results: [], meta: { changes: 1 } },
            { success: true, results: [], meta: { changes: 2 } },
          ],
        });
      }) as typeof fetch,
    });

    await expect(
      client.batch([
        { sql: "INSERT INTO first VALUES (?)", params: [1] },
        { sql: "INSERT INTO second VALUES (?)", params: [2] },
      ]),
    ).resolves.toEqual([
      { rows: [], changes: 1 },
      { rows: [], changes: 2 },
    ]);
    expect(requestBody).toEqual({
      batch: [
        { sql: "INSERT INTO first VALUES (?)", params: [1] },
        { sql: "INSERT INTO second VALUES (?)", params: [2] },
      ],
    });
  });

  test("uses the single-query envelope for one statement", async () => {
    let requestBody: unknown;
    const client = new CloudflareD1RestClient({
      accountId: "account",
      databaseId: "database",
      token: "secret",
      fetch: (async (_input: string | URL | Request, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body));
        return Response.json({
          success: true,
          errors: [],
          messages: [],
          result: [
            {
              success: true,
              results: [{ value: "ok" }],
              meta: { changes: 0 },
            },
          ],
        });
      }) as typeof fetch,
    });

    await expect(client.query("SELECT ? AS value", ["ok"])).resolves.toEqual({
      rows: [{ value: "ok" }],
      changes: 0,
    });
    expect(requestBody).toEqual({ sql: "SELECT ? AS value", params: ["ok"] });
  });

  test("fails a batch when any statement result fails", async () => {
    const client = new CloudflareD1RestClient({
      accountId: "account",
      databaseId: "database",
      token: "secret",
      fetch: (async () =>
        Response.json({
          success: true,
          errors: [],
          messages: [],
          result: [
            { success: true, results: [], meta: { changes: 1 } },
            { success: false, results: [], error: "constraint failed" },
          ],
        })) as typeof fetch,
    });

    await expect(
      client.batch([
        { sql: "INSERT INTO first VALUES (?)", params: [1] },
        { sql: "INSERT INTO second VALUES (?)", params: [2] },
      ]),
    ).rejects.toThrow("D1 statement 2 failed: constraint failed");
  });

  test("does not retry an ambiguous write failure", async () => {
    let attempts = 0;
    const client = new CloudflareD1RestClient({
      accountId: "account",
      databaseId: "database",
      token: "secret",
      fetch: (async () => {
        attempts += 1;
        throw new TypeError("connection reset");
      }) as typeof fetch,
    });

    await expect(
      client.batch([
        { sql: "INSERT INTO first VALUES (?)", params: [1] },
        { sql: "INSERT INTO second VALUES (?)", params: [2] },
      ]),
    ).rejects.toThrow("connection reset");
    expect(attempts).toBe(1);
  });
});
