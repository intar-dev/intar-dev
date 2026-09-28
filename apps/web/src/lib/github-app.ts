// The Intar GitHub App client for scenario sources. It only reads GitHub
// state: callers decide what to write. Tokens are never logged, stored or
// sent anywhere but api.github.com, and their format is never checked.
import { importPKCS8, SignJWT } from "jose";

const GITHUB_API = "https://api.github.com";
const GITHUB_API_TIMEOUT_MS = 10_000;
// A repository owner, repository name or login: one URL-safe path segment.
const NAME_PATTERN = /^(?!\.\.?$)[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export interface GitHubAppEnv {
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
}

export type MintOutcome =
  | { status: "ok"; token: string }
  | { status: "gone" | "suspended" | "transient" };

export interface RepositoryHead {
  id: number;
  fullName: string;
  defaultBranch: string;
  headSha: string;
}

/** Signs a short-lived App JWT; throws while the App is not configured. */
export async function appJwt(env: GitHubAppEnv): Promise<string> {
  const clientId = env.GITHUB_APP_CLIENT_ID;
  const privateKey = env.GITHUB_APP_PRIVATE_KEY;
  if (!clientId || !privateKey) throw new Error("GitHub App is not configured");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(clientId)
    .setIssuedAt(now - 60)
    .setExpirationTime(now + 9 * 60)
    .sign(await importPKCS8(privateKey, "RS256"));
}

/** Any answer but 200, including a 301 for a moved repository, is null. */
export async function findRepositoryInstallation(
  env: GitHubAppEnv,
  owner: string,
  repo: string,
): Promise<{ id: number } | null> {
  const path = repositoryPath(`${owner}/${repo}`);
  if (!path) return null;
  const response = await githubApi(`${path}/installation`, await appJwt(env));
  const id = response?.status === 200 ? idOf(await json(response)) : null;
  return id === null ? null : { id };
}

/**
 * Mints a token for one repository: by id once bound, and by name at bind
 * time, before the id is known. Only a 404 means gone outright; a 403, 429
 * or 422 is confirmed through the App JWT, and no body text is read.
 */
export async function mintInstallationToken(
  env: GitHubAppEnv,
  input: { installationId: number; fullName: string; repositoryId?: number },
): Promise<MintOutcome> {
  const path = repositoryPath(input.fullName);
  if (!path) return { status: "transient" };
  const jwt = await appJwt(env);
  const response = await githubApi(
    `/app/installations/${input.installationId}/access_tokens`,
    jwt,
    {
      method: "POST",
      body: JSON.stringify({
        ...(input.repositoryId === undefined
          ? { repositories: [input.fullName.split("/")[1]] }
          : { repository_ids: [input.repositoryId] }),
        // The collaborator-permission read is a Metadata endpoint.
        permissions: { contents: "read", checks: "write", metadata: "read" },
      }),
    },
  );
  switch (response?.status) {
    case 201: {
      const body = (await json(response)) as { token?: unknown } | null;
      return typeof body?.token === "string" && body.token
        ? { status: "ok", token: body.token }
        : { status: "transient" };
    }
    case 404:
      return { status: "gone" };
    case 403:
    case 429: {
      const installation = await githubApi(
        `/app/installations/${input.installationId}`,
        jwt,
      );
      if (installation?.status !== 200) return { status: "transient" };
      const body = (await json(installation)) as {
        suspended_at?: unknown;
      } | null;
      return body?.suspended_at != null
        ? { status: "suspended" }
        : { status: "transient" };
    }
    case 422:
      return (await installationGone(
        jwt,
        input.installationId,
        path,
        input.repositoryId,
      ))
        ? { status: "gone" }
        : { status: "transient" };
    default:
      return { status: "transient" };
  }
}

/**
 * Reads the one repository the token is scoped to, and its default-branch
 * head. No stored name is used, so a renamed or transferred repository is
 * read under its current name. Null when unreadable, or when the listing
 * holds anything but exactly one repository.
 */
export async function readRepository(
  token: string,
): Promise<RepositoryHead | null> {
  const listing = await githubApi("/installation/repositories", token);
  if (listing?.status !== 200) return null;
  const repositories = (
    (await json(listing)) as { repositories?: unknown } | null
  )?.repositories;
  if (!Array.isArray(repositories) || repositories.length !== 1) return null;
  const body = repositories[0] as {
    full_name?: unknown;
    default_branch?: unknown;
  } | null;
  if (
    typeof body?.full_name !== "string" ||
    typeof body.default_branch !== "string" ||
    !body.default_branch
  ) {
    return null;
  }
  const id = idOf(body);
  const path = repositoryPath(body.full_name);
  if (id === null || !path) return null;
  const branch = body.default_branch
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const ref = await githubApi(`${path}/git/ref/heads/${branch}`, token);
  if (ref?.status !== 200) return null;
  const head = (await json(ref)) as { object?: { sha?: unknown } } | null;
  const headSha = head?.object?.sha;
  if (typeof headSha !== "string" || !SHA_PATTERN.test(headSha)) return null;
  return {
    id,
    fullName: body.full_name,
    defaultBranch: body.default_branch,
    headSha,
  };
}

/**
 * True only when the GitHub account with this numeric id is a repository
 * admin. The current login comes from the id, never from a stored username.
 */
export async function verifyRepositoryAdmin(
  token: string,
  fullName: string,
  accountId: string,
): Promise<boolean> {
  const path = repositoryPath(fullName);
  if (!path || !/^[1-9][0-9]*$/.test(accountId)) return false;
  const user = await githubApi(`/user/${accountId}`, token);
  if (user?.status !== 200) return false;
  const login = ((await json(user)) as { login?: unknown } | null)?.login;
  if (typeof login !== "string" || !NAME_PATTERN.test(login)) return false;
  const permission = await githubApi(
    `${path}/collaborators/${login}/permission`,
    token,
  );
  if (permission?.status !== 200) return false;
  const body = (await json(permission)) as {
    permission?: unknown;
    user?: { id?: unknown } | null;
  } | null;
  return body?.permission === "admin" && body.user?.id === Number(accountId);
}

// A 422 mint is gone only when the App JWT confirms the installation or the
// repository's installation is gone. A bound repository renamed or
// transferred since its name was stored answers 301; that is followed once,
// and only to the bound id's installation. Any other answer is transient.
async function installationGone(
  jwt: string,
  installationId: number,
  path: string,
  repositoryId: number | undefined,
): Promise<boolean> {
  const installation = await githubApi(
    `/app/installations/${installationId}`,
    jwt,
  );
  if (installation?.status === 404) return true;
  let repository = await githubApi(`${path}/installation`, jwt);
  const moved = `/repositories/${repositoryId}/installation`;
  if (
    repository?.status === 301 &&
    repositoryId !== undefined &&
    repository.headers.get("location") === `${GITHUB_API}${moved}`
  ) {
    repository = await githubApi(moved, jwt);
  }
  if (repository?.status === 404) return true;
  if (repository?.status !== 200) return false;
  const id = idOf(await json(repository));
  return id !== null && id !== installationId;
}

function repositoryPath(fullName: string): string | null {
  const parts = fullName.split("/");
  return parts.length === 2 && parts.every((part) => NAME_PATTERN.test(part))
    ? `/repos/${fullName}`
    : null;
}

function idOf(body: unknown): number | null {
  const id = (body as { id?: unknown } | null)?.id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0
    ? id
    : null;
}

async function json(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

// Null when GitHub gave no answer. Redirects are never followed, so only
// api.github.com is called.
async function githubApi(
  path: string,
  bearer: string,
  init: { method?: string; body?: string } = {},
): Promise<Response | null> {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(GITHUB_API_TIMEOUT_MS),
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${bearer}`,
      "user-agent": "intar.dev",
      "x-github-api-version": "2022-11-28",
      ...(init.body === undefined
        ? {}
        : { "content-type": "application/json" }),
    },
  }).catch(() => null);
}
