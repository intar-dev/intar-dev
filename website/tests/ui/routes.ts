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
    id: "request-access",
    path: "/request-access",
    sessionRole: "anonymous",
  },
  {
    id: "oauth-consent",
    path: `/oauth/consent?${oauthQuery}`,
    sessionRole: "learner",
  },
  { id: "scenario-catalog", path: "/scenarios", sessionRole: "learner" },
  {
    id: "scenario-briefing",
    path: "/scenarios/repair-nginx",
    sessionRole: "learner",
  },
  { id: "runs", path: "/runs", sessionRole: "learner" },
  { id: "run-workspace", path: "/runs/run-active", sessionRole: "learner" },
  { id: "teams", path: "/teams", sessionRole: "team-member" },
  {
    id: "team-detail",
    path: "/teams/team-platform",
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
  "team-detail",
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
