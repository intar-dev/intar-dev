import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { CatalogSearch } from "./catalog-search";
import type { CourseRouteRef } from "./course-wire";

interface CourseLinkProps {
  route: CourseRouteRef;
  children: ReactNode;
  className?: string;
  search?: CatalogSearch;
}

export function CourseLink({
  route,
  children,
  className,
  search,
}: CourseLinkProps) {
  switch (route.scope) {
    case "public":
      return (
        <Link
          to="/courses/$courseId"
          params={{ courseId: route.courseId }}
          {...(search ? { search } : {})}
          className={className}
        >
          {children}
        </Link>
      );
    case "organization-public":
      return route.organizationId ? (
        <Link
          to="/organizations/$orgId/courses/public/$courseId"
          params={{ orgId: route.organizationId, courseId: route.courseId }}
          {...(search ? { search } : {})}
          className={className}
        >
          {children}
        </Link>
      ) : null;
    case "organization-private":
      return route.organizationId ? (
        <Link
          to="/organizations/$orgId/courses/private/$courseId"
          params={{ orgId: route.organizationId, courseId: route.courseId }}
          {...(search ? { search } : {})}
          className={className}
        >
          {children}
        </Link>
      ) : null;
  }
}

interface LectureLinkProps extends CourseLinkProps {
  lectureId: string;
}

export function LectureLink({
  route,
  lectureId,
  children,
  className,
}: LectureLinkProps) {
  switch (route.scope) {
    case "public":
      return (
        <Link
          to="/courses/$courseId/lectures/$lectureId"
          params={{ courseId: route.courseId, lectureId }}
          className={className}
        >
          {children}
        </Link>
      );
    case "organization-public":
      return route.organizationId ? (
        <Link
          to="/organizations/$orgId/courses/public/$courseId/lectures/$lectureId"
          params={{
            orgId: route.organizationId,
            courseId: route.courseId,
            lectureId,
          }}
          className={className}
        >
          {children}
        </Link>
      ) : null;
    case "organization-private":
      return route.organizationId ? (
        <Link
          to="/organizations/$orgId/courses/private/$courseId/lectures/$lectureId"
          params={{
            orgId: route.organizationId,
            courseId: route.courseId,
            lectureId,
          }}
          className={className}
        >
          {children}
        </Link>
      ) : null;
  }
}
