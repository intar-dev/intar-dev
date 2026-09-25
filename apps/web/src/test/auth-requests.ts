import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { vi } from "vitest";
import { session } from "@/db/schema";
import { auth } from "@/lib/auth";
import { getSignupStatus, setSignupLimit } from "@/lib/signups";
import { FIXTURE_ADMIN_ID } from "@/test/account-fixtures";

// Requests and fixtures for tests that drive Better Auth's handler directly.

/** A same-origin JSON POST to an auth route. */
export function authRequest(
  path: string,
  body: object,
  extraHeaders?: HeadersInit,
): Request {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json");
  headers.set("origin", "http://localhost");
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

export function requestUrl(request: RequestInfo | URL): string {
  return typeof request === "string"
    ? request
    : request instanceof URL
      ? request.href
      : request.url;
}

/** The session cookie Better Auth would set for `token`. */
export async function signedSessionCookie(token: string): Promise<string> {
  const context = await auth.$context;
  return signedCookie(context.authCookies.sessionToken.name, token);
}

/** A cookie Better Auth signed with its secret, as `setSignedCookie` does. */
export async function signedCookie(name: string, value: string): Promise<string> {
  const context = await auth.$context;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(context.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(value),
  );
  const encodedSignature = btoa(
    String.fromCharCode(...new Uint8Array(signature)),
  );
  return `${name}=${encodeURIComponent(`${value}.${encodedSignature}`)}`;
}

/** Stores a week-long session and returns its signed cookie. */
export async function seedSessionCookie(input: {
  id: string;
  token: string;
  userId: string;
  now: number;
  impersonatedBy?: string;
}): Promise<string> {
  await drizzle(env.DB).insert(session).values({
    id: input.id,
    token: input.token,
    userId: input.userId,
    expiresAt: new Date(input.now + 7 * 24 * 60 * 60_000),
    createdAt: new Date(input.now),
    updatedAt: new Date(input.now),
    impersonatedBy: input.impersonatedBy ?? null,
  });
  return signedSessionCookie(input.token);
}

export async function setTestSignupLimit(limit: number): Promise<void> {
  const { version } = await getSignupStatus(env.DB);
  await setSignupLimit({
    d1: env.DB,
    actorUserId: FIXTURE_ADMIN_ID,
    limit,
    expectedVersion: version,
  });
}

export interface GithubProfile {
  email: string;
  githubAccountId: string;
  githubLogin: string;
}

/**
 * Serves GitHub's token and profile endpoints for each authorization code, so
 * concurrent callbacks each receive their own identity.
 */
export function mockGithubProfiles(profiles: Record<string, GithubProfile>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async (input, init): Promise<Response> => {
      const request = new Request(input, init);
      if (request.url === "https://github.com/login/oauth/access_token") {
        const code = new URLSearchParams(
          new TextDecoder().decode(await request.arrayBuffer()),
        ).get("code");
        if (!code || !profiles[code]) {
          throw new Error(`unexpected GitHub authorization code: ${code}`);
        }
        return Response.json({
          access_token: `token-${code}`,
          scope: "read:user,user:email",
          token_type: "bearer",
        });
      }
      const code = request.headers
        .get("authorization")
        ?.replace(/^Bearer token-/u, "");
      const profile = code ? profiles[code] : undefined;
      if (profile && request.url === "https://api.github.com/user") {
        return Response.json({
          id: Number(profile.githubAccountId),
          login: profile.githubLogin,
          name: profile.githubLogin,
          email: profile.email,
          avatar_url: null,
        });
      }
      if (profile && request.url === "https://api.github.com/user/emails") {
        return Response.json([
          {
            email: profile.email,
            primary: true,
            verified: true,
            visibility: null,
          },
        ]);
      }
      throw new Error(`unexpected fetch in GitHub callback test: ${request.url}`);
    },
  );
}
