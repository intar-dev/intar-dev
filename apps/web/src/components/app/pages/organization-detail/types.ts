export type OrganizationRole = "owner" | "admin" | "member";

export interface OrganizationDetailResponse {
  organization: {
    id: string;
    name: string;
    slug: string;
    createdAt: number;
    role: OrganizationRole;
    members: Array<{
      memberId: string;
      userId: string;
      name: string;
      email: string;
      githubUsername: string | null;
      role: OrganizationRole;
      joinedAt: number;
    }>;
  };
}

export interface AssignmentsResponse {
  assignments: Array<{
    id: string;
    scenarioId: string;
    scenarioTitle: string | null;
    createdAt: number;
    lecture?: {
      courseId: string;
      lectureId: string;
      title: string;
      state: "locked" | "available" | "waiting_for_scenario" | "in_progress" | "completed";
      blockedBy: {
        courseId: string;
        lectureId: string;
        title: string;
      } | null;
      scope: "organization-public" | "organization-private";
    } | null;
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
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

export async function mutationResponse(
  response: Response,
  fallback: string,
): Promise<void> {
  if (response.ok || response.status === 204) return;
  const body = (await response.json().catch(() => null)) as {
    error?: string;
  } | null;
  throw new Error(body?.error ?? `${fallback} (${response.status})`);
}

export function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}
