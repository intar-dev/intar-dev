import type { SignupStatus } from "@/lib/signup-status";

const count = new Intl.NumberFormat("en-US");

const MEMBERS_CAN_SIGN_IN = "Members can still sign in";

/** The landing page's sign-up spots line, as one static data line. */
export function signupSpotsLine(status: SignupStatus): string {
  if (status.limit === 0) {
    return `Sign-ups are closed · ${MEMBERS_CAN_SIGN_IN}`;
  }
  if (!status.open) {
    return status.limit === 1
      ? `The only spot is taken · ${MEMBERS_CAN_SIGN_IN}`
      : `All ${count.format(status.limit)} spots are taken · ${MEMBERS_CAN_SIGN_IN}`;
  }
  const spots = status.limit === 1 ? "spot" : "spots";
  return `${count.format(status.remaining)} of ${count.format(status.limit)} ${spots} left`;
}
