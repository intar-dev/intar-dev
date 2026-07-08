import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { MarketingShell } from "./shell/MarketingShell";
import { AppShell } from "./shell/AppShell";
import { Landing } from "./pages/Landing";
import { RequestAccess } from "./pages/RequestAccess";
import { OAuthConsent } from "./pages/OAuthConsent";
import { Dashboard } from "./pages/Dashboard";
import { AdminHosts } from "./pages/admin/Hosts";
import { AdminBuilds } from "./pages/AdminBuilds";
import { ScenarioRegistry as AdminScenarios } from "./pages/admin/ScenarioRegistry";
import { ScenarioDetails as AdminScenarioDetails } from "./pages/admin/ScenarioDetails";
import { AdminPeople } from "./pages/AdminPeople";
import { AdminAuthoring } from "./pages/AdminAuthoring";
import { ScenarioCatalog } from "./pages/learn/ScenarioCatalog";
import { validateSearch as validateCatalogSearch } from "./pages/learn/catalog-search";
import { ScenarioBriefing } from "./pages/learn/ScenarioBriefing";
import { ScenarioRun } from "./pages/ScenarioRun";
import { RunsList } from "./pages/RunsList";
import { Teams } from "./pages/Teams";
import { TeamDetail } from "./pages/TeamDetail";
import { Profile } from "./pages/Profile";
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
  component: Landing,
});

const requestAccessRoute = createRoute({
  getParentRoute: () => marketingLayoutRoute,
  path: "request-access",
  component: RequestAccess,
});

const oauthConsentRoute = createRoute({
  getParentRoute: () => marketingLayoutRoute,
  path: "oauth/consent",
  component: OAuthConsent,
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
  component: ScenarioCatalog,
});

const scenarioBriefingRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "scenarios/$scenarioId",
  component: ScenarioBriefing,
});

const scenarioRunRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "runs/$runId",
  component: ScenarioRun,
});

const runsListRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "runs",
  component: RunsList,
});

const teamsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "teams",
  component: Teams,
});

const teamDetailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "teams/$orgId",
  component: TeamDetail,
});

const profileRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "profile",
  component: Profile,
});

/* Admin routes — additionally require the admin role. */

const adminOverviewRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "admin",
  beforeLoad: requireAdminRoute,
  component: Dashboard,
});

const adminHostsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "admin/hosts",
  beforeLoad: requireAdminRoute,
  component: AdminHosts,
});

// Old bookmark compatibility: onboarding folded into the Hosts page.
const adminOnboardingRedirectRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "admin/onboarding",
  beforeLoad: () => {
    throw redirect({ to: "/admin/hosts" });
  },
});

const adminBuildsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "admin/builds",
  beforeLoad: requireAdminRoute,
  component: AdminBuilds,
});

const adminScenariosRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "admin/scenarios",
  beforeLoad: requireAdminRoute,
  component: AdminScenarios,
});

const adminScenarioDetailsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "admin/scenarios/$scenarioId",
  beforeLoad: requireAdminRoute,
  component: AdminScenarioDetails,
});

const adminPeopleRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "admin/people",
  beforeLoad: requireAdminRoute,
  component: AdminPeople,
});

const adminAuthoringRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "admin/authoring",
  beforeLoad: requireAdminRoute,
  component: AdminAuthoring,
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
    adminOnboardingRedirectRoute,
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
