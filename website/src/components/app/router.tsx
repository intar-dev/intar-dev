import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from "@tanstack/react-router";
import { AppNavbar } from "./AppNavbar";
import { Landing } from "./pages/Landing";
import { Dashboard } from "./pages/Dashboard";
import { AgentOnboarding } from "./pages/AgentOnboarding";
import { Scenarios as AdminScenarios } from "./pages/Scenarios";
import { ScenarioDetails as AdminScenarioDetails } from "./pages/ScenarioDetails";
import { ScenarioCatalog } from "./pages/ScenarioCatalog";
import { ScenarioBriefing } from "./pages/ScenarioBriefing";
import { ScenarioRun } from "./pages/ScenarioRun";
import { Profile } from "./pages/Profile";
import { OAuthConsent } from "./pages/OAuthConsent";
import { ThemeToggle } from "./theme";
import { getClientSession } from "@/lib/auth-client";
import { isAdminUser } from "@/lib/authz";

const rootRoute = createRootRoute({
  component: RootLayout,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: Landing,
});

const dashboardRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "dashboard",
  beforeLoad: requireAdminRoute,
  component: Dashboard,
});

const dashboardOnboardingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "dashboard/onboarding",
  beforeLoad: requireAdminRoute,
  component: AgentOnboarding,
});

const adminScenariosRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "admin/scenarios",
  beforeLoad: requireAdminRoute,
  component: AdminScenarios,
});

const adminScenarioDetailsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "admin/scenarios/$scenarioId",
  beforeLoad: requireAdminRoute,
  component: AdminScenarioDetails,
});

const scenarioCatalogRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "scenarios",
  beforeLoad: requireSignedInRoute,
  component: ScenarioCatalog,
});

const scenarioBriefingRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "scenarios/$scenarioId",
  beforeLoad: requireSignedInRoute,
  component: ScenarioBriefing,
});

const scenarioRunRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "scenarios/runs/$runId",
  beforeLoad: requireSignedInRoute,
  component: ScenarioRun,
});

const profileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "profile",
  beforeLoad: requireSignedInRoute,
  component: Profile,
});

const oauthConsentRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "oauth/consent",
  component: OAuthConsent,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  oauthConsentRoute,
  dashboardRoute,
  dashboardOnboardingRoute,
  adminScenariosRoute,
  adminScenarioDetailsRoute,
  scenarioCatalogRoute,
  scenarioBriefingRoute,
  scenarioRunRoute,
  profileRoute,
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  defaultPendingMinMs: 150,
});

function RootLayout() {
  return (
    <div className="min-h-screen text-foreground">
      <ThemeToggle />
      <AppNavbar />
      <Outlet />
    </div>
  );
}

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
