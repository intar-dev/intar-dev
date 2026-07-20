import type {
  OrganizationWorkshopsResponse,
  WorkshopListResponse,
  WorkshopPresenceState,
  WorkshopSessionResponse,
} from "./types";

export async function workshopRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(
      body?.error ?? `Workshop request failed (${response.status})`,
    );
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export function getWorkshops(): Promise<WorkshopListResponse> {
  return workshopRequest("/api/workshops");
}

export function getWorkshopSession(
  sessionId: string,
  view: "room" | "projector" = "room",
): Promise<WorkshopSessionResponse> {
  const suffix = view === "projector" ? "?view=projector" : "";
  return workshopRequest(
    `/api/workshops/${encodeURIComponent(sessionId)}${suffix}`,
  );
}

export function sendWorkshopPresence(sessionId: string): Promise<{
  observedAt: number;
  lastSeenAt: number;
  state: WorkshopPresenceState;
}> {
  return workshopRequest(
    `/api/workshops/${encodeURIComponent(sessionId)}/presence`,
    { method: "POST" },
  );
}

export function getOrganizationWorkshops(
  organizationId: string,
): Promise<OrganizationWorkshopsResponse> {
  return workshopRequest(
    `/api/organizations/${encodeURIComponent(organizationId)}/workshops`,
  );
}

export function mutateWorkshopSession(
  sessionId: string,
  action: string,
  version: number,
  payload: Record<string, unknown> = {},
): Promise<WorkshopSessionResponse> {
  return workshopRequest(
    `/api/workshops/${encodeURIComponent(sessionId)}/actions`,
    {
      method: "POST",
      body: JSON.stringify({ action, version, ...payload }),
    },
  );
}

export function createWorkshopHelpRequest(
  sessionId: string,
  message: string,
  moduleId: string | null,
): Promise<WorkshopSessionResponse> {
  return workshopRequest(
    `/api/workshops/${encodeURIComponent(sessionId)}/help-requests`,
    {
      method: "POST",
      body: JSON.stringify({ message, moduleId }),
    },
  );
}

export function closeWorkshopHelpRequest(
  sessionId: string,
  requestId: string,
): Promise<WorkshopSessionResponse> {
  return workshopRequest(
    `/api/workshops/${encodeURIComponent(sessionId)}/help-requests/${encodeURIComponent(requestId)}`,
    { method: "DELETE" },
  );
}

export function openWorkshopApplication(
  sessionId: string,
  workspaceId: string,
  applicationId: string,
): Promise<{
  routeId: string;
  url: string;
  bootstrapExpiresAt: number;
  expiresAt: number;
}> {
  return workshopRequest(
    `/api/workshops/${encodeURIComponent(sessionId)}/applications/${encodeURIComponent(applicationId)}`,
    {
      method: "POST",
      body: JSON.stringify({ workspaceId }),
    },
  );
}

export function createWorkshopSession(
  organizationId: string,
  input: {
    templateRevisionId: string;
    title: string;
    startsAt: number;
    members: Array<{
      userId: string;
      role: "participant" | "helper" | "facilitator";
    }>;
  },
): Promise<WorkshopSessionResponse> {
  return workshopRequest(
    `/api/organizations/${encodeURIComponent(organizationId)}/workshop-sessions`,
    { method: "POST", body: JSON.stringify(input) },
  );
}
