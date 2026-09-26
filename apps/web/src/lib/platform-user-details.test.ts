import { describe, expect, it } from "vitest";
import {
  platformUserOrigin,
  restorePreview,
  type PlatformUserDetails,
  type PlatformUserSignInMethod,
} from "./platform-user-details";

const REVOKED_AT = 1_000;

function method(
  providerId: string,
  linkedAt: number,
  blocker: PlatformUserSignInMethod["blocker"] = null,
): PlatformUserSignInMethod {
  return {
    providerId,
    kind: providerId === "github" ? "github" : "organization",
    organization: providerId === "github" ? null : { id: `${providerId}-org`, name: providerId },
    linkedAt,
    blocker,
  };
}

function revokedUser(overrides: Partial<PlatformUserDetails> = {}): PlatformUserDetails {
  return {
    id: "person",
    name: "Person",
    email: "person@example.test",
    image: null,
    username: "person",
    role: "user",
    createdAt: 1,
    origin: { kind: "github" },
    access: "revoked",
    canSignIn: false,
    signInMethods: [],
    memberships: [],
    removals: [],
    revocation: {
      revocationId: "revocation-1",
      revokedAt: REVOKED_AT,
      revokedBy: null,
      reason: "admin_revoked",
      cleanup: "completed",
      cleanupStartedAt: 1_001,
      cleanupCompletedAt: 1_002,
    },
    sshKeyCount: 0,
    appCount: 0,
    history: { events: [], truncated: false },
    ...overrides,
  };
}

describe("platformUserOrigin", () => {
  it("names GitHub, an organization, and one that is gone", () => {
    expect(platformUserOrigin(null, null)).toEqual({ kind: "github" });
    expect(platformUserOrigin("org-a", "Org A")).toEqual({
      kind: "organization",
      organization: { id: "org-a", name: "Org A" },
    });
    expect(platformUserOrigin("org-gone", null)).toEqual({
      kind: "organization",
      organization: null,
    });
  });
});

describe("restorePreview", () => {
  it("says why a restore isn't available", () => {
    expect(restorePreview(revokedUser({ access: "active", revocation: null })).unavailable)
      .toBe("not_revoked");
    expect(restorePreview(revokedUser({ revocation: null })).unavailable).toBe("no_revocation");
    for (const cleanup of ["pending", "running"] as const) {
      expect(
        restorePreview(
          revokedUser({ revocation: { ...revokedUser().revocation!, cleanup, cleanupCompletedAt: null } }),
        ).unavailable,
      ).toBe("cleanup_unfinished");
    }
    expect(restorePreview(revokedUser()).unavailable).toBeNull();
  });

  it("splits methods by whether they work once the person is a user again", () => {
    const github = method("github", 10);
    const adminOnly = method("org-a", 11, "admin_requires_github");
    const removed = method("org-b", 12, "removed_from_organization");
    const gone = method("org-c", 13, "provider_removed");
    const preview = restorePreview(
      revokedUser({ role: "admin", signInMethods: [github, adminOnly, removed, gone] }),
    );
    expect(preview.working).toEqual([github, adminOnly]);
    expect(preview.notWorking).toEqual([removed, gone]);
  });

  it("flags methods connected at or after the revocation, working or not", () => {
    const before = method("github", REVOKED_AT - 1);
    const at = method("org-a", REVOKED_AT);
    const after = method("org-b", REVOKED_AT + 1, "removed_from_organization");
    expect(
      restorePreview(revokedUser({ signInMethods: [before, at, after] })).linkedAfterRevocation,
    ).toEqual([at, after]);
    expect(
      restorePreview(revokedUser({ revocation: null, signInMethods: [at] })).linkedAfterRevocation,
    ).toEqual([]);
  });

  it("keeps only the organization the person alone owns", () => {
    const owned = {
      organization: { id: "org-a", name: "Org A" },
      role: "owner" as const,
      soleOwner: true,
      joinedAt: 1,
    };
    const joined = { ...owned, organization: { id: "org-b", name: "Org B" }, role: "member" as const, soleOwner: false };
    const preview = restorePreview(revokedUser({ memberships: [owned, joined] }));
    expect(preview.keptMemberships).toEqual([owned]);
    expect(preview.removedMemberships).toEqual([joined]);
  });
});
