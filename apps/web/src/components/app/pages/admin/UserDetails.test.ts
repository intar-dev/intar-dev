import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  restorePreview,
  type PlatformUserDetails,
  type PlatformUserSignInMethod,
} from "@/lib/platform-user-details";
import {
  AccessHistoryList,
  accessEventLabel,
  RestoreAccessSummary,
  SignInMethodList,
  signInSummary,
} from "./UserDetails";
import { revokeAccessDescription, signupOriginText } from "./user-access";

const REVOKED_AT = Date.now() - 3 * 86_400_000;

function method(
  providerId: string,
  name: string | null,
  linkedAt: number,
  blocker: PlatformUserSignInMethod["blocker"] = null,
): PlatformUserSignInMethod {
  return {
    providerId,
    kind: providerId === "github" ? "github" : "organization",
    organization: name === null ? null : { id: `${providerId}-org`, name },
    linkedAt,
    blocker,
  };
}

function person(overrides: Partial<PlatformUserDetails> = {}): PlatformUserDetails {
  return {
    id: "user-blocked",
    name: "Blake Blocked",
    email: "blake@example.test",
    image: null,
    username: "blake",
    role: "user",
    createdAt: REVOKED_AT - 20 * 86_400_000,
    origin: { kind: "organization", organization: { id: "org-platform", name: "Platform Repair Crew" } },
    access: "revoked",
    canSignIn: false,
    signInMethods: [
      method("platform-idp", "Platform Repair Crew", REVOKED_AT - 10 * 86_400_000),
      method("contoso-idp", "Contoso Labs", REVOKED_AT - 5 * 86_400_000, "removed_from_organization"),
      method("gone-idp", null, REVOKED_AT - 4 * 86_400_000, "provider_removed"),
      method("github", null, REVOKED_AT + 86_400_000),
    ],
    memberships: [
      {
        organization: { id: "org-platform", name: "Platform Repair Crew" },
        role: "member",
        soleOwner: false,
        joinedAt: REVOKED_AT - 10 * 86_400_000,
      },
      {
        organization: { id: "org-own", name: "Blake's Lab" },
        role: "owner",
        soleOwner: true,
        joinedAt: REVOKED_AT - 9 * 86_400_000,
      },
    ],
    removals: [],
    revocation: {
      revocationId: "revocation-user-blocked",
      revokedAt: REVOKED_AT,
      revokedBy: { id: "admin", name: "Ada Administrator" },
      reason: "admin_revoked",
      cleanup: "completed",
      cleanupStartedAt: REVOKED_AT + 1,
      cleanupCompletedAt: REVOKED_AT + 2,
    },
    sshKeyCount: 2,
    appCount: 1,
    history: { events: [], truncated: false },
    ...overrides,
  };
}

describe("sign-in methods", () => {
  it("says which methods work after a restore and why the others don't", () => {
    const blocked = person();
    const markup = renderToStaticMarkup(
      createElement(SignInMethodList, { person: blocked, preview: restorePreview(blocked) }),
    );
    expect(markup).toContain("Platform Repair Crew");
    expect(markup).toContain("Works after restore");
    expect(markup).toContain("The organization removed them.");
    expect(markup).toContain("Removed identity provider");
    expect(markup).toContain("Its identity provider was removed.");
    expect(markup).toContain("@blake");
    // Only GitHub was connected after the revocation.
    expect(markup.match(/Connected after access was revoked/gu)).toHaveLength(1);
    // Provider ids are keys, never shown.
    expect(markup).not.toContain("contoso-idp");
  });

  it("marks working methods of an active account without warnings", () => {
    const active = person({
      access: "active",
      canSignIn: true,
      revocation: null,
      signInMethods: [method("github", null, 1)],
    });
    const markup = renderToStaticMarkup(
      createElement(SignInMethodList, { person: active, preview: restorePreview(active) }),
    );
    expect(markup).toContain("Works");
    expect(markup).not.toContain("after restore");
    expect(markup).not.toContain("Connected after access was revoked");
  });

  it("explains why an account can't sign in", () => {
    expect(signInSummary(person())).toBe("Can't sign in · access is revoked");
    expect(signInSummary(person({ access: "active", canSignIn: true }))).toBe("Can sign in");
    expect(signInSummary(person({ access: "active", signInMethods: [] }))).toBe(
      "Can't sign in · no sign-in method is connected",
    );
    expect(
      signInSummary(
        person({
          access: "active",
          role: "admin",
          signInMethods: [method("platform-idp", "Platform Repair Crew", 1, "admin_requires_github")],
        }),
      ),
    ).toBe("Can't sign in · platform admins sign in with GitHub only, and none is connected");
  });
});

describe("restore summary", () => {
  it("lists what works again, what doesn't, and what a fresh start removes", () => {
    const blocked = person();
    const markup = renderToStaticMarkup(
      createElement(RestoreAccessSummary, { person: blocked, preview: restorePreview(blocked) }),
    );
    expect(markup).toContain("Will work again");
    expect(markup).toContain("Still won&#x27;t work");
    expect(markup).toContain("Check that it&#x27;s theirs.");
    expect(markup).toContain("2 SSH keys are removed.");
    expect(markup).toContain("Their app is deleted, with the access other people gave it.");
    expect(markup).toContain("They leave Platform Repair Crew.");
    expect(markup).toContain("They stay the owner of Blake&#x27;s Lab, which has no other owner.");
    expect(markup).toContain("personal servers are retired");
    expect(markup).toContain("They take a sign-up spot again.");
    expect(markup).not.toContain("admin role");
  });

  it("warns that a restored admin comes back as a user", () => {
    const admin = person({ role: "admin", sshKeyCount: 0, appCount: 0, memberships: [] });
    const markup = renderToStaticMarkup(
      createElement(RestoreAccessSummary, { person: admin, preview: restorePreview(admin) }),
    );
    expect(markup).toContain("They lose the admin role and come back as a user.");
    expect(markup).not.toContain("SSH key");
    expect(markup).not.toContain("They leave");
  });
});

describe("access history", () => {
  it("labels known events and falls back for others", () => {
    const event = { id: "e", at: 1, actor: null, reason: null };
    expect(accessEventLabel({ ...event, type: "access.blocked", reason: "admin_revoked" })).toBe("Access revoked");
    expect(accessEventLabel({ ...event, type: "access.blocked", reason: "admin_deleted" })).toBe(
      "Access revoked to delete the account",
    );
    expect(accessEventLabel({ ...event, type: "access.restored" })).toBe("Access restored");
    expect(accessEventLabel({ ...event, type: "access.revocation_cleanup_stalled" })).toBe(
      "Revocation cleanup stopped partway",
    );
    expect(accessEventLabel({ ...event, type: "something.new" })).toBe("Access record changed");
  });

  it("names actors, shows failure codes, and says when older events are cut off", () => {
    const markup = renderToStaticMarkup(
      createElement(AccessHistoryList, {
        history: {
          events: [
            { id: "restored", type: "access.restored", at: Date.now(), actor: { id: "a", name: "Ada Administrator" }, reason: "admin_restored" },
            { id: "failed", type: "access.revocation_cleanup_failed", at: Date.now() - 1000, actor: null, reason: "cleanup_d1_error" },
          ],
          truncated: true,
        },
      }),
    );
    expect(markup).toContain("Access restored");
    expect(markup).toContain("by Ada Administrator");
    expect(markup).toContain("cleanup_d1_error");
    expect(markup).not.toContain("admin_restored");
    expect(markup).toContain("Showing the 50 most recent events.");
    expect(
      renderToStaticMarkup(
        createElement(AccessHistoryList, { history: { events: [], truncated: false } }),
      ),
    ).toContain("No access changes are recorded.");
  });
});

describe("list copy", () => {
  it("says a revocation can be restored later", () => {
    const text = revokeAccessDescription({ name: "Blake Blocked", role: "user" });
    expect(text).toContain("You can restore access later from their page.");
    expect(text).not.toContain("can't be restored");
    expect(revokeAccessDescription({ name: "Ada", role: "admin" })).toContain(
      "The server keeps at least one active administrator.",
    );
  });

  it("names where a person signed up", () => {
    expect(signupOriginText({ kind: "github" })).toBe("signed up with GitHub");
    expect(
      signupOriginText({ kind: "organization", organization: { id: "o", name: "Contoso Labs" } }),
    ).toBe("signed up through Contoso Labs");
    expect(signupOriginText({ kind: "organization", organization: null })).toBe(
      "signed up through a deleted organization",
    );
  });
});
