/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { accessAllowlist } from "@/db/schema";
import { resetD1Database } from "@/test/d1-migrations";
import { auth } from "./auth";

describe("auth policy", () => {
  beforeEach(async () => {
    await resetD1Database();
  });

  it("rejects credential auth and uncoordinated user deletion", async () => {
    const [
      signUpResponse,
      signInResponse,
      selfDeleteResponse,
      adminDeleteResponse,
    ] = await Promise.all([
      auth.handler(
        authRequest("/api/auth/sign-up/email", {
          name: "Attacker",
          email: "attacker@example.com",
          password: "correct-horse-battery-staple",
          username: "allowlisteduser",
        }),
      ),
      auth.handler(
        authRequest("/api/auth/sign-in/email", {
          email: "attacker@example.com",
          password: "correct-horse-battery-staple",
        }),
      ),
      auth.handler(authRequest("/api/auth/delete-user", {})),
      auth.handler(
        authRequest("/api/auth/admin/remove-user", { userId: "victim" }),
      ),
    ]);

    expect(auth.options).toMatchObject({
      disabledPaths: [
        "/sign-up/email",
        "/sign-in/email",
        "/delete-user",
        "/delete-user/callback",
        "/admin/remove-user",
      ],
      emailAndPassword: {
        enabled: false,
        disableSignUp: true,
      },
    });
    expect(signUpResponse.status).toBe(404);
    await expect(signUpResponse.text()).resolves.toBe("Not Found");
    expect(signInResponse.status).toBe(404);
    await expect(signInResponse.text()).resolves.toBe("Not Found");
    expect(selfDeleteResponse.status).toBe(404);
    await expect(selfDeleteResponse.text()).resolves.toBe("Not Found");
    expect(adminDeleteResponse.status).toBe(404);
    await expect(adminDeleteResponse.text()).resolves.toBe("Not Found");
  });

  it("maps GitHub identities to usernames and keeps the allowlist creation gate", async () => {
    const github = auth.options.socialProviders?.github;
    expect(github).toBeDefined();

    const mappedUser = github?.mapProfileToUser?.({
      login: "allowed-github-user",
    } as never);
    expect(mappedUser).toMatchObject({
      username: "allowed-github-user",
      displayUsername: "allowed-github-user",
    });

    const beforeCreate = auth.options.databaseHooks?.user?.create?.before;
    expect(beforeCreate).toBeTypeOf("function");
    await expect(beforeCreate?.(mappedUser as never)).resolves.toBe(false);

    await drizzle(env.DB).insert(accessAllowlist).values({
      githubUsername: "allowed-github-user",
      approvedBy: null,
      approvedAt: Date.now(),
    });
    await expect(
      beforeCreate?.(mappedUser as never),
    ).resolves.toBeUndefined();
  });

  it("accepts the full GitHub username length and hyphen syntax", async () => {
    const username = `a-${"b".repeat(37)}`;
    expect(username).toHaveLength(39);
    await drizzle(env.DB).insert(accessAllowlist).values({
      githubUsername: username,
      approvedBy: null,
      approvedAt: Date.now(),
    });

    const created = await (await auth.$context).internalAdapter.createUser(
      {
        name: "Long GitHub User",
        email: "long-github-user@example.com",
        username,
        displayUsername: username,
      },
      {
        method: "oauth",
        oauth: { providerId: "github", profile: { login: username } },
      },
    );

    expect(created.username).toBe(username);
  });
});

function authRequest(path: string, body: object): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://localhost",
    },
    body: JSON.stringify(body),
  });
}
