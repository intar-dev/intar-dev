import { env } from "cloudflare:workers";
import {
  RECENT_SIGN_IN_SECONDS,
  removedFromOrganizationSql,
  removedThroughProviderSql,
  usableIdentityExistsSql,
  usableIdentitySql,
} from "@/lib/account-access";
import { signOutStatements } from "@/lib/account-sign-out";
import { appError } from "@/lib/app-error";
import { recordSecurityEvent } from "@/lib/security-events";

/** A way to sign in to an account, as its owner sees it on their profile. */
export interface LinkedIdentity {
  providerId: string;
  kind: "github" | "organization";
  /** The organization whose identity provider this is, while it exists. */
  organization: { name: string; slug: string } | null;
  linkedAt: number;
  /** Whether it can sign the person in; see usableIdentitySql. */
  usable: boolean;
  /** Its organization removed the person, who can't disconnect it until restored. */
  removed: boolean;
}

export async function listLinkedIdentities(
  userId: string,
): Promise<LinkedIdentity[]> {
  const rows = await env.DB.prepare(
    `SELECT identity.provider_id AS providerId,
            identity.created_at AS linkedAt,
            organization.name AS organizationName,
            organization.slug AS organizationSlug,
            ${usableIdentitySql("identity")} AS usable,
            ${removedFromOrganizationSql("identity.user_id", "provider.organization_id")} AS removed
     FROM account AS identity
     LEFT JOIN sso_provider AS provider
       ON provider.provider_id = identity.provider_id
     LEFT JOIN organization ON organization.id = provider.organization_id
     WHERE identity.user_id = ?1
     ORDER BY identity.created_at`,
  )
    .bind(userId)
    .all<{
      providerId: string;
      linkedAt: number;
      organizationName: string | null;
      organizationSlug: string | null;
      usable: number;
      removed: number;
    }>();
  return rows.results.map((row) => ({
    providerId: row.providerId,
    kind: row.providerId === "github" ? "github" : "organization",
    organization:
      row.organizationName !== null && row.organizationSlug !== null
        ? { name: row.organizationName, slug: row.organizationSlug }
        : null,
    linkedAt: row.linkedAt,
    usable: row.usable === 1,
    removed: row.removed === 1,
  }));
}

/**
 * Removes a sign-in method from the signed-in account, which then no longer
 * trusts that provider to sign in as it. Whoever that provider signed in may
 * still hold a session, so every other session and every OAuth token of the
 * account ends too. Like connecting one, it needs a recent sign-in. Another
 * usable way to sign in must remain, and an organization's removal of the
 * person stays bound to its identity.
 */
export async function disconnectIdentity(params: {
  request: Request;
  userId: string;
  providerId: string;
  currentSessionId: string;
}): Promise<void> {
  type State = {
    impersonating: number;
    recent: number;
    linked: number;
    otherSignIn: number;
    removed: number;
  };
  const readState = () =>
    env.DB.prepare(
      `SELECT EXISTS (SELECT 1 FROM session
           WHERE id = ?3 AND impersonated_by IS NOT NULL) AS impersonating,
         EXISTS (SELECT 1 FROM session
           WHERE id = ?3 AND created_at > ?4) AS recent,
         EXISTS (SELECT 1 FROM account
           WHERE user_id = ?1 AND provider_id = ?2) AS linked,
         ${usableIdentityExistsSql("?1", { exceptProvider: "?2" })} AS otherSignIn,
         ${removedThroughProviderSql("?1", "?2")} AS removed`,
    )
      .bind(
        params.userId,
        params.providerId,
        params.currentSessionId,
        Date.now() - RECENT_SIGN_IN_SECONDS * 1000,
      )
      .first<State>();
  const refusal = (state: State | null) => {
    // An admin impersonating someone must not change how they sign in.
    if (state?.impersonating === 1) {
      return appError(
        403,
        "impersonation_unlink_forbidden",
        "stop impersonating before disconnecting sign-in methods",
      );
    }
    if (state?.linked !== 1) {
      return appError(
        404,
        "identity_not_found",
        "that sign-in method isn't connected to this account",
      );
    }
    // Disconnecting would let the same login sign up again as someone new.
    if (state.removed === 1) {
      return appError(
        409,
        "identity_removed",
        "an organization admin removed you, so this sign-in stays connected until they restore you",
      );
    }
    if (state.otherSignIn !== 1) return lastSignInMethodError();
    if (state.recent !== 1) {
      return appError(
        403,
        "session_not_fresh",
        "sign in again to disconnect sign-in methods",
      );
    }
    return null;
  };
  const refused = refusal(await readState());
  if (refused) throw refused;

  // Every statement checks that this disconnect may still happen, before the
  // identity goes, in one transaction: a refused disconnect, or one that
  // another request already made, signs nobody out.
  const disconnectable = `EXISTS (SELECT 1 FROM account
      WHERE user_id = ?1 AND provider_id = ?2)
    AND ${usableIdentityExistsSql("?1", { exceptProvider: "?2" })}
    AND NOT ${removedThroughProviderSql("?1", "?2")}`;
  const results = await env.DB.batch([
    ...signOutStatements(
      env.DB,
      (userColumn) => `${userColumn} = ?1 AND ${disconnectable}`,
      [params.userId, params.providerId],
      params.currentSessionId,
    ),
    // Usernames come only from GitHub, so one goes with it and the login is
    // free again; the next GitHub account connected brings its own.
    env.DB.prepare(
      `UPDATE user SET username = NULL, display_username = NULL, updated_at = ?3
       WHERE id = ?1 AND ?2 = 'github' AND ${disconnectable}`,
    ).bind(params.userId, params.providerId, Date.now()),
    env.DB.prepare(
      `DELETE FROM account
       WHERE user_id = ?1 AND provider_id = ?2 AND ${disconnectable}
       RETURNING id`,
    ).bind(params.userId, params.providerId),
  ]);
  if (!results.at(-1)?.results?.length) {
    throw refusal(await readState()) ?? lastSignInMethodError();
  }
  recordSecurityEvent(params.request, {
    event: "security.identity_unlinked",
    outcome: "accepted",
    userId: params.userId,
  });
}

function lastSignInMethodError() {
  return appError(
    409,
    "last_sign_in_method",
    "connect another way to sign in before disconnecting this one",
  );
}
