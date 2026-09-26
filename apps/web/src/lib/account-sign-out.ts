import { sql, type SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { oauthAccessToken, oauthRefreshToken, session } from "@/db/schema";

// Signing out deletes sessions and OAuth tokens in the batch that takes access
// away: a refused change signs nobody out, and a session refreshed meanwhile
// goes too. Better Auth's session delete hook would add back-channel logout,
// but its OAuth provider sends that with fetch(..., { redirect: "error" }),
// which Workers rejects. Tokens go first: deleting a session would otherwise
// rewrite each of its tokens (ON DELETE SET NULL) just before they're deleted.
// A person's sessions include the ones they opened as someone else, as an
// admin impersonating them; those can't authorize apps, so they hold no tokens.
const SIGN_OUT_TABLES = {
  oauth_access_token: oauthAccessToken,
  oauth_refresh_token: oauthRefreshToken,
  session,
};
const SIGN_OUT_TARGETS: ReadonlyArray<{
  table: keyof typeof SIGN_OUT_TABLES;
  userColumn: string;
}> = [
  { table: "oauth_access_token", userColumn: "oauth_access_token.user_id" },
  { table: "oauth_refresh_token", userColumn: "oauth_refresh_token.user_id" },
  { table: "session", userColumn: "session.user_id" },
  { table: "session", userColumn: "session.impersonated_by" },
];

/**
 * Statements for the D1 batch whose other writes take access away. They sign
 * out every user `condition` selects, except for `keepSessionId`. `condition`
 * gets the column that names the signed-out user in each statement, and uses
 * numbered placeholders bound to `bindings`.
 */
export function signOutStatements(
  d1: D1Database,
  condition: (userColumn: string) => string,
  bindings: readonly unknown[],
  keepSessionId?: string,
): D1PreparedStatement[] {
  return SIGN_OUT_TARGETS.map(({ table, userColumn }) => {
    const keep = table === "session" && keepSessionId !== undefined;
    return d1
      .prepare(
        `DELETE FROM ${table} WHERE ${condition(userColumn)}${
          keep ? ` AND session.id <> ?${bindings.length + 1}` : ""
        }`,
      )
      .bind(...bindings, ...(keep ? [keepSessionId] : []));
  });
}

/** signOutStatements for a drizzle batch. */
export function signOutQueries(
  db: DrizzleD1Database,
  condition: (userColumn: SQL) => SQL,
) {
  const [first, ...rest] = SIGN_OUT_TARGETS.map(({ table, userColumn }) =>
    db.delete(SIGN_OUT_TABLES[table]).where(condition(sql.raw(userColumn))),
  );
  // Typed as non-empty, so a batch may start with them.
  return [first!, ...rest] as const;
}

/**
 * Statements that end every credential an account could still hold or redeem
 * once it loses access: its sessions and OAuth tokens (signOutStatements), app
 * consents and authorization codes, unclaimed server registrations, and a
 * pending image preparation. Revocation cleanup runs them, and a restore runs
 * them again for anything that raced in. `?1` is the user id; `guard` uses the
 * numbered placeholders bound to `bindings` and must name the last of them.
 */
export function accountCredentialSweepStatements(
  d1: D1Database,
  guard: string,
  bindings: readonly unknown[],
  now: number,
): D1PreparedStatement[] {
  const nowParameter = `?${bindings.length + 1}`;
  return [
    ...signOutStatements(
      d1,
      (userColumn) => `${userColumn} = ?1 AND ${guard}`,
      bindings,
    ),
    d1
      .prepare(`DELETE FROM oauth_consent WHERE user_id = ?1 AND ${guard}`)
      .bind(...bindings),
    d1
      .prepare(
        `DELETE FROM verification
         WHERE CASE
                 WHEN json_valid(value)
                 THEN json_extract(value, '$.type')
               END = 'authorization_code'
           AND CASE
                 WHEN json_valid(value)
                 THEN json_extract(value, '$.userId')
               END = ?1
           AND ${guard}`,
      )
      .bind(...bindings),
    // Registration tokens are bearer credentials that only recheck the
    // owner's status when claimed, so they must not outlive the access.
    d1
      .prepare(
        `UPDATE host_enrollments SET revoked_at = ${nowParameter}
         WHERE user_id = ?1 AND claimed_at IS NULL AND revoked_at IS NULL
           AND ${guard}`,
      )
      .bind(...bindings, now),
    d1
      .prepare(
        `DELETE FROM personal_image_preparations WHERE user_id = ?1 AND ${guard}`,
      )
      .bind(...bindings),
  ];
}
