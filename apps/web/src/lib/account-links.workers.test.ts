/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetD1Database } from "@/test/d1-migrations";
import { disconnectIdentity, listLinkedIdentities } from "./account-links";

const request = new Request("http://localhost/api/account-links/org-a-idp", {
  method: "DELETE",
});

// A test that fails before its spied batch runs must not leave the spy armed.
afterEach(() => vi.restoreAllMocks());

beforeEach(async () => {
  await resetD1Database();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user (id, name, email) VALUES ('person', 'Person', 'person@example.test'), ('org-only', 'Org only', 'org.only@example.test')",
    ),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, created_at) VALUES ('org-a', 'Org A', 'org-a', 1), ('org-b', 'Org B', 'org-b', 1)",
    ),
    env.DB.prepare(
      `INSERT INTO sso_provider (id, issuer, domain, oidc_config, user_id, provider_id, organization_id, domain_verified)
       VALUES ('org-a-idp-row', 'https://idp.a.test', 'a.test', '{}', 'person', 'org-a-idp', 'org-a', 1),
              ('org-b-idp-row', 'https://idp.b.test', 'b.test', '{}', 'person', 'org-b-idp', 'org-b', 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO account (id, account_id, provider_id, user_id, created_at, updated_at)
       VALUES ('person-github', 'person-gh', 'github', 'person', 1, 1),
              ('person-a', 'person-a-sub', 'org-a-idp', 'person', 2, 2),
              ('person-b', 'person-b-sub', 'org-b-idp', 'person', 3, 3),
              ('person-gone', 'person-gone-sub', 'removed-idp', 'person', 4, 4),
              ('org-only-a', 'org-only-sub', 'org-a-idp', 'org-only', 1, 1)`,
    ),
    env.DB.prepare(
      "INSERT INTO organization_member_removals (organization_id, user_id, removed_by, removed_at) VALUES ('org-b', 'person', 'person', 1)",
    ),
    env.DB.prepare(
      `INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at)
       VALUES ('current', 'current-token', 'person', 9999999999999, ?1, ?1),
              ('elsewhere', 'elsewhere-token', 'person', 9999999999999, 1, 1)`,
    ).bind(Date.now()),
  ]);
});

describe("linked identities", () => {
  it("names each organization and says which can still sign in", async () => {
    await expect(listLinkedIdentities("person")).resolves.toEqual([
      {
        providerId: "github",
        kind: "github",
        organization: null,
        linkedAt: 1,
        usable: true,
        removed: false,
      },
      {
        providerId: "org-a-idp",
        kind: "organization",
        organization: { name: "Org A", slug: "org-a" },
        linkedAt: 2,
        usable: true,
        removed: false,
      },
      // Org B removed the person.
      {
        providerId: "org-b-idp",
        kind: "organization",
        organization: { name: "Org B", slug: "org-b" },
        linkedAt: 3,
        usable: false,
        removed: true,
      },
      // Its provider no longer exists.
      {
        providerId: "removed-idp",
        kind: "organization",
        organization: null,
        linkedAt: 4,
        usable: false,
        removed: false,
      },
    ]);
  });

  it("disconnects an organization and signs out every other session", async () => {
    // An app connected through the other session is signed out too.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO oauth_client (id, client_id, redirect_uris)
         VALUES ('app-row', 'app', '["http://localhost/callback"]')`,
      ),
      env.DB.prepare(
        `INSERT INTO oauth_access_token (id, token, client_id, session_id, user_id, expires_at, scopes)
         VALUES ('app-access', 'app-access-token', 'app', 'elsewhere', 'person', 9999999999999, '["openid"]')`,
      ),
    ]);
    await disconnectIdentity({
      request,
      userId: "person",
      providerId: "org-a-idp",
      currentSessionId: "current",
    });

    await expect(
      env.DB.prepare("SELECT id FROM account WHERE id = 'person-a'").first(),
    ).resolves.toBeNull();
    await expect(
      env.DB.prepare("SELECT id FROM session WHERE user_id = 'person'").all(),
    ).resolves.toMatchObject({ results: [{ id: "current" }] });
    await expect(
      env.DB.prepare("SELECT count(*) AS count FROM oauth_access_token").first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("disconnects GitHub while another way to sign in remains", async () => {
    await env.DB.prepare(
      "UPDATE user SET username = 'person-gh', display_username = 'Person-GH' WHERE id = 'person'",
    ).run();
    await disconnectIdentity({
      request,
      userId: "person",
      providerId: "github",
      currentSessionId: "current",
    });

    await expect(
      env.DB.prepare("SELECT id FROM account WHERE id = 'person-github'").first(),
    ).resolves.toBeNull();
    await expect(
      env.DB.prepare("SELECT id FROM session WHERE user_id = 'person'").all(),
    ).resolves.toMatchObject({ results: [{ id: "current" }] });
    // The username came from GitHub, so its login is free again.
    await expect(
      env.DB.prepare(
        "SELECT username, display_username AS displayUsername FROM user WHERE id = 'person'",
      ).first(),
    ).resolves.toEqual({ username: null, displayUsername: null });
  });

  it("refuses to disconnect while an admin impersonates the person", async () => {
    await env.DB.prepare(
      "UPDATE session SET impersonated_by = 'platform-admin' WHERE id = 'current'",
    ).run();
    await expect(
      disconnectIdentity({
        request,
        userId: "person",
        providerId: "github",
        currentSessionId: "current",
      }),
    ).rejects.toMatchObject({ status: 403, code: "impersonation_unlink_forbidden" });
    await expect(
      env.DB.prepare("SELECT id FROM account WHERE id = 'person-github'").first(),
    ).resolves.toEqual({ id: "person-github" });
  });

  it("keeps an identity the organization removed the person through", async () => {
    // Without it, the same login could sign up again as someone new.
    await expect(
      disconnectIdentity({
        request,
        userId: "person",
        providerId: "org-b-idp",
        currentSessionId: "current",
      }),
    ).rejects.toMatchObject({ status: 409, code: "identity_removed" });
    await expect(
      env.DB.prepare("SELECT id FROM account WHERE id = 'person-b'").first(),
    ).resolves.toEqual({ id: "person-b" });
  });

  it("signs nobody out when the disconnect is refused", async () => {
    const batch = env.DB.batch.bind(env.DB);
    // GitHub goes while the disconnect runs, which leaves no other way in.
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await env.DB.prepare("DELETE FROM account WHERE id = 'person-github'").run();
      return batch(statements);
    });

    await expect(
      disconnectIdentity({
        request,
        userId: "person",
        providerId: "org-a-idp",
        currentSessionId: "current",
      }),
    ).rejects.toMatchObject({ status: 409, code: "last_sign_in_method" });
    await expect(
      env.DB.prepare(
        "SELECT count(*) AS count FROM session WHERE user_id = 'person' AND expires_at = 9999999999999",
      ).first(),
    ).resolves.toEqual({ count: 2 });
  });

  it("disconnects only from a recent sign-in", async () => {
    await env.DB.prepare("UPDATE session SET created_at = 1 WHERE id = 'current'").run();
    await expect(
      disconnectIdentity({
        request,
        userId: "person",
        providerId: "github",
        currentSessionId: "current",
      }),
    ).rejects.toMatchObject({ status: 403, code: "session_not_fresh" });
    await expect(
      env.DB.prepare("SELECT count(*) AS count FROM session WHERE user_id = 'person'").first(),
    ).resolves.toEqual({ count: 2 });
    await expect(
      env.DB.prepare("SELECT id FROM account WHERE id = 'person-github'").first(),
    ).resolves.toEqual({ id: "person-github" });
  });

  it("signs nobody out when another tab's disconnect took the identity first", async () => {
    await env.DB.prepare(
      `INSERT INTO session (id, token, user_id, expires_at, created_at, updated_at)
       VALUES ('other-tab', 'other-tab-token', 'person', 9999999999999, ?1, ?1)`,
    )
      .bind(Date.now())
      .run();
    const batch = env.DB.batch.bind(env.DB);
    // The other tab disconnects GitHub between this one's checks and batch.
    vi.spyOn(env.DB, "batch").mockImplementationOnce(async (statements) => {
      await disconnectIdentity({
        request,
        userId: "person",
        providerId: "github",
        currentSessionId: "other-tab",
      });
      return batch(statements);
    });

    await expect(
      disconnectIdentity({
        request,
        userId: "person",
        providerId: "github",
        currentSessionId: "current",
      }),
    ).rejects.toMatchObject({ status: 404, code: "identity_not_found" });
    // The other tab signed this one out and stays signed in itself.
    await expect(
      env.DB.prepare("SELECT id FROM session WHERE user_id = 'person'").all(),
    ).resolves.toMatchObject({ results: [{ id: "other-tab" }] });
  });

  it("keeps the last way to sign in", async () => {
    await expect(
      disconnectIdentity({
        request,
        userId: "org-only",
        providerId: "org-a-idp",
        currentSessionId: "org-only-session",
      }),
    ).rejects.toMatchObject({ status: 409, code: "last_sign_in_method" });
    await expect(
      env.DB.prepare("SELECT id FROM account WHERE id = 'org-only-a'").first(),
    ).resolves.toEqual({ id: "org-only-a" });
  });

  it("disconnects only identities the account has", async () => {
    for (const [userId, providerId] of [
      ["person", "org-b-idp-unknown"],
      ["org-only", "github"],
    ] as const) {
      await expect(
        disconnectIdentity({
          request,
          userId,
          providerId,
          currentSessionId: "current",
        }),
      ).rejects.toMatchObject({ status: 404, code: "identity_not_found" });
    }
    await expect(
      env.DB.prepare("SELECT count(*) AS count FROM session WHERE user_id = 'person'").first(),
    ).resolves.toEqual({ count: 2 });
  });
});
