import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { SearchX, Users } from "lucide-react";
import { isAccessResponseError } from "../lib/http-response-error";
import { ContentHeader } from "../patterns/ContentHeader";
import { MetaLine } from "../patterns/MetaLine";
import { PageShell } from "../patterns/PageShell";
import { RelativeTime } from "../patterns/RelativeTime";
import { EmptyState, ErrorState } from "../patterns/StateCard";
import { usePageChrome } from "../shell/page-chrome";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { authClient } from "@/lib/auth-client";
import {
  appBootstrapQueryKey,
  type AppBootstrapData,
} from "@/lib/app-bootstrap";
import { useSession } from "../hooks/useSession";
import {
  AssignmentsSection,
  MembersSection,
  OrganizationOverview,
  ProgressSection,
} from "./organization-detail/people";
import { OrganizationSettingsSection } from "./organization-detail/settings";
import {
  type OrganizationDetailResponse,
  fetchJson,
} from "./organization-detail/types";
import {
  isOrganizationDetailTab,
  type OrganizationDetailTab,
} from "./tab-search";

import { MyServers } from "./MyServers";

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

  const queryClient = useQueryClient();
  const activeOrganizationId = useSession().data?.session.activeOrganizationId;
  useEffect(() => {
    if (!detail?.id || detail.id === activeOrganizationId) return;
    const organizationId = detail.id;
    void authClient.organization
      .setActive({ organizationId })
      .then(({ error }) => {
        if (error) return;
        // Record it locally so revisits skip the write until the next bootstrap.
        queryClient.setQueryData<AppBootstrapData>(
          appBootstrapQueryKey,
          (current) =>
            current?.session
              ? {
                  ...current,
                  session: {
                    ...current.session,
                    session: { ...current.session.session, activeOrganizationId: organizationId },
                  },
                }
              : current,
        );
      });
  }, [activeOrganizationId, detail?.id, queryClient]);

  // Search params may still contain a stale value in the address bar.
  // Normalize defensively here as well as in validateSearch so no invalid tab
  // leaves the controlled tab set without a selected panel.
  const requestedTab = isOrganizationDetailTab(routeSearch.tab)
    ? routeSearch.tab
    : "overview";
  const admin = detail?.role === "owner" || detail?.role === "admin";
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
    // A missing or forbidden organization cannot be fixed by retrying.
    if (isAccessResponseError(organization.error, true)) {
      return (
        <PageShell>
          <EmptyState
            icon={<SearchX />}
            title="Organization not found"
            description="It may have been deleted, or you no longer have access."
            action={
              <Button
                size="sm"
                variant="outline"
                render={<Link to="/organizations" />}
              >
                Back to organizations
              </Button>
            }
          />
        </PageShell>
      );
    }
    return (
      <PageShell>
        <ErrorState
          title="Could not load organization"
          description={
            organization.error instanceof Error
              ? organization.error.message
              : "Failed to load organization"
          }
          onRetry={() => organization.refetch()}
        />
      </PageShell>
    );
  }
  if (!detail) {
    return (
      <PageShell variant="workspace" density="compact">
        <div role="status" className="space-y-4">
          <span className="sr-only">Loading organization…</span>
          {/* The header and tab row, where the real ones land. */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <Skeleton className="h-8 w-72 max-w-full" />
              <Skeleton className="h-3 w-40" />
            </div>
            <Skeleton className="h-(--control-compact) w-20" />
          </div>
          <div className="flex gap-4 border-b pb-1">
            {Array.from({ length: 5 }, (_, index) => (
              <Skeleton key={index} className="h-7 w-20" />
            ))}
          </div>
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
    <PageShell variant="workspace" density="compact">
      <ContentHeader
        title={detail.name}
        badge={
          <Badge variant={admin ? "secondary" : "outline"}>{roleLabel}</Badge>
        }
        meta={
          <MetaLine
            items={[
              "Private workspace",
              <code key="slug" className="text-code">
                {detail.slug}
              </code>,
              <span key="members" className="inline-flex items-center gap-1.5">
                <Users className="size-3.5 shrink-0" />
                {detail.members.length} member
                {detail.members.length === 1 ? "" : "s"}
              </span>,
              <span key="created">
                Created <RelativeTime at={detail.createdAt} />
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
            <TabsTrigger value="servers">Servers</TabsTrigger>
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
            <ProgressSection
              detail={detail}
              onAssign={() => setTab("assignments")}
            />
          </TabsContent>
        ) : null}
        <TabsContent value="servers" className="min-w-0">
          <MyServers
            key={`${detail.id}:${detail.role}`}
            organizationId={detail.id}
            canManage={admin}
          />
        </TabsContent>
        <TabsContent value="settings" className="min-w-0">
          <OrganizationSettingsSection detail={detail} />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}
