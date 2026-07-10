import {
  createRootRoute,
  createRoute,
  createRouter,
  HeadContent,
  Link,
  lazyRouteComponent,
  Outlet,
  redirect,
  type ErrorComponentProps,
} from "@tanstack/react-router";
import { CircleAlert, LoaderCircle, SearchX } from "lucide-react";
import { BrandMark } from "./patterns/BrandMark";
import { Button } from "@/components/ui/button";
import { MarketingShell } from "./shell/MarketingShell";
import { AppShell } from "./shell/AppShell";
import { validateSearch as validateCatalogSearch } from "./pages/learn/catalog-search";
import {
  validateAdminPeopleSearch,
  validateTeamDetailSearch,
} from "./pages/tab-search";
import { getClientSession } from "@/lib/auth-client";
import { isAdminUser } from "@/lib/authz";

const rootRoute = createRootRoute({
  component: RootRouteLayout,
  pendingComponent: FullPageRoutePending,
  errorComponent: RouteError,
  notFoundComponent: RouteNotFound,
  head: () => routeHead("Systems repair labs", DEFAULT_DESCRIPTION),
});

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
  head: () => routeHead("Systems repair labs", DEFAULT_DESCRIPTION),
  pendingComponent: FullPageRoutePending,
  component: lazyRouteComponent(() => import("./pages/Landing"), "Landing"),
});

const requestAccessRoute = createRoute({
  getParentRoute: () => marketingLayoutRoute,
  path: "request-access",
  head: () =>
    routeHead(
      "Request access",
      "Request access to intar.dev hands-on infrastructure labs.",
    ),
  pendingComponent: FullPageRoutePending,
  component: lazyRouteComponent(
    () => import("./pages/RequestAccess"),
    "RequestAccess",
  ),
});

const oauthConsentRoute = createRoute({
  getParentRoute: () => marketingLayoutRoute,
  path: "oauth/consent",
  head: () =>
    routeHead(
      "Authorize access",
      "Review and authorize an application request for your intar.dev account.",
    ),
  pendingComponent: FullPageRoutePending,
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
  pendingComponent: FullPageRoutePending,
  component: AppShell,
});

const scenarioCatalogRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "scenarios",
  head: () =>
    routeHead(
      "Scenarios",
      "Choose a systems repair scenario or resume active lab work.",
    ),
  validateSearch: validateCatalogSearch,
  component: lazyRouteComponent(
    () => import("./pages/learn/ScenarioCatalog"),
    "ScenarioCatalog",
  ),
});

const scenarioBriefingRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "scenarios/$scenarioId",
  head: () =>
    routeHead(
      "Scenario briefing",
      "Review objectives, constraints, and previous attempts before starting a lab.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/learn/ScenarioBriefing"),
    "ScenarioBriefing",
  ),
});

const scenarioRunRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "runs/$runId",
  head: () =>
    routeHead(
      "Run workspace",
      "Repair the live system, follow checks, and verify your resolution.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/ScenarioRun"),
    "ScenarioRun",
  ),
});

const runsListRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "runs",
  head: () =>
    routeHead("My runs", "Resume active work or review your lab archive."),
  component: lazyRouteComponent(() => import("./pages/RunsList"), "RunsList"),
});

const teamsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "teams",
  head: () =>
    routeHead(
      "Teams",
      "Review invitations and collaborate on systems learning assignments.",
    ),
  component: lazyRouteComponent(() => import("./pages/Teams"), "Teams"),
});

const teamDetailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "teams/$orgId",
  validateSearch: validateTeamDetailSearch,
  head: () =>
    routeHead(
      "Team workspace",
      "Manage people, assignments, progress, and team settings.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/TeamDetail"),
    "TeamDetail",
  ),
});

const profileRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "profile",
  head: () =>
    routeHead(
      "Profile",
      "Manage your identity and SSH keys for future lab runs.",
    ),
  component: lazyRouteComponent(() => import("./pages/Profile"), "Profile"),
});

/* Admin routes — additionally require the admin role. */

const adminOverviewRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "admin",
  head: () =>
    routeHead(
      "Operations overview",
      "Monitor platform exceptions, live work, and scenario availability.",
    ),
  beforeLoad: requireAdminRoute,
  component: lazyRouteComponent(
    () => import("./pages/Dashboard"),
    "Dashboard",
  ),
});

const adminHostsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "admin/hosts",
  head: () =>
    routeHead("Hosts", "Inspect host health, capacity, and recovery actions."),
  beforeLoad: requireAdminRoute,
  component: lazyRouteComponent(
    () => import("./pages/admin/Hosts"),
    "AdminHosts",
  ),
});

const adminBuildsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "admin/builds",
  head: () =>
    routeHead("Builds", "Monitor scenario image builds, logs, and retries."),
  beforeLoad: requireAdminRoute,
  component: lazyRouteComponent(
    () => import("./pages/AdminBuilds"),
    "AdminBuilds",
  ),
});

const adminScenariosRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "admin/scenarios",
  head: () =>
    routeHead(
      "Scenario registry",
      "Manage learner availability and scenario records.",
    ),
  beforeLoad: requireAdminRoute,
  component: lazyRouteComponent(
    () => import("./pages/admin/ScenarioRegistry"),
    "ScenarioRegistry",
  ),
});

const adminScenarioDetailsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "admin/scenarios/$scenarioId",
  head: () =>
    routeHead(
      "Scenario record",
      "Inspect scenario configuration, checks, hints, and machine definitions.",
    ),
  beforeLoad: requireAdminRoute,
  component: lazyRouteComponent(
    () => import("./pages/admin/ScenarioDetails"),
    "ScenarioDetails",
  ),
});

const adminPeopleRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "admin/people",
  validateSearch: validateAdminPeopleSearch,
  head: () =>
    routeHead(
      "People and access",
      "Review access requests, users, and platform teams.",
    ),
  beforeLoad: requireAdminRoute,
  component: lazyRouteComponent(
    () => import("./pages/AdminPeople"),
    "AdminPeople",
  ),
});

const adminAuthoringRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "admin/authoring",
  head: () =>
    routeHead(
      "Scenario authoring",
      "Edit, validate, save, and build scenario source.",
    ),
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
  defaultPendingComponent: RoutePending,
  defaultNotFoundComponent: RouteNotFound,
});

const DEFAULT_DESCRIPTION =
  "Practice diagnosing and repairing real infrastructure in guided, terminal-first systems labs.";

function routeHead(title: string, description: string) {
  return {
    meta: [
      { title: `${title} · intar.dev` },
      { name: "description", content: description },
    ],
  };
}

function RootRouteLayout() {
  return (
    <>
      <HeadContent />
      <Outlet />
    </>
  );
}

function RoutePending() {
  return (
    <div
      role="status"
      className="flex min-h-64 items-center justify-center gap-3 p-8 text-muted-foreground"
    >
      <LoaderCircle className="size-5 motion-safe:animate-spin" />
      <span>Preparing the workspace…</span>
    </div>
  );
}

function FullPageRoutePending() {
  return (
    <main className="flex min-h-dvh items-center justify-center p-8 text-muted-foreground">
      <div role="status" className="flex items-center gap-3">
        <LoaderCircle className="size-5 motion-safe:animate-spin" />
        <span>Preparing the workspace…</span>
      </div>
    </main>
  );
}

function RouteError({ reset }: ErrorComponentProps) {
  return (
    <>
      <title>Workspace error · intar.dev</title>
      <main className="mx-auto flex min-h-dvh max-w-xl flex-col items-center justify-center gap-6 px-[var(--page-inset)] py-16 text-center">
        <span className="flex size-12 items-center justify-center rounded-xl bg-destructive-subtle text-destructive">
          <CircleAlert className="size-6" />
        </span>
        <div className="space-y-2">
          <h1 className="text-page-title">This workspace did not load</h1>
          <p className="text-body text-muted-foreground">
            The route failed before it could prepare your controls. Try loading
            it again.
          </p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={reset}>Try again</Button>
          <Button variant="outline" render={<Link to="/" />}>
            Return home
          </Button>
        </div>
      </main>
    </>
  );
}

function RouteNotFound() {
  return (
    <>
      <title>Page not found · intar.dev</title>
      <meta
        name="description"
        content="This intar.dev work order could not be found."
      />
      <main className="mx-auto flex min-h-dvh max-w-2xl flex-col items-center justify-center gap-6 px-[var(--page-inset)] py-16 text-center">
        <BrandMark />
        <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <SearchX className="size-6" />
        </span>
        <div className="space-y-2">
          <p className="text-eyebrow">Unknown work order</p>
          <h1 className="text-page-title">That route is not in the manual</h1>
          <p className="text-body text-muted-foreground">
            Check the address, or return to the scenario catalog to choose your
            next repair.
          </p>
        </div>
        <Button render={<Link to="/scenarios" />}>Browse scenarios</Button>
      </main>
    </>
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
