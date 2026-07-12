import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import {
  ArrowLeftRight,
  AtSign,
  BookOpen,
  LogOut,
  Plus,
  Trash2,
  UserMinus,
} from "lucide-react";
import { PageShell } from "../patterns/PageShell";
import { ContentHeader } from "../patterns/ContentHeader";
import { Section } from "../patterns/Section";
import { InlineFeedback } from "../patterns/InlineFeedback";
import { ErrorState } from "../patterns/StateCard";
import {
  MetaDifficulty,
  MetaLine,
  type ScenarioDifficulty,
} from "../patterns/MetaLine";
import { RelativeTime } from "../patterns/RelativeTime";
import { formatDurationMs, formatRelativeTime } from "../lib/format";
import { usePageChrome } from "../shell/page-chrome";
import { isValidGithubUsername } from "@/lib/github-username";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { TeamDetailTab } from "./tab-search";

type TeamRole = "owner" | "admin" | "member";

interface TeamDetailResponse {
  team: {
    id: string;
    name: string;
    slug: string;
    createdAt: number;
    role: TeamRole;
    members: Array<{
      memberId: string;
      userId: string;
      name: string;
      githubUsername: string | null;
      role: TeamRole;
      joinedAt: number;
    }>;
    invites: Array<{
      id: string;
      githubUsername: string;
      status: string;
      createdAt: number;
    }>;
  };
}

interface AssignmentsResponse {
  assignments: Array<{
    id: string;
    scenarioId: string;
    scenarioTitle: string | null;
    createdAt: number;
  }>;
}

interface ProgressResponse {
  progress: {
    scenarios: Array<{ scenarioId: string; title: string | null }>;
    rows: Array<{
      userId: string;
      name: string;
      githubUsername: string | null;
      cells: Array<{
        scenarioId: string;
        status: "not_started" | "in_progress" | "solved" | "assisted";
        solveDurationMs: number | null;
        runId: string | null;
      }>;
    }>;
  };
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { method: "GET", credentials: "include" });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return (await response.json()) as T;
}


function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  const letters = parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
  return letters || "?";
}

export function TeamDetail() {
  const { orgId } = useParams({ from: "/app/teams/$orgId" });
  const routeSearch = useSearch({ from: "/app/teams/$orgId" });
  const navigate = useNavigate();

  const team = useQuery({
    queryKey: ["teams", orgId, "detail"],
    queryFn: () => fetchJson<TeamDetailResponse>(`/api/teams/${encodeURIComponent(orgId)}`),
    staleTime: 5_000,
  });

  usePageChrome({ title: team.data?.team.name });
  const requestedTab = routeSearch.tab ?? "overview";
  const canViewProgress = team.data?.team.role !== "member";
  const activeTab: TeamDetailTab =
    requestedTab === "progress" && !canViewProgress
      ? "overview"
      : requestedTab;

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
            team.error instanceof Error ? team.error.message : "Failed to load team"
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
          <TeamOverview detail={detail} instructor={instructor} setTab={setTab} />
        </TabsContent>
        <TabsContent value="people" className="space-y-4">
          {instructor ? (
            <div className="flex justify-end">
              <InviteMemberDialog orgId={orgId} />
            </div>
          ) : null}
          <MembersSection orgId={orgId} detail={detail} instructor={instructor} />
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

function TeamOverview({
  detail,
  instructor,
  setTab,
}: {
  detail: TeamDetailResponse["team"];
  instructor: boolean;
  setTab: (tab: TeamDetailTab) => void;
}) {
  return (
    <Section
      variant="flat"
      title="Workshop roster"
      description="The people and learning work connected to this team."
    >
      <dl className="grid gap-4 sm:grid-cols-3">
        <div className="border-l-2 border-primary pl-4">
          <dt className="text-eyebrow">Members</dt>
          <dd>
            <span className="mt-1 block text-section-title tabular-nums">
              {detail.members.length}
            </span>
            <Button
              type="button"
              variant="link"
              className="mt-1 h-auto p-0"
              onClick={() => setTab("people")}
            >
              Review roster
            </Button>
          </dd>
        </div>
        <div className="border-l-2 border-border pl-4">
          <dt className="text-eyebrow">Pending invites</dt>
          <dd>
            <span className="mt-1 block text-section-title tabular-nums">
              {detail.invites.length}
            </span>
            <span className="mt-1 block text-metadata">
              {instructor ? "Waiting for a response" : "Managed by instructors"}
            </span>
          </dd>
        </div>
        <div className="border-l-2 border-border pl-4">
          <dt className="text-eyebrow">Your role</dt>
          <dd>
            <span className="mt-1 block text-section-title capitalize">
              {detail.role === "admin" ? "Instructor" : detail.role}
            </span>
            <Button
              type="button"
              variant="link"
              className="mt-1 h-auto p-0"
              onClick={() => setTab("assignments")}
            >
              Open assignments
            </Button>
          </dd>
        </div>
      </dl>
    </Section>
  );
}

function InviteMemberDialog({ orgId }: { orgId: string }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [inviteName, setInviteName] = useState("");

  const invite = useMutation({
    mutationFn: async () => {
      const response = await fetch(
        `/api/teams/${encodeURIComponent(orgId)}/invites`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ username: inviteName.trim() }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Failed to invite (${response.status})`);
      }
    },
    onSuccess: async () => {
      setInviteName("");
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: ["teams", orgId] });
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) {
          setInviteName("");
          invite.reset();
        }
      }}
    >
      <DialogTrigger
        render={
          <Button>
            <Plus className="size-4" />
            Invite member
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Invite a member</DialogTitle>
          <DialogDescription>
            Invite someone by their GitHub username — the invitation shows up
            on their Teams page.
          </DialogDescription>
        </DialogHeader>
        <form
          id="invite-member-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (isValidGithubUsername(inviteName) && !invite.isPending) {
              invite.mutate();
            }
          }}
        >
          <div className="relative">
            <AtSign className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={inviteName}
              onChange={(event) => setInviteName(event.target.value)}
              placeholder="GitHub username"
              aria-label="GitHub username"
              className="pl-8"
              autoFocus
            />
          </div>
          {invite.error ? (
            <p className="mt-2 text-sm text-destructive">
              {invite.error instanceof Error
                ? invite.error.message
                : "Failed to invite"}
            </p>
          ) : null}
        </form>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="submit"
            form="invite-member-form"
            disabled={!isValidGithubUsername(inviteName) || invite.isPending}
          >
            {invite.isPending ? "Inviting…" : "Send invite"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MembersSection({
  orgId,
  detail,
  instructor,
}: {
  orgId: string;
  detail: TeamDetailResponse["team"];
  instructor: boolean;
}) {
  const queryClient = useQueryClient();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["teams", orgId] });

  const revokeInvite = useMutation({
    mutationFn: async (inviteId: string) => {
      const response = await fetch(
        `/api/teams/${encodeURIComponent(orgId)}/invites/${encodeURIComponent(inviteId)}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!response.ok && response.status !== 204) {
        throw new Error(`Failed to revoke invite (${response.status})`);
      }
    },
    onSuccess: invalidate,
  });

  const removeMember = useMutation({
    mutationFn: async (memberId: string) => {
      const response = await fetch(
        `/api/teams/${encodeURIComponent(orgId)}/members/${encodeURIComponent(memberId)}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!response.ok && response.status !== 204) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Failed to remove member (${response.status})`);
      }
    },
    onSuccess: invalidate,
  });

  const changeRole = useMutation({
    mutationFn: async (params: {
      memberId: string;
      role: "admin" | "member";
    }) => {
      const response = await fetch(
        `/api/teams/${encodeURIComponent(orgId)}/members/${encodeURIComponent(params.memberId)}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: params.role }),
        },
      );
      if (!response.ok && response.status !== 204) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Failed to change role (${response.status})`);
      }
    },
    onSuccess: invalidate,
  });

  const actionError = revokeInvite.error ?? removeMember.error ?? changeRole.error;

  return (
    <Section
      title="Members"
      description={
        instructor
          ? "Everyone on the roster, including pending invitations."
          : null
      }
    >
      <ul className="divide-y">
        {detail.members.map((entry) => (
          <li
            key={entry.memberId}
            className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0"
          >
            <Avatar>
              <AvatarFallback>{initials(entry.name)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{entry.name}</p>
              <p className="text-caption">
                {entry.githubUsername ? `@${entry.githubUsername} · ` : ""}
                joined {formatRelativeTime(entry.joinedAt)}
              </p>
            </div>
            {instructor && entry.role !== "owner" ? (
              <select
                value={entry.role}
                onChange={(event) =>
                  changeRole.mutate({
                    memberId: entry.memberId,
                    role: event.target.value as "admin" | "member",
                  })
                }
                disabled={changeRole.isPending}
                className="h-11 rounded-lg border bg-card px-3 text-sm"
                aria-label={`Role for ${entry.name}`}
              >
                <option value="admin">Instructor</option>
                <option value="member">Member</option>
              </select>
            ) : (
              <Badge variant={entry.role === "member" ? "outline" : "secondary"}>
                {entry.role === "owner"
                  ? "Owner"
                  : entry.role === "member"
                    ? "Member"
                    : "Instructor"}
              </Badge>
            )}
            {instructor && entry.role !== "owner" ? (
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                disabled={removeMember.isPending}
                onClick={() => removeMember.mutate(entry.memberId)}
              >
                <UserMinus className="size-3.5" />
                Remove
              </Button>
            ) : null}
          </li>
        ))}
        {detail.invites.map((entry) => (
          <li
            key={entry.id}
            className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0"
          >
            <Avatar>
              <AvatarFallback>
                <AtSign className="size-3.5" />
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1">
              <p className="font-mono text-sm">@{entry.githubUsername}</p>
              <p className="text-caption">
                Invited {formatRelativeTime(entry.createdAt)}
              </p>
            </div>
            <Badge variant="outline">Pending invite</Badge>
            {instructor ? (
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-destructive"
                disabled={revokeInvite.isPending}
                onClick={() => revokeInvite.mutate(entry.id)}
              >
                <Trash2 className="size-3.5" />
                Revoke
              </Button>
            ) : null}
          </li>
        ))}
      </ul>
      {actionError ? (
        <InlineFeedback tone="error" className="mt-3">
          {actionError instanceof Error ? actionError.message : "Action failed"}
        </InlineFeedback>
      ) : null}
    </Section>
  );
}

function AssignmentsSection({
  orgId,
  instructor,
}: {
  orgId: string;
  instructor: boolean;
}) {
  const queryClient = useQueryClient();
  const [scenarioId, setScenarioId] = useState("");

  const assignments = useQuery({
    queryKey: ["teams", orgId, "assignments"],
    queryFn: () =>
      fetchJson<AssignmentsResponse>(
        `/api/teams/${encodeURIComponent(orgId)}/assignments`,
      ),
    staleTime: 5_000,
  });

  const catalog = useQuery({
    queryKey: ["scenarios", "list"],
    queryFn: () =>
      fetchJson<{
        scenarios: Array<{
          scenarioId: string;
          title: string;
          difficulty: ScenarioDifficulty;
        }>;
      }>("/api/scenarios"),
    staleTime: 30_000,
    enabled: instructor,
  });

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["teams", orgId, "assignments"] });

  const assign = useMutation({
    mutationFn: async (target: string) => {
      const response = await fetch(
        `/api/teams/${encodeURIComponent(orgId)}/assignments`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scenarioId: target }),
        },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Failed to assign (${response.status})`);
      }
    },
    onSuccess: async () => {
      setScenarioId("");
      await invalidate();
    },
  });

  const unassign = useMutation({
    mutationFn: async (assignmentId: string) => {
      const response = await fetch(
        `/api/teams/${encodeURIComponent(orgId)}/assignments/${encodeURIComponent(assignmentId)}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!response.ok && response.status !== 204) {
        throw new Error(`Failed to remove assignment (${response.status})`);
      }
    },
    onSuccess: invalidate,
  });

  const entries = assignments.data?.assignments ?? [];
  const assignedIds = new Set(entries.map((entry) => entry.scenarioId));
  const assignable = (catalog.data?.scenarios ?? []).filter(
    (scenario) => !assignedIds.has(scenario.scenarioId),
  );
  const difficultyById = new Map(
    (catalog.data?.scenarios ?? []).map((scenario) => [
      scenario.scenarioId,
      scenario.difficulty,
    ]),
  );

  const actionError = assign.error ?? unassign.error;

  return (
    <Section
      title="Assignments"
      description={
        instructor
          ? "The scenarios this team is working through."
          : "The scenarios assigned to this team."
      }
      actions={
        instructor && assignable.length ? (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={scenarioId}
              onChange={(event) => setScenarioId(event.target.value)}
              className="h-11 rounded-lg border bg-card px-3 text-sm"
              aria-label="Scenario to assign"
            >
              <option value="">Choose a scenario…</option>
              {assignable.map((scenario) => (
                <option key={scenario.scenarioId} value={scenario.scenarioId}>
                  {scenario.title}
                </option>
              ))}
            </select>
            <Button
              disabled={!scenarioId || assign.isPending}
              onClick={() => assign.mutate(scenarioId)}
            >
              <Plus className="size-4" />
              Assign
            </Button>
          </div>
        ) : null
      }
    >
      {assignments.error ? (
        <p className="text-sm text-destructive">
          {assignments.error instanceof Error
            ? assignments.error.message
            : "Failed to load assignments"}
        </p>
      ) : assignments.isLoading ? (
        <p className="text-sm text-muted-foreground">Loading assignments…</p>
      ) : entries.length ? (
        <ul className="divide-y">
          {entries.map((entry) => {
            const difficulty = difficultyById.get(entry.scenarioId);
            return (
              <li
                key={entry.id}
                className="flex flex-wrap items-center gap-3 py-3 first:pt-0 last:pb-0"
              >
                <BookOpen className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <Link
                    to="/scenarios/$scenarioId"
                    params={{ scenarioId: entry.scenarioId }}
                    className="text-sm font-medium hover:underline"
                  >
                    {entry.scenarioTitle ?? entry.scenarioId}
                  </Link>
                  <p className="text-caption">
                    Assigned {formatRelativeTime(entry.createdAt)}
                  </p>
                </div>
                {difficulty ? <MetaDifficulty difficulty={difficulty} className="text-xs text-muted-foreground" /> : null}
                {instructor ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive"
                    disabled={unassign.isPending}
                    onClick={() => unassign.mutate(entry.id)}
                  >
                    <Trash2 className="size-3.5" />
                    Remove
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          {instructor
            ? "No scenarios assigned yet — pick one above to set the team's curriculum."
            : "No scenarios assigned yet."}
        </p>
      )}
      {actionError ? (
        <InlineFeedback tone="error" className="mt-3">
          {actionError instanceof Error ? actionError.message : "Action failed"}
        </InlineFeedback>
      ) : null}
    </Section>
  );
}

function TeamSettingsSection({
  orgId,
  detail,
  instructor,
}: {
  orgId: string;
  detail: TeamDetailResponse["team"];
  instructor: boolean;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const owner = detail.role === "owner";

  const [name, setName] = useState(detail.name);
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferTarget, setTransferTarget] = useState("");
  const [transferConfirm, setTransferConfirm] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [leaveConfirm, setLeaveConfirm] = useState("");

  const rename = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/teams/${encodeURIComponent(orgId)}`, {
        method: "PATCH",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Failed to rename team (${response.status})`);
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["teams"] });
    },
  });

  const transfer = useMutation({
    mutationFn: async () => {
      const response = await fetch(
        `/api/teams/${encodeURIComponent(orgId)}/transfer-ownership`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ memberId: transferTarget }),
        },
      );
      if (!response.ok && response.status !== 204) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to transfer ownership (${response.status})`,
        );
      }
    },
    onSuccess: async () => {
      setTransferOpen(false);
      setTransferTarget("");
      await queryClient.invalidateQueries({ queryKey: ["teams"] });
    },
  });

  const deleteTeam = useMutation({
    mutationFn: async () => {
      const response = await fetch(`/api/teams/${encodeURIComponent(orgId)}`, {
        method: "DELETE",
        credentials: "include",
      });
      if (!response.ok && response.status !== 204) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Failed to delete team (${response.status})`);
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["teams"] });
      void navigate({ to: "/teams" });
    },
  });

  const leave = useMutation({
    mutationFn: async () => {
      const response = await fetch(
        `/api/teams/${encodeURIComponent(orgId)}/leave`,
        { method: "POST", credentials: "include" },
      );
      if (!response.ok && response.status !== 204) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Failed to leave team (${response.status})`);
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["teams"] });
      void navigate({ to: "/teams" });
    },
  });

  const transferCandidates = detail.members.filter(
    (entry) => entry.role !== "owner",
  );

  return (
    <Section
      title="Settings"
      description={instructor ? "Rename the team or manage its lifecycle." : null}
    >
      <div className="space-y-6">
        {instructor ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim().length >= 2 && !rename.isPending) {
                rename.mutate();
              }
            }}
          >
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              aria-label="Team name"
              className="max-w-xs"
            />
            <Button
              type="submit"
              variant="outline"
              disabled={
                name.trim().length < 2 ||
                name.trim() === detail.name ||
                rename.isPending
              }
            >
              {rename.isPending ? "Saving…" : "Rename"}
            </Button>
            {rename.error ? (
              <InlineFeedback tone="error" className="w-full">
                {rename.error instanceof Error
                  ? rename.error.message
                  : "Failed to rename team"}
              </InlineFeedback>
            ) : rename.isSuccess ? (
              <InlineFeedback tone="success" className="w-full">
                Team name updated.
              </InlineFeedback>
            ) : null}
          </form>
        ) : null}

        <div className="space-y-3 rounded-2xl border border-destructive/30 p-4">
          <p className="text-eyebrow text-destructive">Danger zone</p>
          {owner ? (
            <div className="flex flex-wrap items-center gap-2">
              <Dialog
                open={transferOpen}
                onOpenChange={(next) => {
                  setTransferOpen(next);
                  if (!next) {
                    setTransferTarget("");
                    setTransferConfirm("");
                    transfer.reset();
                  }
                }}
              >
                <DialogTrigger
                  render={
                    <Button variant="outline" disabled={!transferCandidates.length}>
                      <ArrowLeftRight className="size-4" />
                      Transfer ownership
                    </Button>
                  }
                />
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Transfer ownership</DialogTitle>
                    <DialogDescription>
                      The new owner takes over the team; you stay on as an
                      instructor and can leave afterwards.
                    </DialogDescription>
                  </DialogHeader>
                  <select
                    value={transferTarget}
                    onChange={(event) => setTransferTarget(event.target.value)}
                    className="h-11 w-full rounded-lg border bg-card px-3 text-sm"
                    aria-label="New owner"
                  >
                    <option value="">Choose the new owner…</option>
                    {transferCandidates.map((entry) => (
                      <option key={entry.memberId} value={entry.memberId}>
                        {entry.name}
                        {entry.githubUsername ? ` (@${entry.githubUsername})` : ""}
                      </option>
                    ))}
                  </select>
                  <div className="space-y-2">
                    <label htmlFor="transfer-team-confirm" className="text-sm font-medium">
                      Type <span className="font-semibold">{detail.name}</span> to confirm
                    </label>
                    <Input
                      id="transfer-team-confirm"
                      value={transferConfirm}
                      onChange={(event) => setTransferConfirm(event.target.value)}
                      autoComplete="off"
                    />
                  </div>
                  {transfer.error ? (
                    <p className="text-sm text-destructive">
                      {transfer.error instanceof Error
                        ? transfer.error.message
                        : "Failed to transfer ownership"}
                    </p>
                  ) : null}
                  <DialogFooter>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setTransferOpen(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      disabled={
                        !transferTarget ||
                        transferConfirm !== detail.name ||
                        transfer.isPending
                      }
                      onClick={() => transfer.mutate()}
                    >
                      {transfer.isPending ? "Transferring…" : "Transfer ownership"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>

              <Dialog
                open={deleteOpen}
                onOpenChange={(next) => {
                  setDeleteOpen(next);
                  if (!next) {
                    setDeleteConfirm("");
                    deleteTeam.reset();
                  }
                }}
              >
                <DialogTrigger
                  render={
                    <Button variant="destructive">
                      <Trash2 className="size-4" />
                      Delete team
                    </Button>
                  }
                />
                <DialogContent>
                  <DialogHeader>
                    <DialogTitle>Delete this team?</DialogTitle>
                    <DialogDescription>
                      Members, invites and assignments are removed for good.
                      Everyone keeps their own scenario run history. Type{" "}
                      <span className="font-semibold">{detail.name}</span> to
                      confirm.
                    </DialogDescription>
                  </DialogHeader>
                  <Input
                    value={deleteConfirm}
                    onChange={(event) => setDeleteConfirm(event.target.value)}
                    placeholder={detail.name}
                    aria-label="Confirm team name"
                  />
                  {deleteTeam.error ? (
                    <p className="text-sm text-destructive">
                      {deleteTeam.error instanceof Error
                        ? deleteTeam.error.message
                        : "Failed to delete team"}
                    </p>
                  ) : null}
                  <DialogFooter>
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setDeleteOpen(false)}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="destructive"
                      disabled={deleteConfirm !== detail.name || deleteTeam.isPending}
                      onClick={() => deleteTeam.mutate()}
                    >
                      {deleteTeam.isPending ? "Deleting…" : "Delete team"}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
              {!transferCandidates.length ? (
                <p className="w-full text-caption">
                  Invite someone before transferring ownership.
                </p>
              ) : null}
            </div>
          ) : (
            <Dialog
              open={leaveOpen}
              onOpenChange={(next) => {
                setLeaveOpen(next);
                if (!next) {
                  setLeaveConfirm("");
                  leave.reset();
                }
              }}
            >
              <DialogTrigger
                render={
                  <Button variant="destructive">
                    <LogOut className="size-4" />
                    Leave team
                  </Button>
                }
              />
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Leave this team?</DialogTitle>
                  <DialogDescription>
                    You lose access to the team&apos;s assignments; your own
                    scenario run history is kept. An instructor can invite you
                    back later.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-2">
                  <label htmlFor="leave-team-confirm" className="text-sm font-medium">
                    Type <span className="font-semibold">{detail.name}</span> to confirm
                  </label>
                  <Input
                    id="leave-team-confirm"
                    value={leaveConfirm}
                    onChange={(event) => setLeaveConfirm(event.target.value)}
                    autoComplete="off"
                  />
                </div>
                {leave.error ? (
                  <p className="text-sm text-destructive">
                    {leave.error instanceof Error
                      ? leave.error.message
                      : "Failed to leave team"}
                  </p>
                ) : null}
                <DialogFooter>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setLeaveOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={leaveConfirm !== detail.name || leave.isPending}
                    onClick={() => leave.mutate()}
                  >
                    {leave.isPending ? "Leaving…" : "Leave team"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
        </div>
      </div>
    </Section>
  );
}

const PROGRESS_TONE: Record<string, string> = {
  not_started: "bg-muted/50 text-muted-foreground",
  in_progress: "border-brand-border bg-brand-subtle text-brand-text",
  solved: "border-success-border bg-success-subtle text-success",
  assisted: "border-warning-border bg-warning-subtle text-warning",
};

const PROGRESS_LABEL: Record<string, string> = {
  not_started: "—",
  in_progress: "In progress",
  solved: "Solved",
  assisted: "Assisted",
};

function ProgressSection({ orgId }: { orgId: string }) {
  const progress = useQuery({
    queryKey: ["teams", orgId, "progress"],
    queryFn: () =>
      fetchJson<ProgressResponse>(
        `/api/teams/${encodeURIComponent(orgId)}/progress`,
      ),
    staleTime: 10_000,
  });

  return (
    <Section
      title="Progress"
      description="Where each member stands on the assigned scenarios."
    >
      {progress.error ? (
        <p className="text-sm text-destructive">
          {progress.error instanceof Error
            ? progress.error.message
            : "Failed to load progress"}
        </p>
      ) : progress.isLoading || !progress.data ? (
        <p className="text-sm text-muted-foreground">Loading progress…</p>
      ) : !progress.data.progress.scenarios.length ? (
        <p className="text-sm text-muted-foreground">
          Assign a scenario first — progress shows up here per member.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Member</TableHead>
                {progress.data.progress.scenarios.map((scenario) => (
                  <TableHead key={scenario.scenarioId} className="min-w-32">
                    {scenario.title ?? scenario.scenarioId}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {progress.data.progress.rows.map((row) => (
                <TableRow key={row.userId}>
                  <TableCell>
                    <div className="space-y-0.5">
                      <p className="text-sm font-medium">{row.name}</p>
                      {row.githubUsername ? (
                        <p className="font-mono text-xs text-muted-foreground">
                          {row.githubUsername}
                        </p>
                      ) : null}
                    </div>
                  </TableCell>
                  {row.cells.map((cell) => (
                    <TableCell key={cell.scenarioId}>
                      <span
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium",
                          PROGRESS_TONE[cell.status],
                        )}
                      >
                        {PROGRESS_LABEL[cell.status]}
                        {cell.solveDurationMs !== null ? (
                          <span className="font-normal">
                            {formatDurationMs(cell.solveDurationMs)}
                          </span>
                        ) : null}
                      </span>
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Section>
  );
}
