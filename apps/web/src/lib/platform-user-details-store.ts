import {
  activeAccountSql,
  adminRoleSql,
  identitySignInBlockerSql,
  soleOwnerMembershipSql,
  usableIdentityExistsSql,
  type IdentitySignInBlocker,
} from "@/lib/account-access";
import {
  PLATFORM_USER_HISTORY_LIMIT,
  platformUserOrigin,
  type PlatformUserActor,
  type PlatformUserDetails,
  type PlatformUserMembership,
} from "@/lib/platform-user-details";

interface ProfileRow {
  id: string;
  name: string;
  email: string;
  image: string | null;
  username: string | null;
  createdAt: number;
  admin: number;
  active: number;
  canSignIn: number;
  signupOrganizationId: string | null;
  signupOrganizationName: string | null;
  sshKeyCount: number;
  appCount: number;
  revocationId: string | null;
  revokedAt: number | null;
  revocationReason: string | null;
  revokedById: string | null;
  revokedByName: string | null;
  cleanupAttemptId: string | null;
  cleanupStartedAt: number | null;
  cleanupCompletedAt: number | null;
}

interface SignInMethodRow {
  providerId: string;
  linkedAt: number;
  organizationId: string | null;
  organizationName: string | null;
  blocker: IdentitySignInBlocker | null;
}

interface MembershipRow {
  organizationId: string;
  organizationName: string;
  role: string | null;
  soleOwner: number;
  joinedAt: number;
}

interface RemovalRow {
  organizationId: string;
  organizationName: string;
  removedAt: number;
  removedById: string | null;
  removedByName: string | null;
}

interface EventRow {
  id: string;
  type: string;
  at: number;
  reason: string | null;
  actorId: string | null;
  actorName: string | null;
}

/**
 * An administrator's view of a person, read in one batch so every part comes
 * from the same moment. Null for a missing or deleted user. Columns are listed
 * one by one: provider tokens, provider subjects, session tokens, IPs, and
 * user agents never leave the database here.
 */
export async function getPlatformUserDetails(
  d1: D1Database,
  userId: string,
): Promise<PlatformUserDetails | null> {
  const id = userId.trim();
  if (!id || id.length > 255) return null;

  const [profile, methods, memberships, removals, events] = await d1.batch<
    unknown
  >([
    d1
      .prepare(
        `SELECT target.id, target.name, target.email, target.image, target.username,
                target.created_at AS createdAt,
                ${adminRoleSql("target")} AS admin,
                ${activeAccountSql("target")} AS active,
                ${activeAccountSql("target")}
                  AND ${usableIdentityExistsSql("target.id")} AS canSignIn,
                target.signup_organization_id AS signupOrganizationId,
                signup_organization.name AS signupOrganizationName,
                (SELECT count(*) FROM user_ssh_keys WHERE user_id = target.id) AS sshKeyCount,
                (SELECT count(*) FROM oauth_client WHERE user_id = target.id) AS appCount,
                revocation.revocation_id AS revocationId,
                revocation.revoked_at AS revokedAt,
                revocation.reason AS revocationReason,
                revoker.id AS revokedById,
                revoker.name AS revokedByName,
                revocation.cleanup_attempt_id AS cleanupAttemptId,
                revocation.cleanup_started_at AS cleanupStartedAt,
                revocation.cleanup_completed_at AS cleanupCompletedAt
         FROM user AS target
         LEFT JOIN organization AS signup_organization
           ON signup_organization.id = target.signup_organization_id
         LEFT JOIN access_revocations AS revocation ON revocation.user_id = target.id
         LEFT JOIN user AS revoker ON revoker.id = revocation.revoked_by
         WHERE target.id = ?1 AND target.deleted_at IS NULL`,
      )
      .bind(id),
    d1
      .prepare(
        `SELECT identity.provider_id AS providerId,
                identity.created_at AS linkedAt,
                identity_organization.id AS organizationId,
                identity_organization.name AS organizationName,
                ${identitySignInBlockerSql("identity")} AS blocker
         FROM account AS identity
         LEFT JOIN sso_provider AS identity_provider
           ON identity_provider.provider_id = identity.provider_id
         LEFT JOIN organization AS identity_organization
           ON identity_organization.id = identity_provider.organization_id
         WHERE identity.user_id = ?1
         ORDER BY identity.created_at, identity.id`,
      )
      .bind(id),
    d1
      .prepare(
        `SELECT membership.organization_id AS organizationId,
                member_organization.name AS organizationName,
                membership.role,
                ${soleOwnerMembershipSql("membership")} AS soleOwner,
                membership.created_at AS joinedAt
         FROM member AS membership
         JOIN organization AS member_organization
           ON member_organization.id = membership.organization_id
         WHERE membership.user_id = ?1
         ORDER BY membership.created_at, membership.id`,
      )
      .bind(id),
    d1
      .prepare(
        `SELECT removal.organization_id AS organizationId,
                removed_from.name AS organizationName,
                removal.removed_at AS removedAt,
                remover.id AS removedById,
                remover.name AS removedByName
         FROM organization_member_removals AS removal
         JOIN organization AS removed_from ON removed_from.id = removal.organization_id
         LEFT JOIN user AS remover ON remover.id = removal.removed_by
         WHERE removal.user_id = ?1
         ORDER BY removal.removed_at DESC, removal.organization_id`,
      )
      .bind(id),
    d1
      .prepare(
        `SELECT access_event.id, access_event.event_type AS type,
                access_event.created_at AS at, access_event.reason,
                actor.id AS actorId, actor.name AS actorName
         FROM access_events AS access_event
         LEFT JOIN user AS actor ON actor.id = access_event.actor_user_id
         WHERE access_event.subject_user_id = ?1
         ORDER BY access_event.created_at DESC, access_event.id DESC
         LIMIT ?2`,
      )
      .bind(id, PLATFORM_USER_HISTORY_LIMIT + 1),
  ]);

  const row = (profile?.results as ProfileRow[] | undefined)?.[0];
  if (!row) return null;
  const eventRows = (events?.results ?? []) as EventRow[];

  return {
    id: row.id,
    name: row.name,
    email: row.email,
    image: row.image,
    username: row.username,
    role: row.admin === 1 ? "admin" : "user",
    createdAt: row.createdAt,
    origin: platformUserOrigin(
      row.signupOrganizationId,
      row.signupOrganizationName,
    ),
    access: row.active === 1 ? "active" : "revoked",
    canSignIn: row.canSignIn === 1,
    signInMethods: ((methods?.results ?? []) as SignInMethodRow[]).map(
      (method) => ({
        providerId: method.providerId,
        kind: method.providerId === "github" ? "github" : "organization",
        organization:
          method.organizationId !== null && method.organizationName !== null
            ? { id: method.organizationId, name: method.organizationName }
            : null,
        linkedAt: method.linkedAt,
        blocker: method.blocker,
      }),
    ),
    memberships: ((memberships?.results ?? []) as MembershipRow[]).map(
      (membership) => ({
        organization: {
          id: membership.organizationId,
          name: membership.organizationName,
        },
        role: organizationRole(membership.role),
        soleOwner: membership.soleOwner === 1,
        joinedAt: membership.joinedAt,
      }),
    ),
    removals: ((removals?.results ?? []) as RemovalRow[]).map((removal) => ({
      organization: {
        id: removal.organizationId,
        name: removal.organizationName,
      },
      removedAt: removal.removedAt,
      removedBy: actor(removal.removedById, removal.removedByName),
    })),
    revocation:
      row.revocationId !== null && row.revokedAt !== null
        ? {
            revocationId: row.revocationId,
            revokedAt: row.revokedAt,
            revokedBy: actor(row.revokedById, row.revokedByName),
            reason: row.revocationReason ?? "",
            cleanup:
              row.cleanupCompletedAt !== null
                ? "completed"
                : row.cleanupAttemptId !== null
                  ? "running"
                  : "pending",
            cleanupStartedAt: row.cleanupStartedAt,
            cleanupCompletedAt: row.cleanupCompletedAt,
          }
        : null,
    sshKeyCount: row.sshKeyCount,
    appCount: row.appCount,
    history: {
      events: eventRows
        .slice(0, PLATFORM_USER_HISTORY_LIMIT)
        .map((event) => ({
          id: event.id,
          type: event.type,
          at: event.at,
          actor: actor(event.actorId, event.actorName),
          reason: event.reason,
        })),
      truncated: eventRows.length > PLATFORM_USER_HISTORY_LIMIT,
    },
  };
}

function actor(
  id: string | null,
  name: string | null,
): PlatformUserActor | null {
  return id !== null && name !== null ? { id, name } : null;
}

function organizationRole(role: string | null): PlatformUserMembership["role"] {
  const roles = (role ?? "").toLowerCase().replace(/\s/gu, "").split(",");
  if (roles.includes("owner")) return "owner";
  if (roles.includes("admin")) return "admin";
  return "member";
}
