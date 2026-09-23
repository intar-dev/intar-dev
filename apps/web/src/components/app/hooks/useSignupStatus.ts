import { useQuery } from "@tanstack/react-query";
import { parseSignupStatus, type SignupStatus } from "@/lib/signup-status";
import { useSession } from "./useSession";

export const SIGNUP_STATUS_STALE_TIME_MS = 30_000;

export const signupStatusQueryKey = ["signups", "status"] as const;

export async function fetchSignupStatus(
  signal?: AbortSignal,
): Promise<SignupStatus> {
  const response = await fetch("/api/signups", {
    method: "GET",
    cache: "no-store",
    signal: signal ?? null,
  });
  if (!response.ok) {
    throw new Error(`Failed to load sign-up spots (${response.status})`);
  }
  const status = parseSignupStatus(await response.json().catch(() => null));
  if (!status) throw new Error("The sign-up status response is invalid");
  return status;
}

export function signupStatusQueryOptions(options: { enabled: boolean }) {
  return {
    queryKey: signupStatusQueryKey,
    queryFn: ({ signal }: { signal: AbortSignal }) => fetchSignupStatus(signal),
    staleTime: SIGNUP_STATUS_STALE_TIME_MS,
    retry: 1,
    enabled: options.enabled,
  };
}

/** Spots matter only to visitors who are known to be signed out. */
export function signupStatusEnabled(session: {
  isSuccess: boolean;
  data?: { user?: unknown } | null | undefined;
}): boolean {
  return session.isSuccess && !session.data?.user;
}

export function useSignupStatus() {
  const session = useSession();
  return useQuery(
    signupStatusQueryOptions({ enabled: signupStatusEnabled(session) }),
  );
}
