import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HttpResponseError } from "@/components/app/lib/http-response-error";
import type { StatusTone } from "@/components/app/patterns/StatusToken";
import type { AdministeredScenario, MachineBuildSummary, ScenarioRevisionSummary } from "@/lib/scenario-revisions";

export type { AdministeredScenario, MachineBuildSummary, ScenarioRevisionSummary };

const SCENARIOS_KEY = ["admin-scenario-revisions"] as const;

async function getJson<T>(url: string, fallback: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw HttpResponseError.fromBody(response.status, body, fallback);
  return body as T;
}

export const scenarioUrl = (scenarioId: string) =>
  `/api/admin/scenario-revisions/${scenarioId.split("/").map(encodeURIComponent).join("/")}`;

export function useAdministeredScenarios() {
  return useQuery({
    queryKey: SCENARIOS_KEY,
    queryFn: async () =>
      (await getJson<{ scenarios: AdministeredScenario[] }>("/api/admin/scenario-revisions", "Failed to load scenarios")).scenarios,
    staleTime: 5_000,
  });
}

export function useAdministeredScenario(scenarioId: string) {
  return useQuery({
    queryKey: [...SCENARIOS_KEY, scenarioId],
    queryFn: async () => (await getJson<{ scenario: AdministeredScenario }>(scenarioUrl(scenarioId), "Failed to load the scenario")).scenario,
    // A running verify run settles on its own; poll until it has.
    refetchInterval: (query) => (Object.keys(query.state.data?.verifyRuns ?? {}).length ? 5_000 : false),
  });
}

export type RevisionAction = { action: "verify"; rev: string } | { action: "promote" | "rollback"; rev: string; liveRev: string | null };

export function useRevisionAction(scenarioId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (request: RevisionAction) => {
      const response = await fetch(scenarioUrl(scenarioId), {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw HttpResponseError.fromBody(response.status, body, `Could not ${request.action} this revision`);
      return (body as { scenario: AdministeredScenario }).scenario;
    },
    onSuccess: (scenario) => {
      queryClient.setQueryData([...SCENARIOS_KEY, scenarioId], scenario);
      void queryClient.invalidateQueries({ queryKey: SCENARIOS_KEY, exact: true });
    },
  });
}

export function useMachineBuilds() {
  return useQuery({
    queryKey: ["admin-machine-builds"],
    queryFn: async () => (await getJson<{ builds: MachineBuildSummary[] }>("/api/admin/machine-builds", "Failed to load builds")).builds,
    refetchInterval: (query) =>
      query.state.data?.some((build) => build.state !== "succeeded" && build.state !== "failed") ? 5_000 : false,
  });
}

// A build key is `sha256:<hex>`; the colon stays as is, since the Worker refuses
// an encoded path.
export const machineBuildLogUrl = (buildKey: string) => `/api/admin/machine-builds/${buildKey}/log`;

export const REVISION_STATES: Record<ScenarioRevisionSummary["state"], { word: string; tone: StatusTone }> = {
  building: { word: "Building", tone: "pending" },
  ready: { word: "Ready", tone: "muted" },
  verified: { word: "Verified", tone: "success" },
  failed: { word: "Failed", tone: "danger" },
};

/** A revision id's commit and digest, shortened for a row. */
export function shortRev(rev: string): string {
  const match = /^git-\d+-([0-9a-f]{40})-(.+)$/.exec(rev);
  return match ? `${match[1]!.slice(0, 7)}` : rev.slice(0, 16);
}
