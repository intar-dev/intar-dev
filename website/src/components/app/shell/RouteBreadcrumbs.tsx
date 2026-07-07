import { Fragment } from "react";
import { Link, useRouterState } from "@tanstack/react-router";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { NAV_ITEMS } from "./nav-config";

const SEGMENT_LABELS: Record<string, string> = {
  admin: "Admin",
  scenarios: "Scenarios",
  runs: "Runs",
  teams: "Teams",
  profile: "Profile",
  builds: "Builds",
  onboarding: "Host onboarding",
  people: "People",
  authoring: "Authoring",
  new: "New",
};

function labelForSegment(path: string, segment: string): string {
  const navMatch = NAV_ITEMS.find((item) => item.to === path);
  if (navMatch) return navMatch.label;
  if (SEGMENT_LABELS[segment]) return SEGMENT_LABELS[segment];
  // Dynamic ids (run/scenario ids) — show a trimmed value.
  return segment.length > 16 ? `${segment.slice(0, 12)}…` : segment;
}

export function RouteBreadcrumbs() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });

  const segments = pathname.split("/").filter(Boolean);
  const crumbs: Array<{ label: string; to?: string | undefined }> = [];
  let acc = "";
  segments.forEach((segment, index) => {
    acc += `/${segment}`;
    const isLast = index === segments.length - 1;
    crumbs.push({
      label: labelForSegment(acc, segment),
      to: isLast ? undefined : acc,
    });
  });

  if (crumbs.length === 0) {
    crumbs.push({ label: "Home" });
  }

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb, index) => (
          <Fragment key={`${crumb.label}-${index}`}>
            {index > 0 ? <BreadcrumbSeparator /> : null}
            <BreadcrumbItem>
              {crumb.to ? (
                <BreadcrumbLink render={<Link to={crumb.to} />}>
                  {crumb.label}
                </BreadcrumbLink>
              ) : (
                <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
              )}
            </BreadcrumbItem>
          </Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
