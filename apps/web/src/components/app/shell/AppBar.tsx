import { Link, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, ChevronRight, EllipsisVertical } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { NAV_ITEMS } from "./nav-config";
import { useBreadcrumbOverrides, usePageChromeValue } from "./page-chrome";

const SEGMENT_LABELS: Record<string, string> = {
  admin: "Admin",
  courses: "Courses",
  scenarios: "Scenarios",
  runs: "My runs",
  organizations: "Organizations",
  profile: "Profile",
  builds: "Builds",
  hosts: "Hosts",
  people: "People",
  lectures: "Lectures",
  new: "New",
};

function trimSegment(segment: string): string {
  return segment.length > 16 ? `${segment.slice(0, 12)}…` : segment;
}

// Final crumb: page data override wins, then the nav label (so `/admin` reads
// "Overview"), then the static segment map. Ancestors flip the precedence to
// the segment map so `/admin/hosts` reads "Admin › Hosts", never "Overview".
function labelForFinal(
  path: string,
  segment: string,
  overrides: ReadonlyMap<string, string>,
): string {
  const override = overrides.get(path);
  if (override) return override;
  const safeDynamicLabel = safeDynamicPageLabel(path);
  if (safeDynamicLabel) return safeDynamicLabel;
  const navMatch = NAV_ITEMS.find((item) => item.to === path);
  if (navMatch) return navMatch.label;
  return SEGMENT_LABELS[segment] ?? trimSegment(segment);
}

// Page data replaces these labels after load. Until then, never put internal
// scenario or run identifiers into the visible heading.
function isLecturePage(pathname: string): boolean {
  return (
    /^\/courses\/[^/]+\/lectures\/[^/]+$/.test(pathname) ||
    /^\/organizations\/[^/]+\/courses\/(?:public|private)\/[^/]+\/lectures\/[^/]+$/.test(
      pathname,
    )
  );
}

export function safeDynamicPageLabel(pathname: string): string | null {
  if (/^\/runs\/[^/]+$/.test(pathname)) {
    return "Scenario run";
  }
  if (/^\/runs\/start\/[^/]+$/.test(pathname)) {
    return "Starting run";
  }
  if (isLecturePage(pathname)) {
    return "Lecture";
  }
  return null;
}

function labelForAncestor(
  path: string,
  segment: string,
  overrides: ReadonlyMap<string, string>,
): string {
  const override = overrides.get(path);
  if (override) return override;
  if (SEGMENT_LABELS[segment]) return SEGMENT_LABELS[segment];
  const navMatch = NAV_ITEMS.find((item) => item.to === path);
  if (navMatch) return navMatch.label;
  return trimSegment(segment);
}

export function breadcrumbTarget(path: string): string {
  return path.replace(/\/courses\/(?:public|private)$/, "/courses");
}

interface Crumb {
  label: string;
  to?: string | undefined;
}

export function buildCrumbs(
  pathname: string,
  overrides: ReadonlyMap<string, string>,
): Crumb[] {
  const segments = pathname.split("/").filter(Boolean);
  const organizationCourse = pathname.match(
    /^\/organizations\/([^/]+)\/courses(?:\/|$)/,
  );
  const organizationId = organizationCourse?.[1];
  const organizationRoot = organizationId
    ? `/organizations/${organizationId}`
    : null;
  const crumbs: Crumb[] = [];
  let acc = "";
  segments.forEach((segment, index) => {
    acc += `/${segment}`;
    if (
      organizationRoot &&
      (acc === "/organizations" ||
        acc === organizationRoot ||
        acc === `${organizationRoot}/courses/public` ||
        acc === `${organizationRoot}/courses/private`)
    ) {
      return;
    }
    // This path segment is structural, not learner-facing navigation.
    if (segment === "lectures") return;
    const isLast = index === segments.length - 1;
    crumbs.push(
      isLast
        ? { label: labelForFinal(acc, segment, overrides) }
        : {
            label: labelForAncestor(acc, segment, overrides),
            to: breadcrumbTarget(acc),
          },
    );
  });
  // A lecture needs its section, course, and current lecture. Other pages keep
  // the compact section/current-page pair because the sidebar adds context.
  return crumbs.slice(isLecturePage(pathname) ? -3 : -2);
}

// The one bar of app chrome: navigation trigger, breadcrumb-as-title (the
// final crumb is the route's page title), and the page-registered status /
// primary action / overflow menu. Its height is --app-bar-h (global.css).
export function AppBar() {
  // The committed location — the bar must describe the page that is actually
  // rendered in the outlet, which lags the eager location during pending
  // navigations (matches the keying in usePageChrome).
  const pathname = useRouterState({
    select: (state) =>
      state.resolvedLocation?.pathname ?? state.location.pathname,
  });
  const overrides = useBreadcrumbOverrides();
  const chrome = usePageChromeValue(pathname);
  const crumbs = buildCrumbs(pathname, overrides);
  const final = crumbs[crumbs.length - 1];
  const ancestors = crumbs.slice(0, -1);
  const parent = ancestors[ancestors.length - 1];

  // Every app route's single visible h1, in every data state. Never wrap it
  // in BreadcrumbPage or add aria-current — a role would strip the heading
  // semantics the a11y suite asserts on.
  const heading = final ? (
    <h1
      title={final.label}
      className={
        ancestors.length
          ? "min-w-0 truncate text-sm font-semibold text-foreground"
          : "min-w-0 truncate text-card-title"
      }
    >
      {final.label}
    </h1>
  ) : null;

  return (
    <header className="sticky top-0 z-30 grid h-[var(--app-bar-h)] shrink-0 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b bg-background px-[var(--page-inset)]">
      <div className="flex min-w-0 items-center gap-2" data-app-bar-leading>
        <SidebarTrigger className="-ml-1" />
        <Separator
          orientation="vertical"
          className="data-[orientation=vertical]:h-4"
        />
        {chrome?.back ? (
          <span className="flex min-w-0 items-center">{chrome.back}</span>
        ) : parent?.to ? (
          <Link
            to={parent.to}
            aria-label={`Back to ${parent.label}`}
            className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40 sm:hidden [@media(pointer:coarse)]:size-11"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
          </Link>
        ) : null}
      </div>
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center">
        <ol className="flex min-w-0 items-center gap-1.5">
          {!chrome?.back
            ? ancestors.map((ancestor) =>
                ancestor.to ? (
                  <li
                    key={ancestor.to}
                    className="hidden shrink-0 items-center gap-1.5 sm:flex"
                  >
                    <Link
                      to={ancestor.to}
                      className="rounded-sm text-sm text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {ancestor.label}
                    </Link>
                    <ChevronRight
                      aria-hidden="true"
                      className="size-3.5 text-muted-foreground/60"
                    />
                  </li>
                ) : null,
              )
            : null}
          <li className="flex min-w-0 items-center" data-app-bar-title>
            {heading}
          </li>
        </ol>
      </nav>
      <div className="flex min-w-0 shrink-0 items-center gap-2" data-app-bar-trailing>
        {chrome?.utility}
        {chrome?.status ? (
          <span className="inline-flex min-w-0">{chrome.status}</span>
        ) : null}
        {chrome?.action}
        {chrome?.menu ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className={chrome.action ? "sm:hidden" : undefined}
                  aria-label="Page actions"
                />
              }
            >
              <EllipsisVertical />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">{chrome.menu}</DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </header>
  );
}
