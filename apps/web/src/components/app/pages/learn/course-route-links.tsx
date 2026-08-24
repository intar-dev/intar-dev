import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { courseRouteId } from "@/lib/course-location";
import type { CourseLocation } from "@/lib/scenario-runs";
import type { CatalogSearch } from "./catalog-search";

export function CourseScenarioLink({
  location,
  scenarioId,
  search,
  children,
  className,
  preloadDelay,
  fallbackOrganizationId,
}: {
  location: CourseLocation | null | undefined;
  scenarioId: string;
  search?: CatalogSearch | undefined;
  children: ReactNode;
  className?: string;
  preloadDelay?: number | undefined;
  fallbackOrganizationId?: string | null | undefined;
}) {
  const preload = preloadDelay === undefined ? {} : { preloadDelay };
  if (!location) {
    if (fallbackOrganizationId) {
      return (
        <Link
          to="/organizations/$orgId/courses"
          params={{ orgId: fallbackOrganizationId }}
          className={className}
          {...preload}
        >
          {children}
        </Link>
      );
    }
    return (
      <Link to="/courses" className={className} {...preload}>
        {children}
      </Link>
    );
  }

  const courseId = courseRouteId(location);
  switch (location.scope) {
    case "public":
      return (
        <Link
          to="/courses/$courseId/$scenarioId"
          params={{ courseId, scenarioId }}
          search={search ?? {}}
          className={className}
          {...preload}
        >
          {children}
        </Link>
      );
    case "organization-public":
      return location.organizationId ? (
        <Link
          to="/organizations/$orgId/courses/public/$courseId/$scenarioId"
          params={{
            orgId: location.organizationId,
            courseId,
            scenarioId,
          }}
          search={search ?? {}}
          className={className}
          {...preload}
        >
          {children}
        </Link>
      ) : null;
    case "organization-private":
      return location.organizationId ? (
        <Link
          to="/organizations/$orgId/courses/private/$courseId/$scenarioId"
          params={{
            orgId: location.organizationId,
            courseId,
            scenarioId,
          }}
          search={search ?? {}}
          className={className}
          {...preload}
        >
          {children}
        </Link>
      ) : null;
    case "organization-general-practice":
      return location.organizationId ? (
        <Link
          to="/organizations/$orgId/courses/general-practice/$scenarioId"
          params={{ orgId: location.organizationId, scenarioId }}
          search={search ?? {}}
          className={className}
          {...preload}
        >
          {children}
        </Link>
      ) : null;
  }
}

export function CourseCatalogLink({
  location,
  search,
  children,
  className,
}: {
  location: CourseLocation | null | undefined;
  search?: CatalogSearch | undefined;
  children: ReactNode;
  className?: string;
}) {
  if (!location) {
    return (
      <Link to="/courses" search={search ?? {}} className={className}>
        {children}
      </Link>
    );
  }

  if (location.scope === "public") {
    return (
      <Link
        to="/courses/$courseId"
        params={{ courseId: courseRouteId(location) }}
        search={search ?? {}}
        className={className}
      >
        {children}
      </Link>
    );
  }

  if (!location.organizationId) {
    return (
      <Link to="/courses" search={search ?? {}} className={className}>
        {children}
      </Link>
    );
  }

  switch (location.scope) {
    case "organization-public":
      return (
        <Link
          to="/organizations/$orgId/courses/public/$courseId"
          params={{ orgId: location.organizationId, courseId: courseRouteId(location) }}
          search={search ?? {}}
          className={className}
        >
          {children}
        </Link>
      );
    case "organization-private":
      return (
        <Link
          to="/organizations/$orgId/courses/private/$courseId"
          params={{ orgId: location.organizationId, courseId: courseRouteId(location) }}
          search={search ?? {}}
          className={className}
        >
          {children}
        </Link>
      );
    case "organization-general-practice":
      return (
        <Link
          to="/organizations/$orgId/courses/general-practice"
          params={{ orgId: location.organizationId }}
          search={search ?? {}}
          className={className}
        >
          {children}
        </Link>
      );
  }
}
