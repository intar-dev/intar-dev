// Sign-up counts shared by the worker, the landing page, and the admin UI.
// Keep this module free of worker imports; it ships in the client bundle.

export const SIGNUP_LIMIT_MAX = 1_000_000;

export interface SignupStatus {
  limit: number;
  taken: number;
  remaining: number;
  open: boolean;
}

export interface AdminSignupStatus extends SignupStatus {
  /** 0 until an administrator saves the first limit. */
  version: number;
  updatedAt: number | null;
}

export function signupStatusFromCounts(
  limit: number,
  taken: number,
): SignupStatus {
  const remaining = Math.max(0, limit - taken);
  return { limit, taken, remaining, open: remaining > 0 };
}

export function isValidSignupLimit(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= SIGNUP_LIMIT_MAX
  );
}

export function parseSignupStatus(value: unknown): SignupStatus | null {
  if (!isRecord(value)) return null;
  const { limit, taken } = value;
  if (!isValidSignupLimit(limit) || !isCount(taken)) return null;
  return signupStatusFromCounts(limit, taken);
}

export function parseAdminSignupStatus(
  value: unknown,
): AdminSignupStatus | null {
  const status = parseSignupStatus(value);
  if (!status || !isRecord(value)) return null;
  const { version, updatedAt } = value;
  if (!isCount(version)) return null;
  if (updatedAt !== null && !isCount(updatedAt)) return null;
  return { ...status, version, updatedAt };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
