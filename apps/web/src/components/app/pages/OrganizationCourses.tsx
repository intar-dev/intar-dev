import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowLeft, Building2 } from "lucide-react";
import { ContentHeader } from "../patterns/ContentHeader";
import { MetaLine } from "../patterns/MetaLine";
import { PageShell } from "../patterns/PageShell";
import { RelativeTime } from "../patterns/RelativeTime";
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
  usePageChrome({
    title: courseRoute
      ? undefined
      : detail
        ? `${detail.name} courses`
        : undefined,
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
    <PageShell width="workspace">
      <div className="space-y-6">
        <Button
          variant="ghost"
          size="sm"
          className="-ml-2"
          render={
            <Link to="/organizations/$orgId" params={{ orgId: detail.id }} />
          }
        >
          <ArrowLeft className="size-4" />
          Organization
        </Button>
        <ContentHeader
          title="Courses"
          summary={`${detail.name}'s public and private repair catalog.`}
          meta={
            <MetaLine
              items={[
                <span key="organization" className="inline-flex items-center gap-1.5">
                  <Building2 className="size-3.5" />
                  {detail.name}
                </span>,
                <span key="created">
                  created <RelativeTime at={detail.createdAt} />
                </span>,
              ]}
            />
          }
        />
        <OrganizationScenariosSection detail={detail} courseRoute={courseRoute} />
      </div>
    </PageShell>
  );
}
