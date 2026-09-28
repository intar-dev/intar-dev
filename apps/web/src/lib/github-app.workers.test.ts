import {
  exportPKCS8,
  exportSPKI,
  generateKeyPair,
  importSPKI,
  jwtVerify,
} from "jose";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import {
  appJwt,
  findRepositoryInstallation,
  mintInstallationToken,
  readRepository,
  verifyRepositoryAdmin,
  type GitHubAppEnv,
} from "@/lib/github-app";

const CLIENT_ID = "Iv23liTestClient";
const TOKEN = "ghs_1234_stateless.installation-token";
const FULL_NAME = "intar-dev/scenarios";
const HEAD_SHA = "a".repeat(40);
const MINT = { installationId: 7, repositoryId: 42, fullName: FULL_NAME };

const CONSOLE_METHODS = ["debug", "error", "info", "log", "warn"] as const;

type Route = (request: Request) => Response | Promise<Response>;

let env: GitHubAppEnv;
let publicKeyPem: string;
let requests: Request[];
let unexpected: string[];
let consoleSpies: MockInstance[];

beforeAll(async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256", {
    extractable: true,
  });
  env = {
    GITHUB_APP_CLIENT_ID: CLIENT_ID,
    GITHUB_APP_PRIVATE_KEY: await exportPKCS8(privateKey),
  };
  publicKeyPem = await exportSPKI(publicKey);
});

beforeEach(() => {
  requests = [];
  unexpected = [];
  consoleSpies = CONSOLE_METHODS.map((method) => vi.spyOn(console, method));
});

afterEach(() => {
  expect(unexpected).toEqual([]);
  for (const request of requests) {
    expect(new URL(request.url).origin).toBe("https://api.github.com");
    expect(request.redirect).toBe("manual");
  }
  const output = JSON.stringify(consoleSpies.map((spy) => spy.mock.calls));
  expect(output).not.toContain(TOKEN);
  expect(output).not.toContain("eyJ");
  vi.restoreAllMocks();
});

/**
 * Serves `METHOD /path` routes. The client swallows fetch errors, so every
 * request is recorded and checked after the test instead of throwing here.
 */
function github(routes: Record<string, Route>) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    requests.push(new Request(input, init));
    const route = routes[`${request.method} ${new URL(request.url).pathname}`];
    if (!route) {
      unexpected.push(`${request.method} ${request.url}`);
      throw new Error("unexpected GitHub call");
    }
    return route(request);
  });
}

function status(code: number): Route {
  return () => new Response(null, { status: code });
}

function moved(location: string): Route {
  return () => new Response(null, { status: 301, headers: { location } });
}

function json(body: unknown, code = 200): Route {
  return () => Response.json(body, { status: code });
}

function bearer(request: Request | undefined): string {
  return request?.headers.get("authorization")?.replace(/^Bearer /u, "") ?? "";
}

async function verifyAppJwt(jwt: string) {
  return jwtVerify(jwt, await importSPKI(publicKeyPem, "RS256"), {
    issuer: CLIENT_ID,
    algorithms: ["RS256"],
  });
}

describe("appJwt", () => {
  it("signs an RS256 JWT for the client id valid from 60 s ago for 10 min", async () => {
    const before = Math.floor(Date.now() / 1000);
    const { payload, protectedHeader } = await verifyAppJwt(await appJwt(env));
    const after = Math.floor(Date.now() / 1000);

    expect(protectedHeader.alg).toBe("RS256");
    expect(payload.iss).toBe(CLIENT_ID);
    expect(payload.iat).toBeGreaterThanOrEqual(before - 60);
    expect(payload.iat).toBeLessThanOrEqual(after - 60);
    expect(payload.exp).toBe((payload.iat ?? 0) + 10 * 60);
  });

  it("fails closed without the client id or the private key", async () => {
    github({});
    await expect(
      appJwt({ ...env, GITHUB_APP_CLIENT_ID: "" }),
    ).rejects.toThrow();
    await expect(
      mintInstallationToken({ GITHUB_APP_CLIENT_ID: CLIENT_ID }, MINT),
    ).rejects.toThrow();
    expect(requests).toHaveLength(0);
  });
});

describe("findRepositoryInstallation", () => {
  it("returns the installation id through the App JWT", async () => {
    github({ "GET /repos/intar-dev/scenarios/installation": json({ id: 7 }) });

    await expect(
      findRepositoryInstallation(env, "intar-dev", "scenarios"),
    ).resolves.toEqual({ id: 7 });
    await expect(verifyAppJwt(bearer(requests[0]))).resolves.toBeDefined();
  });

  it.each([301, 404, 500])("refuses a %i answer", async (code) => {
    // The body carries an id so that only the status decides.
    github({
      "GET /repos/intar-dev/scenarios/installation": json({ id: 7 }, code),
    });

    await expect(
      findRepositoryInstallation(env, "intar-dev", "scenarios"),
    ).resolves.toBeNull();
  });

  it("refuses a name that is not one path segment without calling GitHub", async () => {
    github({});

    for (const [owner, repo] of [["..", "user"], ["a", "b/c"]] as const) {
      await expect(
        findRepositoryInstallation(env, owner, repo),
      ).resolves.toBeNull();
    }
    expect(requests).toHaveLength(0);
  });
});

describe("mintInstallationToken", () => {
  const MINT_PATH = "POST /app/installations/7/access_tokens";
  const INSTALLATION_PATH = "GET /app/installations/7";
  const REPO_INSTALLATION_PATH = "GET /repos/intar-dev/scenarios/installation";

  it("asks for exactly the bound repository and the three permissions", async () => {
    github({ [MINT_PATH]: json({ token: TOKEN }, 201) });

    await expect(mintInstallationToken(env, MINT)).resolves.toEqual({
      status: "ok",
      token: TOKEN,
    });
    const [request] = requests;
    expect(await request?.json()).toStrictEqual({
      repository_ids: [42],
      permissions: { contents: "read", checks: "write", metadata: "read" },
    });
    await expect(verifyAppJwt(bearer(request))).resolves.toBeDefined();
  });

  it("scopes a bind-time token by name before the id is known", async () => {
    github({ [MINT_PATH]: json({ token: TOKEN }, 201) });

    await expect(
      mintInstallationToken(env, { installationId: 7, fullName: FULL_NAME }),
    ).resolves.toEqual({ status: "ok", token: TOKEN });
    expect(await requests[0]?.json()).toStrictEqual({
      repositories: ["scenarios"],
      permissions: { contents: "read", checks: "write", metadata: "read" },
    });
  });

  it("refuses a name that is not owner/repo without calling GitHub", async () => {
    github({});

    await expect(
      mintInstallationToken(env, { installationId: 7, fullName: "a/b/c" }),
    ).resolves.toEqual({ status: "transient" });
    expect(requests).toHaveLength(0);
  });

  it.each<[string, string, Record<string, Route>]>([
    ["201", "ok", { [MINT_PATH]: json({ token: TOKEN }, 201) }],
    ["404", "gone", { [MINT_PATH]: status(404) }],
    [
      "a 403 for a suspended installation",
      "suspended",
      {
        [MINT_PATH]: status(403),
        [INSTALLATION_PATH]: json({
          id: 7,
          suspended_at: "2026-09-01T00:00:00Z",
        }),
      },
    ],
    [
      "a rate-limit 403",
      "transient",
      {
        [MINT_PATH]: status(403),
        [INSTALLATION_PATH]: json({ id: 7, suspended_at: null }),
      },
    ],
    [
      "a 429",
      "transient",
      {
        [MINT_PATH]: status(429),
        [INSTALLATION_PATH]: json({ id: 7, suspended_at: null }),
      },
    ],
    [
      "a 422 while the repository keeps the installation",
      "transient",
      {
        [MINT_PATH]: status(422),
        [INSTALLATION_PATH]: json({ id: 7, suspended_at: null }),
        [REPO_INSTALLATION_PATH]: json({ id: 7 }),
      },
    ],
    [
      "a 422 whose repository installation is gone",
      "gone",
      {
        [MINT_PATH]: status(422),
        [INSTALLATION_PATH]: json({ id: 7, suspended_at: null }),
        [REPO_INSTALLATION_PATH]: status(404),
      },
    ],
    [
      "a 422 whose repository moved to another installation",
      "gone",
      {
        [MINT_PATH]: status(422),
        [INSTALLATION_PATH]: json({ id: 7, suspended_at: null }),
        [REPO_INSTALLATION_PATH]: json({ id: 8 }),
      },
    ],
    [
      "a 422 whose installation is gone",
      "gone",
      { [MINT_PATH]: status(422), [INSTALLATION_PATH]: status(404) },
    ],
    [
      "a 422 whose repository was transferred to another installation",
      "gone",
      {
        [MINT_PATH]: status(422),
        [INSTALLATION_PATH]: json({ id: 7, suspended_at: null }),
        [REPO_INSTALLATION_PATH]: moved(
          "https://api.github.com/repositories/42/installation",
        ),
        "GET /repositories/42/installation": json({ id: 8 }),
      },
    ],
    [
      "a 422 whose repository redirects to another repository",
      "transient",
      {
        [MINT_PATH]: status(422),
        [INSTALLATION_PATH]: json({ id: 7, suspended_at: null }),
        [REPO_INSTALLATION_PATH]: moved(
          "https://api.github.com/repositories/43/installation",
        ),
      },
    ],
    [
      "a 422 whose repository redirects off api.github.com",
      "transient",
      {
        [MINT_PATH]: status(422),
        [INSTALLATION_PATH]: json({ id: 7, suspended_at: null }),
        [REPO_INSTALLATION_PATH]: moved(
          "https://example.com/repositories/42/installation",
        ),
      },
    ],
    ["a 502", "transient", { [MINT_PATH]: status(502) }],
    [
      "a network error",
      "transient",
      {
        [MINT_PATH]: () => {
          throw new TypeError("network down");
        },
      },
    ],
  ])("maps %s to %s", async (_, outcome, routes) => {
    github(routes);

    await expect(mintInstallationToken(env, MINT)).resolves.toMatchObject({
      status: outcome,
    });
  });
});

describe("readRepository", () => {
  const LISTING_PATH = "GET /installation/repositories";
  const REPOSITORY = {
    id: 42,
    full_name: "acme/intar-scenarios",
    default_branch: "release/main",
  };

  it("reads the token's repository under its current name, with its id", async () => {
    // The repository was bound as intar-dev/scenarios, then transferred and
    // renamed; its old name is never called.
    github({
      [LISTING_PATH]: json({ total_count: 1, repositories: [REPOSITORY] }),
      "GET /repos/acme/intar-scenarios/git/ref/heads/release/main": json({
        object: { sha: HEAD_SHA, type: "commit" },
      }),
    });

    await expect(readRepository(TOKEN)).resolves.toEqual({
      id: 42,
      fullName: "acme/intar-scenarios",
      defaultBranch: "release/main",
      headSha: HEAD_SHA,
    });
    expect(requests.map(bearer)).toEqual([TOKEN, TOKEN]);
  });

  it.each<[string, Record<string, Route>]>([
    [
      "a listing without a repository",
      { [LISTING_PATH]: json({ repositories: [] }) },
    ],
    [
      "a listing with two repositories",
      {
        [LISTING_PATH]: json({
          repositories: [REPOSITORY, { ...REPOSITORY, id: 43 }],
        }),
      },
    ],
    [
      "a repository without a numeric id",
      { [LISTING_PATH]: json({ repositories: [{ ...REPOSITORY, id: "42" }] }) },
    ],
    [
      "a ref that moved between the two reads",
      {
        [LISTING_PATH]: json({ repositories: [REPOSITORY] }),
        "GET /repos/acme/intar-scenarios/git/ref/heads/release/main":
          status(301),
      },
    ],
  ])("returns null for %s", async (_, routes) => {
    github(routes);

    await expect(readRepository(TOKEN)).resolves.toBeNull();
  });
});

describe("verifyRepositoryAdmin", () => {
  const USER_PATH = "GET /user/1001";
  const PERMISSION_PATH =
    "GET /repos/intar-dev/scenarios/collaborators/octo-admin/permission";

  it("accepts an admin whose login resolves from the numeric id", async () => {
    github({
      [USER_PATH]: json({ id: 1001, login: "octo-admin" }),
      [PERMISSION_PATH]: json({
        permission: "admin",
        user: { id: 1001, login: "octo-admin" },
      }),
    });

    await expect(
      verifyRepositoryAdmin(TOKEN, FULL_NAME, "1001"),
    ).resolves.toBe(true);
    expect(requests.map(bearer)).toEqual([TOKEN, TOKEN]);
  });

  it.each<[string, Record<string, Route>]>([
    [
      "a login that now belongs to another id",
      {
        [USER_PATH]: json({ id: 1001, login: "octo-admin" }),
        [PERMISSION_PATH]: json({
          permission: "admin",
          user: { id: 2002, login: "octo-admin" },
        }),
      },
    ],
    [
      "a null user",
      {
        [USER_PATH]: json({ id: 1001, login: "octo-admin" }),
        [PERMISSION_PATH]: json({ permission: "admin", user: null }),
      },
    ],
    ["an unknown id", { [USER_PATH]: status(404) }],
    [
      "a permission 404",
      {
        [USER_PATH]: json({ id: 1001, login: "octo-admin" }),
        [PERMISSION_PATH]: status(404),
      },
    ],
    [
      "a non-admin",
      {
        [USER_PATH]: json({ id: 1001, login: "octo-admin" }),
        [PERMISSION_PATH]: json({
          permission: "write",
          user: { id: 1001, login: "octo-admin" },
        }),
      },
    ],
  ])("refuses %s", async (_, routes) => {
    github(routes);

    await expect(
      verifyRepositoryAdmin(TOKEN, FULL_NAME, "1001"),
    ).resolves.toBe(false);
  });
});
