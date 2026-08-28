import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { Building2 } from "lucide-react";
import { ContentHeader } from "../patterns/ContentHeader";
import { MetaLine } from "../patterns/MetaLine";
import { PageShell } from "../patterns/PageShell";
import { RelativeTime } from "../patterns/RelativeTime";
import { ErrorState } from "../patterns/StateCard";
import { usePageChrome } from "../shell/page-chrome";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { authClient } from "@/lib/auth-client";
import {
  AssignmentsSection,
  MembersSection,
  OrganizationOverview,
  ProgressSection,
} from "./organization-detail/people";
import { OrganizationRunnersSection } from "./organization-detail/runners";
import { OrganizationSettingsSection } from "./organization-detail/settings";
import {
  type OrganizationDetailResponse,
  fetchJson,
} from "./organization-detail/types";
import {
  isOrganizationDetailTab,
  type OrganizationDetailTab,
} from "./tab-search";

export function OrganizationDetail() {
  const { orgId } = useParams({ from: "/app/organizations/$orgId" });
  const routeSearch = useSearch({ from: "/app/organizations/$orgId" });
  const navigate = useNavigate();
  const organization = useQuery({
    queryKey: ["organizations", orgId, "detail"],
    queryFn: () =>
      fetchJson<OrganizationDetailResponse>(
        `/api/organizations/${encodeURIComponent(orgId)}`,
      ),
    staleTime: 5_000,
  });
  const detail = organization.data?.organization;
  usePageChrome({ title: detail?.name });

  useEffect(() => {
    if (!detail?.id) return;
    void authClient.organization.setActive({ organizationId: detail.id });
  }, [detail?.id]);

  // Search params may still contain a stale value in the address bar.
  // Normalize defensively here as well as in validateSearch so no invalid tab
  // leaves the controlled tab set without a selected panel.
  const requestedTab = isOrganizationDetailTab(routeSearch.tab)
    ? routeSearch.tab
    : "overview";
  const admin = detail?.role !== "member";
  const activeTab: OrganizationDetailTab =
    (requestedTab === "progress" || requestedTab === "settings") && !admin
      ? requestedTab === "settings"
        ? "settings"
        : "overview"
      : requestedTab;
  useEffect(() => {
    if (requestedTab !== activeTab) {
      void navigate({ to: ".", replace: true, search: {} });
    }
  }, [activeTab, navigate, requestedTab]);
  const setTab = (tab: OrganizationDetailTab) => {
    void navigate({
      to: ".",
      replace: true,
      search: tab === "overview" ? {} : { tab },
    });
  };

  if (organization.error) {
    return (
      <PageShell width="content">
        <ErrorState
          title="Could not load organization"
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
      <PageShell width="content">
        <div role="status" className="space-y-6">
          <span className="sr-only">Loading organization…</span>
          <Skeleton className="h-8 w-72 max-w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      </PageShell>
    );
  }

  const roleLabel =
    detail.role === "owner"
      ? "Owner"
      : detail.role === "admin"
        ? "Admin"
        : "Member";

  return (
    <PageShell width="workspace" density="compact">
      <ContentHeader
        title={detail.name}
        badge={
          <Badge variant={admin ? "secondary" : "outline"}>{roleLabel}</Badge>
        }
        summary={`Private workspace · ${detail.slug}`}
        meta={
          <MetaLine
            items={[
              <span key="members" className="inline-flex items-center gap-1.5">
                <Building2 className="size-3.5" />
                {detail.members.length} member
                {detail.members.length === 1 ? "" : "s"}
              </span>,
              <span key="created">
                created <RelativeTime at={detail.createdAt} />
              </span>,
            ]}
          />
        }
        actions={
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              render={
                <Link
                  to="/organizations/$orgId/courses"
                  params={{ orgId: detail.id }}
                />
              }
            >
              Courses
            </Button>
            <Button
              size="sm"
              variant="outline"
              render={
                <Link
                  to="/organizations/$orgId/workshops"
                  params={{ orgId: detail.id }}
                />
              }
            >
              Workshops
            </Button>
          </div>
        }
      />

      <Tabs
        value={activeTab}
        onValueChange={(value) => setTab(value as OrganizationDetailTab)}
        className="min-w-0 gap-4"
      >
        <div className="min-w-0 max-w-full overflow-x-auto border-b px-1 pt-1">
          <TabsList variant="line" className="min-w-max pb-1">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="people">Members</TabsTrigger>
            <TabsTrigger value="assignments">Assignments</TabsTrigger>
            {admin ? (
              <TabsTrigger value="progress">Progress</TabsTrigger>
            ) : null}
            <TabsTrigger value="runners">Runners</TabsTrigger>
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview" className="min-w-0">
          <OrganizationOverview
            detail={detail}
            setTab={setTab}
            onOpenCourses={() =>
              void navigate({
                to: "/organizations/$orgId/courses",
                params: { orgId: detail.id },
              })
            }
          />
        </TabsContent>
        <TabsContent value="people" className="min-w-0">
          <MembersSection detail={detail} />
        </TabsContent>
        <TabsContent value="assignments" className="min-w-0">
          <AssignmentsSection detail={detail} />
        </TabsContent>
        {admin ? (
          <TabsContent value="progress" className="min-w-0">
            <ProgressSection detail={detail} />
          </TabsContent>
        ) : null}
        <TabsContent value="runners" className="min-w-0">
          <OrganizationRunnersSection detail={detail} />
        </TabsContent>
        <TabsContent value="settings" className="min-w-0">
          <OrganizationSettingsSection detail={detail} />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}
