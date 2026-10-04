import { Link, useRouterState } from "@tanstack/react-router";
import { ArrowLeft, EllipsisVertical } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { NewVersionButton } from "./NewVersionButton";
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
  if (/^\/support\/(?!new$)[^/]+$/.test(pathname)) {
    return "Topic";
  }
  if (/^\/runs\/[^/]+$/.test(pathname)) {
    return "Scenario run";
  }
  if (/^\/runs\/start\/[^/]+$/.test(pathname)) {
    return "Starting run";
  }
  if (/^\/admin\/people\/[^/]+$/.test(pathname)) {
    return "User";
  }
  if (isLecturePage(pathname)) {
    return "Lecture";
  }
  if (/^\/organizations\/[^/]+$/.test(pathname)) {
    return "Organization";
  }
  if (/^\/admin\/scenarios\/[^/]+$/.test(pathname)) {
    return "Scenario";
  }
  if (
    /^\/courses\/[^/]+$/.test(pathname) ||
    /^\/organizations\/[^/]+\/courses\/(?:public|private)\/[^/]+$/.test(
      pathname,
    )
  ) {
    return "Course";
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
            // Private organization courses are listed on /courses too.
            to:
              organizationRoot &&
              acc === `${organizationRoot}/courses` &&
              pathname.startsWith(`${organizationRoot}/courses/private/`)
                ? "/courses"
                : breadcrumbTarget(acc),
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
  const reading = chrome?.reading === true;
  const allCrumbs = buildCrumbs(pathname, overrides);
  // Reading pages carry their title in the content (the h1 there), so the bar
  // shows the course context instead: a lecture drops its own crumb.
  const crumbs =
    reading && isLecturePage(pathname) ? allCrumbs.slice(0, -1) : allCrumbs;
  const final = crumbs[crumbs.length - 1];
  const ancestors = crumbs.slice(0, -1);
  const parent = ancestors[ancestors.length - 1];

  // Every other app route's single visible h1, in every data state. Never wrap
  // it in BreadcrumbPage or add aria-current: a role would strip the heading
  // semantics the a11y suite asserts on.
  const titleClass = "min-w-0 truncate text-support font-semibold text-foreground";
  const heading = final ? (
    reading ? (
      final.to ? (
        <Link
          to={final.to}
          className="inline-flex min-w-0 items-center rounded-sm text-support font-semibold text-foreground"
        >
          <span className="truncate">{final.label}</span>
        </Link>
      ) : (
        <p className={titleClass}>{final.label}</p>
      )
    ) : (
      <h1 title={final.label} className={titleClass}>
        {final.label}
      </h1>
    )
  ) : null;
  const showAncestors = !chrome?.back;

  return (
    // On desktop the inset panel's rounded top edge lives here: an 8px canvas
    // band hides scrolled content above the bar, and the bar redraws the
    // panel's top corners and side borders so it stays attached while sticky.
    <header className="sticky top-0 z-30 shrink-0 bg-background pt-[env(safe-area-inset-top)] lg:-mx-px lg:bg-sidebar lg:pt-2">
      <div className="grid h-[var(--app-bar-h)] grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b bg-background pr-[max(0.5rem,env(safe-area-inset-right))] pl-[max(0.5rem,env(safe-area-inset-left))] lg:rounded-t-xl lg:border-x lg:border-t lg:border-sidebar-border lg:border-b-border">
      <div className="flex min-w-0 items-center gap-2" data-app-bar-leading>
        <SidebarTrigger />
        {chrome?.back ? (
          <span className="flex min-w-0 items-center">{chrome.back}</span>
        ) : !reading && parent?.to ? (
          <Link
            to={parent.to}
            aria-label={`Back to ${parent.label}`}
            className={buttonVariants({
              variant: "ghost",
              size: "icon",
              className:
                "text-muted-foreground sm:hidden [@media(pointer:coarse)]:size-11",
            })}
          >
            <ArrowLeft aria-hidden="true" />
          </Link>
        ) : null}
      </div>
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center">
        <ol className="flex min-w-0 items-center gap-1.5">
          {showAncestors
            ? ancestors.map((ancestor) =>
                ancestor.to ? (
                  <li
                    key={ancestor.to}
                    className={`min-w-0 shrink items-center gap-1.5 ${
                      reading ? "flex" : "hidden sm:flex"
                    }`}
                  >
                    <Link
                      to={ancestor.to}
                      className="inline-flex max-w-[16rem] min-w-0 items-center rounded-sm text-support font-medium text-faint-foreground transition-colors duration-150 hover:text-foreground"
                    >
                      <span className="truncate">{ancestor.label}</span>
                    </Link>
                    <span
                      aria-hidden="true"
                      className="shrink-0 text-support text-faint-foreground"
                    >
                      /
                    </span>
                  </li>
                ) : null,
              )
            : null}
          <li
            className="flex min-w-0 shrink-[0.5] items-center"
            data-app-bar-title
          >
            {heading}
          </li>
        </ol>
      </nav>
      <div className="flex min-w-0 shrink-0 items-center gap-2" data-app-bar-trailing>
        <NewVersionButton />
        {chrome?.utility}
        {chrome?.status ? (
          <span className="inline-flex min-w-0">{chrome.status}</span>
        ) : null}
        {chrome?.action}
        {chrome?.menu ? (
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger
                render={
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        className={chrome.action ? "sm:hidden" : undefined}
                        aria-label="Page actions"
                      />
                    }
                  />
                }
              >
                <EllipsisVertical />
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={8}>
                Page actions
              </TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end">{chrome.menu}</DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      </div>
    </header>
  );
}
