import { HttpResponseError } from "@/components/app/lib/http-response-error";
import type {
  PlatformUserDetails,
  PlatformUserOrigin,
} from "@/lib/platform-user-details";

// Requests an administrator makes about one person, shared by the People list
// and a person's details page. The detail key sits under the list key, so
// refreshing the list refreshes an open details page too.
export const ADMIN_USERS_KEY = ["admin", "users"] as const;
export const ADMIN_SIGNUPS_KEY = ["admin", "signups"] as const;

export function adminUserKey(userId: string) {
  return [...ADMIN_USERS_KEY, userId] as const;
}

export async function adminJson<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: { "content-type": "application/json", ...init.headers },
  });
  const result: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    throw HttpResponseError.fromBody(
      response.status,
      result,
      "User action failed",
    );
  }
  return result as T;
}

function userPath(userId: string, action?: string): string {
  const base = `/api/admin/users/${encodeURIComponent(userId)}`;
  return action ? `${base}/${action}` : base;
}

export async function fetchPlatformUserDetails(
  userId: string,
): Promise<PlatformUserDetails> {
  const { user } = await adminJson<{ user: PlatformUserDetails }>(
    userPath(userId),
    { method: "GET" },
  );
  return user;
}

export function revokeUserAccess(userId: string) {
  return adminJson<{ revocationId: string; cleanupCompleted: boolean }>(
    userPath(userId, "revoke"),
    { method: "POST" },
  );
}

export function finishRevocationCleanup(userId: string, revocationId: string) {
  return adminJson<{ revocationId: string; cleanupCompleted: boolean }>(
    userPath(userId, "revocation-cleanup"),
    { method: "POST", body: JSON.stringify({ revocationId }) },
  );
}

export function restoreUserAccess(userId: string, revocationId: string) {
  return adminJson<{ access: "active"; serversPendingCleanup: number }>(
    userPath(userId, "restore"),
    { method: "POST", body: JSON.stringify({ revocationId }) },
  );
}

/** What a revocation does, for its confirmation. */
export function revokeAccessDescription(person: {
  name: string;
  role: string | null;
}): string {
  return [
    `${person.name} is signed out everywhere, their runs stop, and their personal servers are disabled. Their spot opens for someone new.`,
    "You can restore access later from their page. They'll start fresh: ended sessions and runs don't come back.",
    person.role === "admin"
      ? "The server keeps at least one active administrator."
      : null,
  ]
    .filter(Boolean)
    .join(" ");
}

const RESTORE_MESSAGES: Readonly<Record<string, string>> = {
  access_not_revoked: "Their access is already active.",
  access_cleanup_incomplete:
    "Finish the revocation cleanup before restoring access.",
  stale_access_revocation:
    "Their access changed since you opened this. Review it, then try again.",
  user_not_found: "This user no longer exists.",
};

export function restoreErrorMessage(error: unknown): string {
  if (error instanceof HttpResponseError) {
    const known = error.code ? RESTORE_MESSAGES[error.code] : undefined;
    if (known) return known;
    if (error.status === 403) {
      return "Only an active administrator can restore access.";
    }
  }
  return error instanceof Error ? error.message : "Access could not be restored";
}

/** "signed up with GitHub", or through which organization's provider. */
export function signupOriginText(origin: PlatformUserOrigin): string {
  if (origin.kind === "github") return "signed up with GitHub";
  return origin.organization
    ? `signed up through ${origin.organization.name}`
    : "signed up through a deleted organization";
}
