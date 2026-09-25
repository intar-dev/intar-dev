import { useQuery } from "@tanstack/react-query";
import {
  appBootstrapQueryOptions,
  type AppBootstrapData,
} from "@/lib/app-bootstrap";

export function sessionQueryOptions() {
  return {
    ...appBootstrapQueryOptions(),
    select: (bootstrap: AppBootstrapData) => bootstrap.session,
  };
}

export function useSession() {
  return useQuery(sessionQueryOptions());
}

/**
 * The session and what it may do: "stranded" is a session the server no
 * longer lets act. It is refused everywhere, a new sign-in included, so
 * signing out is the only way on.
 */
export type SessionAccess = "signed-out" | "active" | "stranded";

export function useSessionAccess() {
  const bootstrap = useQuery(appBootstrapQueryOptions());
  const session = bootstrap.data?.session ?? null;
  const access: SessionAccess = !session?.user
    ? "signed-out"
    : bootstrap.data?.access === "active"
      ? "active"
      : "stranded";
  return { session, access, isLoading: bootstrap.isLoading };
}
