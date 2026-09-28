import {
  createLocalJWKSet,
  createRemoteJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JSONWebKeySet,
} from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  GITHUB_ACTIONS_ISSUER,
  verifyGithubActionsToken,
} from "@/lib/github-oidc";

const AUDIENCE = "https://intar.dev";
const WORKFLOW_SHA = "c".repeat(40);
const WORKFLOW = "intar-dev/intar-dev/.github/workflows/scenario-publish.yml";
const CLAIMS = {
  repository_id: "42",
  ref: "refs/heads/main",
  sha: "a".repeat(40),
  event_name: "push",
  runner_environment: "github-hosted",
  job_workflow_ref: `${WORKFLOW}@refs/tags/scenario-publish-v1`,
  job_workflow_sha: WORKFLOW_SHA,
};

let privateKey: CryptoKey;
let jwks: JSONWebKeySet;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  privateKey = pair.privateKey;
  jwks = { keys: [{ ...(await exportJWK(pair.publicKey)), kid: "k1", alg: "RS256" }] };
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function token(
  claims: Record<string, unknown> = {},
  options: { iss?: string; aud?: string; expSecondsAgo?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ ...CLAIMS, ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(options.iss ?? GITHUB_ACTIONS_ISSUER)
    .setAudience(options.aud ?? AUDIENCE)
    .setIssuedAt(now - 600)
    .setExpirationTime(now - (options.expSecondsAgo ?? -300))
    .sign(privateKey);
}

function verify(jwt: string, workflowShas: string | null = WORKFLOW_SHA) {
  return verifyGithubActionsToken(
    jwt,
    { audience: AUDIENCE, workflowShas: workflowShas ?? undefined },
    createLocalJWKSet(jwks),
  );
}

describe("GitHub Actions OIDC", () => {
  it.each([
    ["a tag-pinned caller", `${WORKFLOW}@refs/tags/scenario-publish-v1`],
    ["a SHA-pinned caller", `${WORKFLOW}@${"d".repeat(40)}`],
  ])("accepts %s at an allowlisted workflow commit", async (_name, ref) => {
    await expect(
      verify(await token({ job_workflow_ref: ref }), `${"e".repeat(40)}, ${WORKFLOW_SHA}`),
    ).resolves.toEqual({ repositoryId: 42, ref: CLAIMS.ref, sha: CLAIMS.sha });
  });

  it.each([
    ["a numeric repository_id", { repository_id: 42 }],
    ["an unknown workflow commit", { job_workflow_sha: "f".repeat(40) }],
    ["a branch-pinned workflow", { job_workflow_ref: `${WORKFLOW}@refs/heads/main` }],
    ["another repository's workflow", {
      job_workflow_ref: "acme/intar-dev/.github/workflows/scenario-publish.yml@refs/tags/scenario-publish-v1",
    }],
    ["a Dependabot job", { event_name: "dynamic" }],
    ["a pull request", { event_name: "pull_request" }],
    ["a self-hosted runner", { runner_environment: "self-hosted" }],
  ])("refuses %s", async (_name, claims) => {
    await expect(verify(await token(claims))).rejects.toMatchObject({
      status: 401,
      code: "unauthorized",
    });
  });

  it("refuses every token while no workflow commit is allowlisted", async () => {
    await expect(verify(await token(), "")).rejects.toMatchObject({ status: 401 });
    await expect(verify(await token(), null)).rejects.toMatchObject({ status: 401 });
  });

  it("refuses another audience or issuer", async () => {
    await expect(verify(await token({}, { aud: "https://example.test" }))).rejects.toMatchObject({ status: 401 });
    await expect(verify(await token({}, { iss: "https://example.test" }))).rejects.toMatchObject({ status: 401 });
  });

  it("allows 60 s of clock skew on expiry", async () => {
    await expect(verify(await token({}, { expSecondsAgo: 30 }))).resolves.toMatchObject({ repositoryId: 42 });
    await expect(verify(await token({}, { expSecondsAgo: 120 }))).rejects.toMatchObject({ status: 401 });
  });

  it("answers a GHEC unique issuer before any key lookup", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const keys = vi.fn(createLocalJWKSet(jwks));
    const jwt = await token({}, { iss: `${GITHUB_ACTIONS_ISSUER}/acme-enterprise` });
    await expect(
      verifyGithubActionsToken(jwt, { audience: AUDIENCE, workflowShas: WORKFLOW_SHA }, keys),
    ).rejects.toMatchObject({ status: 401, code: "issuer_unsupported" });
    expect(keys).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("logs only the workflow claims of a refused token", async () => {
    const warn = vi.spyOn(console, "warn");
    const jwt = await token({ job_workflow_sha: "f".repeat(40) });
    await expect(verify(jwt)).rejects.toMatchObject({ status: 401 });
    expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
      {
        event: "github_oidc_claims_refused",
        job_workflow_ref: CLAIMS.job_workflow_ref,
        job_workflow_sha: "f".repeat(40),
      },
    ]);
  });

  it.each([
    ["answers 503", async () => new Response(null, { status: 503 })],
    ["is unreachable", async () => Promise.reject(new TypeError("fetch failed"))],
  ])("answers 503 while GitHub's key host %s", async (_name, answer) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(answer);
    await expect(
      verifyGithubActionsToken(
        await token(),
        { audience: AUDIENCE, workflowShas: WORKFLOW_SHA },
        createRemoteJWKSet(new URL(`${GITHUB_ACTIONS_ISSUER}/.well-known/jwks`)),
      ),
    ).rejects.toMatchObject({ status: 503, code: "github_unavailable" });
  });

  it("reads keys only from GitHub's constant JWKS URL", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json(jwks));
    await expect(
      verifyGithubActionsToken(await token(), { audience: AUDIENCE, workflowShas: WORKFLOW_SHA }),
    ).resolves.toMatchObject({ repositoryId: 42 });
    expect(fetchSpy.mock.calls.map(([input]) => String(input))).toEqual([
      `${GITHUB_ACTIONS_ISSUER}/.well-known/jwks`,
    ]);
  });
});
