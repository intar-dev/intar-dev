import { useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ContentHeader } from "../patterns/ContentHeader";
import { MetaLine } from "../patterns/MetaLine";
import { PageShell } from "../patterns/PageShell";
import { RelativeTime } from "../patterns/RelativeTime";
import { ErrorState } from "../patterns/StateCard";
import { usePageChrome } from "../shell/page-chrome";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AssignmentsSection,
  InviteMemberDialog,
  MembersSection,
  TeamOverview,
} from "./team-detail/roster";
import { ProgressSection, TeamSettingsSection } from "./team-detail/settings";
import { type TeamDetailResponse, fetchJson } from "./team-detail/types";
import type { TeamDetailTab } from "./tab-search";

export function TeamDetail() {
  const { orgId } = useParams({ from: "/app/teams/$orgId" });
  const routeSearch = useSearch({ from: "/app/teams/$orgId" });
  const navigate = useNavigate();

  const team = useQuery({
    queryKey: ["teams", orgId, "detail"],
    queryFn: () =>
      fetchJson<TeamDetailResponse>(`/api/teams/${encodeURIComponent(orgId)}`),
    staleTime: 5_000,
  });

  usePageChrome({ title: team.data?.team.name });
  const requestedTab = routeSearch.tab ?? "overview";
  const canViewProgress = team.data?.team.role !== "member";
  const activeTab: TeamDetailTab =
    requestedTab === "progress" && !canViewProgress ? "overview" : requestedTab;

  useEffect(() => {
    if (requestedTab !== activeTab) {
      void navigate({ to: ".", replace: true, search: {} });
    }
  }, [activeTab, navigate, requestedTab]);

  const setTab = (tab: TeamDetailTab) => {
    void navigate({
      to: ".",
      replace: true,
      search: tab === "overview" ? {} : { tab },
    });
  };

  if (team.error) {
    return (
      <PageShell width="content">
        <ErrorState
          title="Could not load team"
          description={
            team.error instanceof Error
              ? team.error.message
              : "Failed to load team"
          }
        />
      </PageShell>
    );
  }
  if (team.isPending || !team.data) {
    return (
      <PageShell width="content">
        <div role="status" className="space-y-6">
          <span className="sr-only">Loading…</span>
          <div className="space-y-2">
            <Skeleton className="h-7 w-64 max-w-full" />
            <Skeleton className="h-4 w-40" />
          </div>
          <Skeleton className="h-10 w-full max-w-md" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
      </PageShell>
    );
  }

  const detail = team.data.team;
  const instructor = detail.role !== "member";
  const roleLabel =
    detail.role === "owner"
      ? "Owner"
      : detail.role === "admin"
        ? "Instructor"
        : "Member";

  return (
    <PageShell width="content">
      <ContentHeader
        title={detail.name}
        badge={
          <Badge variant={instructor ? "secondary" : "outline"}>
            {roleLabel}
          </Badge>
        }
        meta={
          <MetaLine
            items={[
              `${detail.members.length} member${detail.members.length === 1 ? "" : "s"}`,
              <span key="created">
                created <RelativeTime at={detail.createdAt} />
              </span>,
            ]}
          />
        }
      />
      <Tabs
        value={activeTab}
        onValueChange={(value) => setTab(value as TeamDetailTab)}
        className="gap-6"
      >
        <div className="overflow-x-auto border-b">
          <TabsList variant="line" className="min-w-max pb-1">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="people">People</TabsTrigger>
            <TabsTrigger value="assignments">Assignments</TabsTrigger>
            {instructor ? (
              <TabsTrigger value="progress">Progress</TabsTrigger>
            ) : null}
            <TabsTrigger value="settings">Settings</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="overview">
          <TeamOverview
            detail={detail}
            instructor={instructor}
            setTab={setTab}
          />
        </TabsContent>
        <TabsContent value="people" className="space-y-4">
          {instructor ? (
            <div className="flex justify-end">
              <InviteMemberDialog orgId={orgId} />
            </div>
          ) : null}
          <MembersSection
            orgId={orgId}
            detail={detail}
            instructor={instructor}
          />
        </TabsContent>
        <TabsContent value="assignments">
          <AssignmentsSection orgId={orgId} instructor={instructor} />
        </TabsContent>
        {instructor ? (
          <TabsContent value="progress">
            <ProgressSection orgId={orgId} />
          </TabsContent>
        ) : null}
        <TabsContent value="settings">
          <TeamSettingsSection
            orgId={orgId}
            detail={detail}
            instructor={instructor}
          />
        </TabsContent>
      </Tabs>
    </PageShell>
  );
}
