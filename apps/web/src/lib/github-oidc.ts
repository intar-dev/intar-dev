// Verifies the GitHub Actions OIDC token of a push-mode scenario source
// upload. Only github.com's issuer is trusted, and its JWKS URL is a constant:
// no token can make Intar fetch another issuer or key host.
import {
  createRemoteJWKSet,
  decodeJwt,
  errors,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";
import { appError, type AppError } from "@/lib/app-error";

export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";

// A tag-pinned and a SHA-pinned caller of the reusable workflow.
const WORKFLOW_REF_PATTERN =
  /^intar-dev\/intar-dev\/\.github\/workflows\/scenario-publish\.yml@(refs\/tags\/scenario-publish-v\d+|[0-9a-f]{40})$/;
// Dependabot jobs carry "dynamic", which stays outside.
const WORKFLOW_EVENTS = new Set(["push", "workflow_dispatch"]);

let githubActionsKeys: JWTVerifyGetKey | undefined;

export interface GithubActionsClaims {
  repositoryId: number;
  ref: string;
  sha: string;
}

/**
 * Verifies the token's signature, issuer, audience and lifetime, then the
 * workflow claims: the reusable scenario-publish workflow at an allowlisted
 * commit (`workflowShas`, whitespace- or comma-separated), a push or dispatch
 * on a GitHub-hosted runner. The caller checks the repository, ref and sha
 * against its binding and the GitHub API.
 */
export async function verifyGithubActionsToken(
  token: string,
  input: { audience: string; workflowShas: string | undefined },
  keys: JWTVerifyGetKey = remoteKeys(),
): Promise<GithubActionsClaims> {
  let issuer: unknown;
  try {
    issuer = decodeJwt(token).iss;
  } catch {
    throw refused();
  }
  // GHEC's unique issuer is this host plus an enterprise slug. It is never
  // fetched; the unverified value only picks the refusal.
  if (typeof issuer === "string" && issuer.startsWith(`${GITHUB_ACTIONS_ISSUER}/`)) {
    throw appError(
      401,
      "issuer_unsupported",
      "Tokens from a GitHub Enterprise unique issuer are not supported.",
    );
  }

  let claims: Record<string, unknown>;
  try {
    ({ payload: claims } = await jwtVerify(token, keys, {
      issuer: GITHUB_ACTIONS_ISSUER,
      audience: input.audience,
      algorithms: ["RS256"],
      clockTolerance: 60,
    }));
  } catch (error) {
    // A timeout, a rejected fetch or a non-200 answer from GitHub's key host
    // (jose's generic error) is an outage the workflow waits out.
    if (
      !(error instanceof errors.JOSEError) ||
      error instanceof errors.JWKSTimeout ||
      error.code === errors.JOSEError.code
    ) {
      throw appError(503, "github_unavailable", "GitHub could not be read. Try again.");
    }
    throw refused();
  }

  const allowed = (input.workflowShas ?? "").split(/[\s,]+/).filter(Boolean);
  const { repository_id, ref, sha, job_workflow_ref, job_workflow_sha } = claims;
  if (
    // The claims are JSON strings, so a number is refused.
    typeof repository_id !== "string" ||
    !/^[1-9][0-9]{0,15}$/.test(repository_id) ||
    !Number.isSafeInteger(Number(repository_id)) ||
    typeof ref !== "string" ||
    typeof sha !== "string" ||
    !WORKFLOW_EVENTS.has(String(claims.event_name)) ||
    claims.runner_environment !== "github-hosted" ||
    typeof job_workflow_ref !== "string" ||
    !WORKFLOW_REF_PATTERN.test(job_workflow_ref) ||
    typeof job_workflow_sha !== "string" ||
    !allowed.includes(job_workflow_sha)
  ) {
    // Only these two non-secret claims are logged, so a pilot can read which
    // workflow commit a real token names.
    console.warn(
      JSON.stringify({
        event: "github_oidc_claims_refused",
        job_workflow_ref: typeof job_workflow_ref === "string" ? job_workflow_ref : null,
        job_workflow_sha: typeof job_workflow_sha === "string" ? job_workflow_sha : null,
      }),
    );
    throw refused();
  }
  return { repositoryId: Number(repository_id), ref, sha };
}

function remoteKeys(): JWTVerifyGetKey {
  githubActionsKeys ??= createRemoteJWKSet(
    new URL(`${GITHUB_ACTIONS_ISSUER}/.well-known/jwks`),
  );
  return githubActionsKeys;
}

function refused(): AppError {
  return appError(401, "unauthorized", "The GitHub Actions token was refused.");
}
