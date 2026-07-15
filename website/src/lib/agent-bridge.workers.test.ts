/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { serializeSignedCookie } from "better-call";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  accessAllowlist,
  agentHosts,
  scenarioRuns,
  session as authSession,
  user,
} from "@/db/schema";
import { resetD1Database } from "@/test/d1-migrations";
import { auth } from "./auth";
import {
  jsonResponse,
  requireBootBenchmarkUserContext,
  requireUserContext,
  type BootBenchmarkAuthBindings,
} from "./agent-bridge";

const BENCHMARK_TOKEN = "test-boot-benchmark-token-0123456789abcdef";
const BENCHMARK_USER_ID = "benchmark-admin";
const BENCHMARK_HOST_ID = "benchmark-agent";

describe("jsonResponse", () => {
  it("preserves Headers instances while supplying the JSON content type", () => {
    const headers = new Headers({ "retry-after": "60" });

    const response = jsonResponse(
      { error: "rate limited" },
      { status: 429, headers },
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
  });

  it("does not overwrite an explicitly supplied content type", () => {
    const response = jsonResponse(
      { ok: true },
      { headers: { "content-type": "application/problem+json" } },
    );

    expect(response.headers.get("content-type")).toBe(
      "application/problem+json",
    );
  });
});

describe("boot benchmark operator authentication", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("rejects missing, malformed, and wrong credentials", async () => {
    for (const authorization of [
      null,
      "BootBenchmark",
      "BootBenchmark wrong-token",
      `Bearer ${BENCHMARK_TOKEN}`,
      `bootbenchmark ${BENCHMARK_TOKEN}`,
      `BootBenchmark ${BENCHMARK_TOKEN} suffix`,
    ]) {
      const result = await requireUserContext(
        new Request(
          "http://localhost/api/scenarios/broken-nginx",
          authorization ? { headers: { authorization } } : {},
        ),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(401);
    }
  });

  it("fails a BootBenchmark authorization attempt before considering a valid browser session", async () => {
    await seedBenchmarkOperator();
    const cookie = await createBenchmarkOperatorSessionCookie();

    const normalSession = await requireUserContext(
      new Request("http://localhost/api/admin/builds", {
        headers: { cookie },
      }),
    );
    expect(normalSession).toMatchObject({
      ok: true,
      context: {
        userId: BENCHMARK_USER_ID,
        authentication: { method: "session" },
      },
    });

    for (const authorization of [
      "BootBenchmark wrong-token",
      `BootBenchmark ${BENCHMARK_TOKEN}`,
      `bootbenchmark ${BENCHMARK_TOKEN}`,
    ]) {
      const result = await requireUserContext(
        new Request("http://localhost/api/admin/builds", {
          headers: { authorization, cookie },
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(401);
    }
  });

  it("fails closed for missing, weak, invalid, not-yet-valid, expired, or overlong configuration", async () => {
    const now = Date.now();
    const base = benchmarkBindings({
      INTAR_BOOT_BENCH_NOT_BEFORE_UNIX_MS: String(now - 60_000),
      INTAR_BOOT_BENCH_EXPIRES_AT_UNIX_MS: String(now + 60_000),
    });
    const invalidBindings: BootBenchmarkAuthBindings[] = [
      withoutBenchmarkBinding(base, "INTAR_BOOT_BENCH_TOKEN"),
      { ...base, INTAR_BOOT_BENCH_TOKEN: "too-short" },
      withoutBenchmarkBinding(base, "INTAR_BOOT_BENCH_USER_ID"),
      withoutBenchmarkBinding(base, "INTAR_BOOT_BENCH_HOST_ID"),
      withoutBenchmarkBinding(base, "INTAR_BOOT_BENCH_NOT_BEFORE_UNIX_MS"),
      withoutBenchmarkBinding(base, "INTAR_BOOT_BENCH_EXPIRES_AT_UNIX_MS"),
      { ...base, INTAR_BOOT_BENCH_NOT_BEFORE_UNIX_MS: "invalid" },
      { ...base, INTAR_BOOT_BENCH_EXPIRES_AT_UNIX_MS: "invalid" },
      {
        ...base,
        INTAR_BOOT_BENCH_NOT_BEFORE_UNIX_MS: String(now + 1),
      },
      { ...base, INTAR_BOOT_BENCH_EXPIRES_AT_UNIX_MS: String(now) },
      {
        ...base,
        INTAR_BOOT_BENCH_NOT_BEFORE_UNIX_MS: String(now - 1),
        INTAR_BOOT_BENCH_EXPIRES_AT_UNIX_MS: String(now + 3 * 60 * 60 * 1_000),
      },
    ];

    for (const bindings of invalidBindings) {
      const result = await requireBootBenchmarkUserContext(
        benchmarkRequest("GET", "/api/scenarios/broken-nginx"),
        bindings,
        now,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.response.status).toBe(401);
    }
  });

  it("requires a current allowlisted, unbanned administrator", async () => {
    await seedBenchmarkOperator({ role: "user" });
    await expectUnauthorized(
      benchmarkRequest("GET", "/api/scenarios/broken-nginx"),
    );

    await resetD1Database();
    await seedBenchmarkOperator({ allowlisted: false });
    await expectUnauthorized(
      benchmarkRequest("GET", "/api/scenarios/broken-nginx"),
    );

    await resetD1Database();
    await seedBenchmarkOperator({ banned: true });
    await expectUnauthorized(
      benchmarkRequest("GET", "/api/scenarios/broken-nginx"),
    );
  });

  it("allows only the exact host, broken-nginx scenario, and owned in-window run routes", async () => {
    const window = benchmarkWindow();
    await seedBenchmarkOperator();
    await seedHost(BENCHMARK_HOST_ID, BENCHMARK_USER_ID);
    await seedRun({
      runId: "run-benchmark",
      userId: BENCHMARK_USER_ID,
      hostId: BENCHMARK_HOST_ID,
      scenarioId: "broken-nginx",
      createdAt: window.notBeforeUnixMs + 1,
    });

    const allowed = [
      ["GET", `/api/agent/hosts/${BENCHMARK_HOST_ID}`],
      ["GET", "/api/scenarios/broken-nginx"],
      ["POST", "/api/scenarios/broken-nginx/start"],
      ["GET", "/api/scenarios/runs/run-benchmark"],
      ["POST", "/api/scenarios/runs/run-benchmark/destroy"],
      ["POST", "/api/scenarios/runs/run-benchmark/ssh"],
    ] as const;

    for (const [method, path] of allowed) {
      const result = await requireUserContext(benchmarkRequest(method, path));
      expect(result).toMatchObject({
        ok: true,
        context: {
          userId: BENCHMARK_USER_ID,
          role: "admin",
          isAdmin: true,
          authentication: {
            method: "boot_benchmark",
            purpose: "broken_nginx_boot_benchmark",
            hostId: BENCHMARK_HOST_ID,
          },
        },
      });
    }
  });

  it("authorizes scoped start and run routes with one D1 statement each", async () => {
    const window = benchmarkWindow();
    await seedBenchmarkOperator();
    await seedHost(BENCHMARK_HOST_ID, BENCHMARK_USER_ID);
    await seedRun({
      runId: "run-single-query",
      userId: BENCHMARK_USER_ID,
      hostId: BENCHMARK_HOST_ID,
      scenarioId: "broken-nginx",
      createdAt: window.notBeforeUnixMs + 1,
    });

    for (const [method, path] of [
      ["POST", "/api/scenarios/broken-nginx/start"],
      ["GET", "/api/scenarios/runs/run-single-query"],
    ] as const) {
      const counter = countedDatabase(env.DB);
      const result = await requireBootBenchmarkUserContext(
        benchmarkRequest(method, path),
        benchmarkBindings({ DB: counter.database }),
      );

      expect(result.ok).toBe(true);
      expect(counter.preparedStatements()).toBe(1);
    }
  });

  it("rejects path, method, host, query, and run-scope escapes", async () => {
    const window = benchmarkWindow();
    await seedBenchmarkOperator();
    await seedHost(BENCHMARK_HOST_ID, BENCHMARK_USER_ID);
    await seedHost("other-agent", BENCHMARK_USER_ID);
    await seedRun({
      runId: "wrong-scenario",
      userId: BENCHMARK_USER_ID,
      hostId: BENCHMARK_HOST_ID,
      scenarioId: "pair-ping",
      createdAt: window.notBeforeUnixMs + 1,
    });
    await seedRun({
      runId: "wrong-host",
      userId: BENCHMARK_USER_ID,
      hostId: "other-agent",
      scenarioId: "broken-nginx",
      createdAt: window.notBeforeUnixMs + 1,
    });
    await seedRun({
      runId: "before-window",
      userId: BENCHMARK_USER_ID,
      hostId: BENCHMARK_HOST_ID,
      scenarioId: "broken-nginx",
      createdAt: window.notBeforeUnixMs - 1,
    });

    for (const [method, path] of [
      ["GET", "/api/agent/hosts/other-agent"],
      ["DELETE", `/api/agent/hosts/${BENCHMARK_HOST_ID}`],
      ["GET", `/api/agent/hosts/${BENCHMARK_HOST_ID}?full=1`],
      ["GET", "/api/scenarios/pair-ping"],
      ["GET", "/api/scenarios/broken-nginx/start"],
      ["POST", "/api/scenarios/broken-nginx"],
      ["GET", "/api/scenarios"],
      ["GET", "/api/scenarios/runs"],
      ["DELETE", "/api/scenarios/runs/run-benchmark"],
      ["GET", "/api/scenarios/runs/run-benchmark/destroy"],
      ["POST", "/api/scenarios/runs/run-benchmark/solution/reveal"],
      ["GET", "/api/scenarios/runs/missing"],
      ["GET", "/api/scenarios/runs/wrong-scenario"],
      ["GET", "/api/scenarios/runs/wrong-host"],
      ["GET", "/api/scenarios/runs/before-window"],
      ["GET", "/api/admin/builds"],
    ] as const) {
      await expectUnauthorized(benchmarkRequest(method, path));
    }
  });

  it("permits at most the five warmups and thirty measured runs in its credential window", async () => {
    const window = benchmarkWindow();
    await seedBenchmarkOperator();
    await seedHost(BENCHMARK_HOST_ID, BENCHMARK_USER_ID);
    await seedHost("other-agent", BENCHMARK_USER_ID);
    await seedRun({
      runId: "wrong-scenario-does-not-count",
      userId: BENCHMARK_USER_ID,
      hostId: BENCHMARK_HOST_ID,
      scenarioId: "pair-ping",
      createdAt: window.notBeforeUnixMs + 1,
    });
    await seedRun({
      runId: "wrong-host-does-not-count",
      userId: BENCHMARK_USER_ID,
      hostId: "other-agent",
      scenarioId: "broken-nginx",
      createdAt: window.notBeforeUnixMs + 1,
    });
    await seedRun({
      runId: "expired-window-does-not-count",
      userId: BENCHMARK_USER_ID,
      hostId: BENCHMARK_HOST_ID,
      scenarioId: "broken-nginx",
      createdAt: window.notBeforeUnixMs - 1,
    });
    for (let index = 0; index < 34; index += 1) {
      await seedRun({
        runId: `run-${index}`,
        userId: BENCHMARK_USER_ID,
        hostId: BENCHMARK_HOST_ID,
        scenarioId: "broken-nginx",
        createdAt: window.notBeforeUnixMs + index + 1,
      });
    }

    const thirtyFifth = await requireUserContext(
      benchmarkRequest("POST", "/api/scenarios/broken-nginx/start"),
    );
    expect(thirtyFifth.ok).toBe(true);

    await seedRun({
      runId: "run-34",
      userId: BENCHMARK_USER_ID,
      hostId: BENCHMARK_HOST_ID,
      scenarioId: "broken-nginx",
      createdAt: window.notBeforeUnixMs + 35,
    });
    await expectUnauthorized(
      benchmarkRequest("POST", "/api/scenarios/broken-nginx/start"),
    );
  });
});

function benchmarkRequest(method: string, path: string): Request {
  return new Request(`http://localhost${path}`, {
    method,
    headers: {
      authorization: `BootBenchmark ${BENCHMARK_TOKEN}`,
      ...(method === "POST" ? { origin: "http://localhost" } : {}),
    },
  });
}

function benchmarkBindings(
  overrides: Partial<BootBenchmarkAuthBindings> = {},
): BootBenchmarkAuthBindings {
  const notBefore = env.INTAR_BOOT_BENCH_NOT_BEFORE_UNIX_MS;
  const expiresAt = env.INTAR_BOOT_BENCH_EXPIRES_AT_UNIX_MS;
  if (!notBefore || !expiresAt) {
    throw new Error("worker test benchmark window bindings are missing");
  }
  return {
    DB: env.DB,
    INTAR_BOOT_BENCH_TOKEN: BENCHMARK_TOKEN,
    INTAR_BOOT_BENCH_USER_ID: BENCHMARK_USER_ID,
    INTAR_BOOT_BENCH_HOST_ID: BENCHMARK_HOST_ID,
    INTAR_BOOT_BENCH_NOT_BEFORE_UNIX_MS: notBefore,
    INTAR_BOOT_BENCH_EXPIRES_AT_UNIX_MS: expiresAt,
    ...overrides,
  };
}

function countedDatabase(database: D1Database): {
  database: D1Database;
  preparedStatements: () => number;
} {
  let preparedStatements = 0;
  const counted = new Proxy(database, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          preparedStatements += 1;
          return target.prepare(query);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    database: counted,
    preparedStatements: () => preparedStatements,
  };
}

function withoutBenchmarkBinding(
  bindings: BootBenchmarkAuthBindings,
  key: Exclude<keyof BootBenchmarkAuthBindings, "DB">,
): BootBenchmarkAuthBindings {
  const copy = { ...bindings };
  delete copy[key];
  return copy;
}

function benchmarkWindow(): {
  notBeforeUnixMs: number;
  expiresAtUnixMs: number;
} {
  return {
    notBeforeUnixMs: Number(env.INTAR_BOOT_BENCH_NOT_BEFORE_UNIX_MS),
    expiresAtUnixMs: Number(env.INTAR_BOOT_BENCH_EXPIRES_AT_UNIX_MS),
  };
}

async function expectUnauthorized(request: Request): Promise<void> {
  const result = await requireUserContext(request);
  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.response.status).toBe(401);
    await expect(result.response.json()).resolves.toEqual({
      error: "unauthorized",
    });
  }
}

async function seedBenchmarkOperator(
  input: {
    role?: string;
    allowlisted?: boolean;
    banned?: boolean;
  } = {},
): Promise<void> {
  const db = drizzle(env.DB);
  const username = "benchmark-admin";
  await db.insert(user).values({
    id: BENCHMARK_USER_ID,
    name: "Benchmark Admin",
    email: "benchmark-admin@example.com",
    username,
    role: input.role ?? "admin",
    banned: input.banned ?? false,
  });
  if (input.allowlisted !== false) {
    await db.insert(accessAllowlist).values({
      githubUsername: username,
      approvedBy: null,
      approvedAt: Date.now(),
    });
  }
}

async function createBenchmarkOperatorSessionCookie(): Promise<string> {
  const context = await auth.$context;
  const token = "benchmark-browser-session-token";
  const now = Date.now();
  await drizzle(env.DB)
    .insert(authSession)
    .values({
      id: "benchmark-browser-session",
      userId: BENCHMARK_USER_ID,
      token,
      expiresAt: new Date(now + 60_000),
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
  const setCookie = await serializeSignedCookie(
    context.authCookies.sessionToken.name,
    token,
    env.BETTER_AUTH_SECRET,
  );
  return setCookie.split(";", 1)[0]!;
}

async function seedHost(hostId: string, userId: string): Promise<void> {
  await drizzle(env.DB).insert(agentHosts).values({
    id: hostId,
    userId,
    name: hostId,
  });
}

async function seedRun(input: {
  runId: string;
  userId: string;
  hostId: string;
  scenarioId: string;
  createdAt: number;
}): Promise<void> {
  await drizzle(env.DB).insert(scenarioRuns).values({
    runId: input.runId,
    userId: input.userId,
    hostId: input.hostId,
    scenarioId: input.scenarioId,
    scenarioName: input.scenarioId,
    title: input.scenarioId,
    tagline: "",
    briefingMarkdown: "",
    objectivesJson: "[]",
    difficulty: "easy",
    estimatedMinutes: 1,
    tagsJson: [],
    hintsJson: [],
    solutionMarkdown: "",
    vmCount: 1,
    state: "completed",
    stateRank: 1,
    stateJson: "{}",
    completedAt: input.createdAt,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
  });
}
