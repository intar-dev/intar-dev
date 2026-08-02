import type { SessionRole } from "./fixtures/sessions";

export interface RouteCase {
  id: string;
  path: string;
  sessionRole: SessionRole;
}

const oauthQuery = new URLSearchParams({
  client_id: "intar-cli",
  redirect_uri: "https://cli.example.test/callback",
  response_type: "code",
  scope: "openid profile email roles",
  state: "fixed-state",
}).toString();

export const ROUTE_CASES = [
  { id: "landing", path: "/", sessionRole: "anonymous" },
  {
    id: "organization-sign-in",
    path: "/organization-sign-in",
    sessionRole: "anonymous",
  },
  {
    id: "request-access",
    path: "/request-access",
    sessionRole: "anonymous",
  },
  {
    id: "oauth-consent",
    path: `/oauth/consent?${oauthQuery}`,
    sessionRole: "learner",
  },
  { id: "scenario-catalog", path: "/courses", sessionRole: "learner" },
  {
    id: "scenario-briefing",
    path: "/courses/repair-nginx",
    sessionRole: "learner",
  },
  { id: "workshops", path: "/workshops", sessionRole: "learner" },
  {
    id: "workshop-room",
    path: "/workshops/workshop-live",
    sessionRole: "learner",
  },
  {
    id: "workshop-control-room",
    path: "/workshops/workshop-live",
    sessionRole: "instructor",
  },
  {
    id: "workshop-presenter",
    path: "/workshops/workshop-live/present",
    sessionRole: "instructor",
  },
  {
    id: "workshop-projector",
    path: "/workshops/workshop-live/projector",
    sessionRole: "learner",
  },
  { id: "runs", path: "/runs", sessionRole: "learner" },
  { id: "run-workspace", path: "/runs/run-active", sessionRole: "learner" },
  {
    id: "organizations",
    path: "/organizations",
    sessionRole: "organization-member",
  },
  {
    id: "organization-detail",
    path: "/organizations/org-platform",
    sessionRole: "owner",
  },
  {
    id: "organization-workshops",
    path: "/organizations/org-platform/workshops",
    sessionRole: "owner",
  },
  { id: "profile", path: "/profile", sessionRole: "learner" },
  { id: "admin-overview", path: "/admin", sessionRole: "global-admin" },
  {
    id: "admin-hosts",
    path: "/admin/hosts",
    sessionRole: "global-admin",
  },
  {
    id: "admin-builds",
    path: "/admin/builds",
    sessionRole: "global-admin",
  },
  {
    id: "admin-scenarios",
    path: "/admin/scenarios",
    sessionRole: "global-admin",
  },
  {
    id: "admin-scenario-detail",
    path: "/admin/scenarios/repair-nginx",
    sessionRole: "global-admin",
  },
  {
    id: "admin-people",
    path: "/admin/people",
    sessionRole: "global-admin",
  },
  {
    id: "admin-authoring",
    path: "/admin/authoring",
    sessionRole: "global-admin",
  },
] as const satisfies readonly RouteCase[];

const byId = new Map<string, RouteCase>(
  ROUTE_CASES.map((route) => [route.id, route]),
);

export const DENSE_ROUTE_CASES = [
  "run-workspace",
  "workshop-room",
  "workshop-control-room",
  "organization-workshops",
  "organization-detail",
  "admin-overview",
  "admin-hosts",
  "admin-builds",
  "admin-people",
  "admin-authoring",
].map((id) => {
  const route = byId.get(id);
  if (!route) throw new Error(`Unknown dense route fixture: ${id}`);
  return route;
});

export function routeCase(id: (typeof ROUTE_CASES)[number]["id"]): RouteCase {
  const route = byId.get(id);
  if (!route) throw new Error(`Unknown route fixture: ${id}`);
  return route;
}
