import { QueryClient } from "@tanstack/react-query";
import type { AppSessionData } from "./auth-client";

export const APP_BOOTSTRAP_STALE_TIME_MS = 30_000;

export const appBootstrapQueryKey = ["app", "bootstrap"] as const;

export type AppBetaAccessState = "active" | "restricted";

export interface AppBootstrapData {
  session: AppSessionData | null;
  betaAccess: AppBetaAccessState;
}

export const appQueryClient = new QueryClient();

export function appBootstrapQueryOptions() {
  return {
    queryKey: appBootstrapQueryKey,
    queryFn: getClientAppBootstrap,
    staleTime: APP_BOOTSTRAP_STALE_TIME_MS,
    retry: 1,
  };
}

export async function getClientAppBootstrap(): Promise<AppBootstrapData> {
  const response = await fetch("/api/app/bootstrap", {
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("Failed to load app bootstrap state");
  }

  return parseAppBootstrapData(await response.json().catch(() => null));
}

export function parseAppBootstrapData(value: unknown): AppBootstrapData {
  if (!isRecord(value)) {
    return { session: null, betaAccess: "restricted" };
  }

  const session = isAppSessionData(value.session) ? value.session : null;
  return {
    session,
    betaAccess:
      session && value.betaAccess === "active" ? "active" : "restricted",
  };
}

function isAppSessionData(value: unknown): value is AppSessionData {
  if (!isRecord(value) || !isRecord(value.session) || !isRecord(value.user)) {
    return false;
  }

  return (
    typeof value.session.id === "string" && typeof value.user.id === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
