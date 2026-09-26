// An administrator's view of a person, shared by the worker and the admin UI.
// Keep this module free of worker imports; it ships in the client bundle.

export type PlatformUserAccess = "active" | "revoked";

export interface PlatformUserOrganizationRef {
  id: string;
  name: string;
}

/** How the account was created: a GitHub sign-up or an organization's provider. */
export type PlatformUserOrigin =
  | { kind: "github" }
  | {
      kind: "organization";
      /** Null once that organization is gone. */
      organization: PlatformUserOrganizationRef | null;
    };

/** Why a sign-in method can't sign its person in once they have access. */
export type SignInMethodBlocker =
  | "provider_removed"
  | "removed_from_organization"
  | "admin_requires_github";

export interface PlatformUserSignInMethod {
  /** The provider id: GitHub or an organization's identity provider. */
  providerId: string;
  kind: "github" | "organization";
  /** The organization whose identity provider this is, while it exists. */
  organization: PlatformUserOrganizationRef | null;
  linkedAt: number;
  /** Null when it can sign them in, as if the account had access. */
  blocker: SignInMethodBlocker | null;
}

export interface PlatformUserActor {
  id: string;
  name: string;
}

export interface PlatformUserMembership {
  organization: PlatformUserOrganizationRef;
  role: "owner" | "admin" | "member";
  /** No other owner: a restore keeps this membership. */
  soleOwner: boolean;
  joinedAt: number;
}

export interface PlatformUserRemoval {
  organization: PlatformUserOrganizationRef;
  removedAt: number;
  removedBy: PlatformUserActor | null;
}

export interface PlatformUserRevocation {
  revocationId: string;
  revokedAt: number;
  revokedBy: PlatformUserActor | null;
  /** A normalized reason code, such as admin_revoked or admin_deleted. */
  reason: string;
  cleanup: "pending" | "running" | "completed";
  cleanupStartedAt: number | null;
  cleanupCompletedAt: number | null;
}

export interface PlatformUserAccessEvent {
  id: string;
  type: string;
  at: number;
  actor: PlatformUserActor | null;
  reason: string | null;
}

export interface PlatformUserDetails {
  id: string;
  name: string;
  email: string;
  image: string | null;
  username: string | null;
  role: "admin" | "user";
  createdAt: number;
  origin: PlatformUserOrigin;
  access: PlatformUserAccess;
  /** Active, and some sign-in method can sign them in now. */
  canSignIn: boolean;
  signInMethods: PlatformUserSignInMethod[];
  memberships: PlatformUserMembership[];
  removals: PlatformUserRemoval[];
  revocation: PlatformUserRevocation | null;
  sshKeyCount: number;
  /** Apps (OAuth clients) the person registered. */
  appCount: number;
  history: { events: PlatformUserAccessEvent[]; truncated: boolean };
}

export const PLATFORM_USER_HISTORY_LIMIT = 50;

export function platformUserOrigin(
  signupOrganizationId: string | null,
  organizationName: string | null,
): PlatformUserOrigin {
  if (signupOrganizationId === null) return { kind: "github" };
  return {
    kind: "organization",
    organization:
      organizationName === null
        ? null
        : { id: signupOrganizationId, name: organizationName },
  };
}

export type RestoreUnavailableReason =
  | "not_revoked"
  | "no_revocation"
  | "cleanup_unfinished";

export interface RestorePreview {
  unavailable: RestoreUnavailableReason | null;
  /** Methods that sign them in again once access is restored. */
  working: PlatformUserSignInMethod[];
  notWorking: PlatformUserSignInMethod[];
  /** Methods connected at or after the revocation, worth a second look. */
  linkedAfterRevocation: PlatformUserSignInMethod[];
  keptMemberships: PlatformUserMembership[];
  removedMemberships: PlatformUserMembership[];
}

/**
 * What restoring the person's access would do. A restore makes them a user,
 * so admins' GitHub-only rule no longer blocks their organization sign-in.
 */
export function restorePreview(user: PlatformUserDetails): RestorePreview {
  const revocation = user.revocation;
  const unavailable: RestoreUnavailableReason | null =
    user.access !== "revoked"
      ? "not_revoked"
      : revocation === null
        ? "no_revocation"
        : revocation.cleanup !== "completed"
          ? "cleanup_unfinished"
          : null;
  const worksAfterRestore = (method: PlatformUserSignInMethod) =>
    method.blocker === null || method.blocker === "admin_requires_github";
  return {
    unavailable,
    working: user.signInMethods.filter(worksAfterRestore),
    notWorking: user.signInMethods.filter((method) => !worksAfterRestore(method)),
    linkedAfterRevocation:
      revocation === null
        ? []
        : user.signInMethods.filter(
            (method) => method.linkedAt >= revocation.revokedAt,
          ),
    keptMemberships: user.memberships.filter((membership) => membership.soleOwner),
    removedMemberships: user.memberships.filter(
      (membership) => !membership.soleOwner,
    ),
  };
}
