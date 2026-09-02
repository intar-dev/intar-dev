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
  head: () => routeHead("Systems repair courses", DEFAULT_DESCRIPTION),
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
  head: () => routeHead("Systems repair courses", DEFAULT_DESCRIPTION),
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
      "Learn the theory, then apply it in a systems repair scenario.",
    ),
  validateSearch: validateCatalogSearch,
  component: lazyRouteComponent(
    () => import("./pages/learn/CourseCatalog"),
    "PublicCourseCatalog",
  ),
});

const courseDetailRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "courses/$courseId",
  validateSearch: validateCatalogSearch,
  head: () =>
    routeHead(
      "Course",
      "Follow the theory-first curriculum in its published order.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/learn/CourseCatalog"),
    "PublicCourseDetail",
  ),
});

const courseLectureRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "courses/$courseId/lectures/$lectureId",
  head: () =>
    routeHead(
      "Lecture",
      "Read the theory before you apply it in a scenario.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/learn/Lecture"),
    "PublicLecture",
  ),
});

const scenarioRunStartRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "runs/start/$scenarioId",
  validateSearch: validateScenarioRunStartSearch,
  head: () =>
    routeHead(
      "Starting run",
      "Reserve capacity and prepare the scenario workspace.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/ScenarioRun"),
    "ScenarioRunStart",
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
    routeHead("My runs", "Resume active work or review your run archive."),
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
    () => import("./pages/learn/CourseCatalog"),
    "OrganizationCourseCatalog",
  ),
});

const organizationPublicCourseRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "organizations/$orgId/courses/public/$courseId",
  validateSearch: validateCatalogSearch,
  head: () =>
    routeHead(
      "Organization course",
      "Follow a public course with organization-run scenario environments.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/learn/CourseCatalog"),
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
    () => import("./pages/learn/CourseCatalog"),
    "OrganizationPrivateCourseCatalog",
  ),
});

const organizationPublicCourseLectureRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "organizations/$orgId/courses/public/$courseId/lectures/$lectureId",
  head: () =>
    routeHead(
      "Lecture",
      "Read the theory before you apply it in a scenario.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/learn/Lecture"),
    "OrganizationPublicLecture",
  ),
});

const organizationPrivateCourseLectureRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "organizations/$orgId/courses/private/$courseId/lectures/$lectureId",
  head: () =>
    routeHead(
      "Lecture",
      "Read the theory before you apply it in a scenario.",
    ),
  component: lazyRouteComponent(
    () => import("./pages/learn/Lecture"),
    "OrganizationPrivateLecture",
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
    courseLectureRoute,
    scenarioRunStartRoute,
    scenarioRunRoute,
    runsListRoute,
    organizationsRoute,
    organizationDetailRoute,
    organizationCoursesRoute,
    organizationPublicCourseRoute,
    organizationPrivateCourseRoute,
    organizationPublicCourseLectureRoute,
    organizationPrivateCourseLectureRoute,
    profileRoute,
    adminOverviewRoute,
    adminHostsRoute,
    adminBuildsRoute,
    adminScenariosRoute,
    adminScenarioDetailsRoute,
    adminPeopleRoute,
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
  "Learn systems theory and repair real infrastructure in guided scenarios.";

function routeHead(title: string, description: string) {
  return {
    meta: [
      { title: `${title} · intar.dev` },
      { name: "description", content: description },
    ],
  };
}

function validateScenarioRunStartSearch(search: Record<string, unknown>) {
  const text = (value: unknown) =>
    typeof value === "string" && value.trim() ? value.trim() : undefined;
  const scope =
    search.scope === "public" ||
    search.scope === "organization-public" ||
    search.scope === "organization-private"
      ? search.scope
      : undefined;
  return {
    scope,
    organizationId: text(search.organizationId),
    courseId: text(search.courseId),
    lectureId: text(search.lectureId),
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
          <p className="text-label">Unknown work order</p>
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
          <p className="text-label">Unknown work order</p>
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
