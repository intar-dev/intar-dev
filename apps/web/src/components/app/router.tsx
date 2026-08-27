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
  validateOrganizationDetailSearch,
  validateScenarioBriefingSearch,
} from "./pages/tab-search";
import {
  appBootstrapQueryOptions,
  appQueryClient,
} from "@/lib/app-bootstrap";
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

const organizationSignInRoute = createRoute({
  getParentRoute: () => marketingLayoutRoute,
  path: "organization-sign-in",
  head: () =>
    routeHead(
      "Organization sign-in",
      "Use an existing linked OIDC identity or connect it from an active GitHub beta session.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/OrganizationSignIn"),
    "OrganizationSignIn",
  ),
});

const organizationDirectSignInRoute = createRoute({
  getParentRoute: () => marketingLayoutRoute,
  path: "organizations/$organizationSlug/sign-in",
  head: () =>
    routeHead(
      "Organization sign-in",
      "Use an existing linked OIDC identity or connect it from an active GitHub beta session.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/OrganizationSignIn"),
    "OrganizationSignIn",
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
  // Renders inside AppShell's <main>, whose bar already owns the h1 — the
  // root RouteNotFound would nest a second main/h1 here.
  notFoundComponent: AppRouteNotFound,
});

const courseCatalogRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "courses",
  head: () =>
    routeHead(
      "Courses",
      "Choose a systems repair course or resume active lab work.",
    ),
  validateSearch: validateCatalogSearch,
  component: lazyRouteComponent(
    () => import("./pages/learn/ScenarioCatalog"),
    "ScenarioCatalog",
  ),
});

const courseDetailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "courses/$courseId",
  validateSearch: validateCatalogSearch,
  head: () =>
    routeHead(
      "Course",
      "Follow a guided sequence of systems repair labs.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/learn/ScenarioCatalog"),
    "CourseCatalogDetail",
  ),
});

const courseScenarioBriefingRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "courses/$courseId/$scenarioId",
  validateSearch: validateScenarioBriefingSearch,
  head: () =>
    routeHead(
      "Scenario briefing",
      "Review objectives, constraints, and previous attempts before starting a lab.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/learn/ScenarioBriefing"),
    "PublicCourseScenarioBriefing",
  ),
});

const workshopsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "workshops",
  head: () =>
    routeHead(
      "Workshops",
      "Join upcoming and live facilitator-led infrastructure workshops.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/workshops/WorkshopsList"),
    "WorkshopsList",
  ),
});

const workshopRoomRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "workshops/$sessionId",
  head: () =>
    routeHead(
      "Workshop room",
      "Follow the live agenda, use your persistent workspace, and request facilitator help.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/workshops/WorkshopRoom"),
    "WorkshopRoom",
  ),
});

const workshopPresentationRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "workshops/$sessionId/present",
  head: () =>
    routeHead(
      "Workshop presenter",
      "Control the shared workshop presentation with private presenter notes.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/workshops/WorkshopPresentation"),
    "WorkshopPresentation",
  ),
});

const workshopProjectorRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "workshops/$sessionId/projector",
  head: () =>
    routeHead(
      "Workshop projector",
      "Show the current workshop slide, timer, and room announcement.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/workshops/WorkshopPresentation"),
    "WorkshopProjector",
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

const organizationsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "organizations",
  head: () =>
    routeHead(
      "Organizations",
      "Open your organization workspace and private course catalog.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/Organizations"),
    "Organizations",
  ),
});

const organizationDetailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "organizations/$orgId",
  validateSearch: validateOrganizationDetailSearch,
  head: () =>
    routeHead(
      "Organization workspace",
      "Manage identity, private courses, runners, people, and progress.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/OrganizationDetail"),
    "OrganizationDetail",
  ),
});

const organizationCoursesRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "organizations/$orgId/courses",
  validateSearch: validateCatalogSearch,
  head: () =>
    routeHead(
      "Organization courses",
      "Browse public and private systems repair courses for this organization.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/OrganizationCourses"),
    "OrganizationCourses",
  ),
});

const organizationPublicCourseRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "organizations/$orgId/courses/public/$courseId",
  validateSearch: validateCatalogSearch,
  head: () =>
    routeHead(
      "Organization course",
      "Follow a public course with organization-run lab environments.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/OrganizationCourses"),
    "OrganizationPublicCourseCatalog",
  ),
});

const organizationPrivateCourseRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "organizations/$orgId/courses/private/$courseId",
  validateSearch: validateCatalogSearch,
  head: () =>
    routeHead(
      "Organization course",
      "Follow this organization's private repair curriculum.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/OrganizationCourses"),
    "OrganizationPrivateCourseCatalog",
  ),
});

const organizationGeneralPracticeRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "organizations/$orgId/courses/general-practice",
  validateSearch: validateCatalogSearch,
  head: () =>
    routeHead(
      "General practice",
      "Practice standalone systems with organization-run lab environments.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/OrganizationCourses"),
    "OrganizationGeneralPracticeCatalog",
  ),
});

const organizationPublicCourseScenarioRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "organizations/$orgId/courses/public/$courseId/$scenarioId",
  validateSearch: validateScenarioBriefingSearch,
  head: () =>
    routeHead(
      "Scenario briefing",
      "Review objectives, constraints, and previous attempts before starting a lab.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/learn/ScenarioBriefing"),
    "OrganizationPublicCourseScenarioBriefing",
  ),
});

const organizationPrivateCourseScenarioRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "organizations/$orgId/courses/private/$courseId/$scenarioId",
  validateSearch: validateScenarioBriefingSearch,
  head: () =>
    routeHead(
      "Scenario briefing",
      "Review objectives, constraints, and previous attempts before starting a lab.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/learn/ScenarioBriefing"),
    "OrganizationPrivateCourseScenarioBriefing",
  ),
});

const organizationGeneralPracticeScenarioRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "organizations/$orgId/courses/general-practice/$scenarioId",
  validateSearch: validateScenarioBriefingSearch,
  head: () =>
    routeHead(
      "Scenario briefing",
      "Review objectives, constraints, and previous attempts before starting a lab.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/learn/ScenarioBriefing"),
    "OrganizationGeneralPracticeScenarioBriefing",
  ),
});

const organizationWorkshopsRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "organizations/$orgId/workshops",
  head: () =>
    routeHead(
      "Organization workshops",
      "Manage private workshop templates, rosters, capacity, and live sessions.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/workshops/OrganizationWorkshops"),
    "OrganizationWorkshops",
  ),
});

const profileRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "profile",
  head: () =>
    routeHead(
      "Profile",
      "Manage your identity and optional native SSH keys.",
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
  component: lazyRouteComponent(() => import("./pages/Dashboard"), "Dashboard"),
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
      "Manage beta invite links, beta users, roles, and platform organizations.",
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
    oauthConsentRoute,
    organizationSignInRoute,
    organizationDirectSignInRoute,
  ]),
  appLayoutRoute.addChildren([
    courseCatalogRoute,
    courseDetailRoute,
    courseScenarioBriefingRoute,
    workshopsRoute,
    workshopRoomRoute,
    workshopPresentationRoute,
    workshopProjectorRoute,
    scenarioRunRoute,
    runsListRoute,
    organizationsRoute,
    organizationDetailRoute,
    organizationCoursesRoute,
    organizationPublicCourseRoute,
    organizationPrivateCourseRoute,
    organizationGeneralPracticeRoute,
    organizationPublicCourseScenarioRoute,
    organizationPrivateCourseScenarioRoute,
    organizationGeneralPracticeScenarioRoute,
    organizationWorkshopsRoute,
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

function AppRouteNotFound() {
  return (
    <>
      <title>Page not found · intar.dev</title>
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-4 px-[var(--page-inset)] py-16 text-center">
        <div className="space-y-2">
          <p className="text-eyebrow">Unknown work order</p>
          <p className="text-page-title">That route is not in the manual</p>
          <p className="text-sm leading-6 text-muted-foreground">
            Check the address, or return to the course catalog to choose your
            next repair.
          </p>
        </div>
        <Button render={<Link to="/courses" />}>Browse courses</Button>
      </div>
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
            Check the address, or return to the course catalog to choose your
            next repair.
          </p>
        </div>
        <Button render={<Link to="/courses" />}>Browse courses</Button>
      </main>
    </>
  );
}

async function requireAdminRoute() {
  const { session } = await loadAppBootstrap();
  if (!session?.user || !isAdminUser(session.user)) {
    throw redirect({ to: "/" });
  }
}

async function requireSignedInRoute() {
  const { betaAccess, session } = await loadAppBootstrap();
  if (!session?.user) {
    throw redirect({ to: "/" });
  }
  if (betaAccess !== "active") {
    if (typeof window !== "undefined") {
      window.location.replace("/join");
    }
    throw redirect({ to: "/" });
  }
}

async function loadAppBootstrap() {
  return appQueryClient.fetchQuery(appBootstrapQueryOptions());
}

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
