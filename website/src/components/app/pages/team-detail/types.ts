export type TeamRole = "owner" | "admin" | "member";

export interface TeamDetailResponse {
  team: {
    id: string;
    name: string;
    slug: string;
    createdAt: number;
    role: TeamRole;
    members: Array<{
      memberId: string;
      userId: string;
      name: string;
      githubUsername: string | null;
      role: TeamRole;
      joinedAt: number;
    }>;
    invites: Array<{
      id: string;
      githubUsername: string;
      status: string;
      createdAt: number;
    }>;
  };
}

export interface AssignmentsResponse {
  assignments: Array<{
    id: string;
    scenarioId: string;
    scenarioTitle: string | null;
    createdAt: number;
  }>;
}

export interface ProgressResponse {
  progress: {
    scenarios: Array<{ scenarioId: string; title: string | null }>;
    rows: Array<{
      userId: string;
      name: string;
      githubUsername: string | null;
      cells: Array<{
        scenarioId: string;
        status: "not_started" | "in_progress" | "solved" | "assisted";
        solveDurationMs: number | null;
        runId: string | null;
      }>;
    }>;
  };
}

export async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { method: "GET", credentials: "include" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  const letters = parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return letters || "?";
}
