import { useEffect, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { PageShell } from "../patterns/PageShell";
import { ErrorState } from "../patterns/StateCard";
import { usePageChrome } from "../shell/page-chrome";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { authClient } from "@/lib/auth-client";
import type { CourseRouteMatch } from "@/lib/course-location";
import { OrganizationScenariosSection } from "./organization-detail/scenarios";
import {
  type OrganizationDetailResponse,
  fetchJson,
} from "./organization-detail/types";

export function OrganizationCourses() {
  const { orgId } = useParams({ from: "/app/organizations/$orgId/courses" });
  return <OrganizationCoursesPage orgId={orgId} courseRoute={null} />;
}

export function OrganizationPublicCourseCatalog() {
  const { orgId, courseId } = useParams({
    from: "/app/organizations/$orgId/courses/public/$courseId",
  });
  return (
    <OrganizationCoursesPage
      orgId={orgId}
      courseRoute={{ scope: "organization-public", courseId }}
    />
  );
}

export function OrganizationPrivateCourseCatalog() {
  const { orgId, courseId } = useParams({
    from: "/app/organizations/$orgId/courses/private/$courseId",
  });
  return (
    <OrganizationCoursesPage
      orgId={orgId}
      courseRoute={{ scope: "organization-private", courseId }}
    />
  );
}

export function OrganizationGeneralPracticeCatalog() {
  const { orgId } = useParams({
    from: "/app/organizations/$orgId/courses/general-practice",
  });
  return (
    <OrganizationCoursesPage
      orgId={orgId}
      courseRoute={{
        scope: "organization-general-practice",
        courseId: "general-practice",
      }}
    />
  );
}

function OrganizationCoursesPage({
  orgId,
  courseRoute,
}: {
  orgId: string;
  courseRoute: CourseRouteMatch | null;
}) {
  const organization = useQuery({
    queryKey: ["organizations", orgId, "detail"],
    queryFn: () =>
      fetchJson<OrganizationDetailResponse>(
        `/api/organizations/${encodeURIComponent(orgId)}`,
      ),
    staleTime: 5_000,
  });
  const detail = organization.data?.organization;
  const detailId = detail?.id;
  const breadcrumbLabels = useMemo(
    () =>
      detailId
        ? { [`/organizations/${detailId}`]: "Organizations" }
        : undefined,
    [detailId],
  );
  usePageChrome({
    title: courseRoute
      ? undefined
      : detail
        ? `${detail.name} courses`
        : undefined,
    breadcrumbLabels: courseRoute ? undefined : breadcrumbLabels,
  });

  useEffect(() => {
    if (!detail?.id) return;
    void authClient.organization.setActive({ organizationId: detail.id });
  }, [detail?.id]);

  if (organization.error) {
    return (
      <PageShell width="content">
        <ErrorState
          title="Could not load organization courses"
          description={
            organization.error instanceof Error
              ? organization.error.message
              : "Failed to load organization"
          }
          onRetry={() => void organization.refetch()}
        />
      </PageShell>
    );
  }
  if (!detail) {
    return (
      <PageShell width="workspace">
        <div role="status" className="space-y-6">
          <span className="sr-only">Loading organization courses…</span>
          <Skeleton className="h-8 w-72 max-w-full" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell width={courseRoute ? "content" : "workspace"}>
      <div className="space-y-6">
        {!courseRoute ? (
          <Button
            variant="link"
            size="sm"
            className="-ml-1 h-9 px-1 sm:hidden"
            render={
              <Link to="/organizations/$orgId" params={{ orgId: detail.id }} />
            }
          >
            <ArrowLeft className="size-4" />
            Organization
          </Button>
        ) : null}
        <OrganizationScenariosSection
          detail={detail}
          courseRoute={courseRoute}
        />
      </div>
    </PageShell>
  );
}
