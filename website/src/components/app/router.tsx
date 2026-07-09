import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { MarketingShell } from "./shell/MarketingShell";
import { AppShell } from "./shell/AppShell";
import { validateSearch as validateCatalogSearch } from "./pages/learn/catalog-search";
import { getClientSession } from "@/lib/auth-client";
import { isAdminUser } from "@/lib/authz";

const rootRoute = createRootRoute({ component: () => <Outlet /> });

/* -------------------------------------------------------------------------- */
/* Marketing surface (public, light)                                          */
/* -------------------------------------------------------------------------- */

const marketingLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "marketing",
  component: MarketingShell,
});

const indexRoute = createRoute({
  getParentRoute: () => marketingLayoutRoute,
  path: "/",
  component: lazyRouteComponent(() => import("./pages/Landing"), "Landing"),
});

const requestAccessRoute = createRoute({
  getParentRoute: () => marketingLayoutRoute,
  path: "request-access",
  component: lazyRouteComponent(
    () => import("./pages/RequestAccess"),
    "RequestAccess",
  ),
});

const oauthConsentRoute = createRoute({
  getParentRoute: () => marketingLayoutRoute,
  path: "oauth/consent",
  component: lazyRouteComponent(
    () => import("./pages/OAuthConsent"),
    "OAuthConsent",
  ),
});

/* -------------------------------------------------------------------------- */
/* App surface (signed-in, dark). Guard lives here, once.                     */
/* -------------------------------------------------------------------------- */

const appLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  beforeLoad: requireSignedInRoute,
  component: AppShell,
});

const scenarioCatalogRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "scenarios",
  validateSearch: validateCatalogSearch,
  component: lazyRouteComponent(
    () => import("./pages/learn/ScenarioCatalog"),
    "ScenarioCatalog",
  ),
});

const scenarioBriefingRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "scenarios/$scenarioId",
  component: lazyRouteComponent(
    () => import("./pages/learn/ScenarioBriefing"),
    "ScenarioBriefing",
  ),
});

const scenarioRunRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "runs/$runId",
  component: lazyRouteComponent(
    () => import("./pages/ScenarioRun"),
    "ScenarioRun",
  ),
});

const runsListRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "runs",
  component: lazyRouteComponent(() => import("./pages/RunsList"), "RunsList"),
});

const teamsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "teams",
  component: lazyRouteComponent(() => import("./pages/Teams"), "Teams"),
});

const teamDetailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "teams/$orgId",
  component: lazyRouteComponent(
    () => import("./pages/TeamDetail"),
    "TeamDetail",
  ),
});

const profileRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "profile",
  component: lazyRouteComponent(() => import("./pages/Profile"), "Profile"),
});

/* Admin routes — additionally require the admin role. */

const adminOverviewRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "admin",
  beforeLoad: requireAdminRoute,
  component: lazyRouteComponent(
    () => import("./pages/Dashboard"),
    "Dashboard",
  ),
});

const adminHostsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "admin/hosts",
  beforeLoad: requireAdminRoute,
  component: lazyRouteComponent(
    () => import("./pages/admin/Hosts"),
    "AdminHosts",
  ),
});

const adminBuildsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "admin/builds",
  beforeLoad: requireAdminRoute,
  component: lazyRouteComponent(
    () => import("./pages/AdminBuilds"),
    "AdminBuilds",
  ),
});

const adminScenariosRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "admin/scenarios",
  beforeLoad: requireAdminRoute,
  component: lazyRouteComponent(
    () => import("./pages/admin/ScenarioRegistry"),
    "ScenarioRegistry",
  ),
});

const adminScenarioDetailsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "admin/scenarios/$scenarioId",
  beforeLoad: requireAdminRoute,
  component: lazyRouteComponent(
    () => import("./pages/admin/ScenarioDetails"),
    "ScenarioDetails",
  ),
});

const adminPeopleRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "admin/people",
  beforeLoad: requireAdminRoute,
  component: lazyRouteComponent(
    () => import("./pages/AdminPeople"),
    "AdminPeople",
  ),
});

const adminAuthoringRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "admin/authoring",
  beforeLoad: requireAdminRoute,
  component: lazyRouteComponent(
    () => import("./pages/AdminAuthoring"),
    "AdminAuthoring",
  ),
});

const routeTree = rootRoute.addChildren([
  marketingLayoutRoute.addChildren([
    indexRoute,
    requestAccessRoute,
    oauthConsentRoute,
  ]),
  appLayoutRoute.addChildren([
    scenarioCatalogRoute,
    scenarioBriefingRoute,
    scenarioRunRoute,
    runsListRoute,
    teamsRoute,
    teamDetailRoute,
    profileRoute,
    adminOverviewRoute,
    adminHostsRoute,
    adminBuildsRoute,
    adminScenariosRoute,
    adminScenarioDetailsRoute,
    adminPeopleRoute,
    adminAuthoringRoute,
  ]),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultPendingMinMs: 150,
});

async function requireAdminRoute() {
  const session = await getClientSession();
  if (!session?.user || !isAdminUser(session.user)) {
    throw redirect({ to: "/" });
  }
}

async function requireSignedInRoute() {
  const session = await getClientSession();
  if (!session?.user) {
    throw redirect({ to: "/" });
  }
}

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
