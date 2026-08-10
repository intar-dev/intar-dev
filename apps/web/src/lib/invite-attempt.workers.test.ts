import { describe, expect, it } from "vitest";
import {
  newInviteAttempt,
  signInviteAttempt,
  verifyInviteAttempt,
  withInviteLease,
} from "./invite-attempt";

const secret = "test-secret-that-is-at-least-thirty-two-bytes-long";

describe("invite attempt cookie", () => {
  it("round-trips only signed, server-created state", async () => {
    const attempt = newInviteAttempt("invite_1", 1_000);
    const signed = await signInviteAttempt(attempt, secret);

    await expect(verifyInviteAttempt(signed, secret)).resolves.toEqual(attempt);
  });

  it("rejects payload tampering", async () => {
    const signed = await signInviteAttempt(newInviteAttempt("invite_1"), secret);
    const [payload, signature] = signed.split(".");
    const forgedPayload = `${payload?.slice(0, -1)}A`;

    await expect(
      verifyInviteAttempt(`${forgedPayload}.${signature}`, secret),
    ).resolves.toBeNull();
  });

  it("binds a lease without replacing the attempt identity", () => {
    const attempt = newInviteAttempt("invite_1", 1_000);
    const leased = withInviteLease(attempt, {
      leaseId: "lease_1",
      leaseExpiresAt: 700_000,
    });

    expect(leased).toMatchObject({
      attemptId: attempt.attemptId,
      inviteId: "invite_1",
      leaseId: "lease_1",
      leaseExpiresAt: 700_000,
    });
  });
});
