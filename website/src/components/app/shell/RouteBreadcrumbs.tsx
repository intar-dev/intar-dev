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
import { Separator } from "@/components/ui/separator";
import { NAV_ITEMS } from "./nav-config";
import { useBreadcrumbOverrides } from "./breadcrumbs";

const SEGMENT_LABELS: Record<string, string> = {
  admin: "Admin",
  scenarios: "Scenarios",
  runs: "My runs",
  teams: "Teams",
  profile: "Profile",
  builds: "Builds",
  hosts: "Hosts",
  people: "People",
  authoring: "Authoring",
  new: "New",
};

function labelForSegment(
  path: string,
  segment: string,
  overrides: ReadonlyMap<string, string>,
): string {
  const override = overrides.get(path);
  if (override) return override;
  const navMatch = NAV_ITEMS.find((item) => item.to === path);
  if (navMatch) return navMatch.label;
  if (SEGMENT_LABELS[segment]) return SEGMENT_LABELS[segment];
  // Dynamic ids without an override yet — show a trimmed value.
  return segment.length > 16 ? `${segment.slice(0, 12)}…` : segment;
}

// Breadcrumbs only appear on nested pages; on depth-1 pages the page header
// carries the context and the top bar stays quiet.
export function RouteBreadcrumbs() {
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const overrides = useBreadcrumbOverrides();

  const segments = pathname.split("/").filter(Boolean);
  if (segments.length < 2) return null;

  const crumbs: Array<{ label: string; to?: string | undefined }> = [];
  let acc = "";
  segments.forEach((segment, index) => {
    acc += `/${segment}`;
    const isLast = index === segments.length - 1;
    crumbs.push({
      label: labelForSegment(acc, segment, overrides),
      to: isLast ? undefined : acc,
    });
  });

  return (
    <>
      <Separator
        orientation="vertical"
        className="mr-1 data-[orientation=vertical]:h-4"
      />
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
    </>
  );
}
