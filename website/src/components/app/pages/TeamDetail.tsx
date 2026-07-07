import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import {
  ArrowLeft,
  AtSign,
  BookOpen,
  Plus,
  Trash2,
  UserMinus,
} from "lucide-react";
import { PageHeader } from "../patterns/PageHeader";
import { ErrorState, LoadingState } from "../patterns/StateCard";
import { formatDurationMs, formatRelativeTime } from "../lib/format";
import { isValidGithubUsername } from "@/lib/github-username";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

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

export function TeamDetail() {
  const { orgId } = useParams({ from: "/app/teams/$orgId" });

  const team = useQuery({
    queryKey: ["teams", orgId, "detail"],
    queryFn: () => fetchJson<TeamDetailResponse>(`/api/teams/${encodeURIComponent(orgId)}`),
    staleTime: 5_000,
  });

  if (team.error) {
    return (
      <>
        <BackToTeams />
        <ErrorState
          title="Could not load team"
          description={
            team.error instanceof Error ? team.error.message : "Failed to load team"
          }
        />
      </>
    );
  }
  if (team.isLoading || !team.data) {
    return (
      <>
        <BackToTeams />
        <LoadingState title="Loading team" />
      </>
    );
  }

  const detail = team.data.team;
  const instructor = detail.role !== "member";

  return (
    <>
      <BackToTeams />
      <PageHeader
        eyebrow="Teams"
        title={detail.name}
        description={`${detail.members.length} member${detail.members.length === 1 ? "" : "s"} · created ${formatRelativeTime(detail.createdAt)}`}
      />
      <Tabs defaultValue="roster">
        <TabsList>
          <TabsTrigger value="roster">Roster</TabsTrigger>
          <TabsTrigger value="assignments">Assignments</TabsTrigger>
          {instructor ? (
            <TabsTrigger value="progress">Progress</TabsTrigger>
          ) : null}
        </TabsList>
        <TabsContent value="roster" className="pt-4">
          <RosterPanel orgId={orgId} detail={detail} instructor={instructor} />
        </TabsContent>
        <TabsContent value="assignments" className="pt-4">
          <AssignmentsPanel orgId={orgId} instructor={instructor} />
        </TabsContent>
        {instructor ? (
          <TabsContent value="progress" className="pt-4">
            <ProgressPanel orgId={orgId} />
          </TabsContent>
        ) : null}
      </Tabs>
    </>
  );
}

function BackToTeams() {
  return (
    <Button variant="ghost" className="-ml-3 w-fit" render={<Link to="/teams" />}>
      <ArrowLeft className="size-4" />
      Back to teams
    </Button>
  );
}

function RosterPanel({
  orgId,
  detail,
  instructor,
}: {
  orgId: string;
  detail: TeamDetailResponse["team"];
  instructor: boolean;
}) {
  const queryClient = useQueryClient();
  const [inviteName, setInviteName] = useState("");

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["teams", orgId] });

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
      await invalidate();
    },
  });

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

  const actionError = invite.error ?? revokeInvite.error ?? removeMember.error;

  return (
    <div className="space-y-4">
      {instructor ? (
        <form
          className="flex flex-wrap items-center gap-2"
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
              className="max-w-xs pl-8"
            />
          </div>
          <Button
            type="submit"
            disabled={!isValidGithubUsername(inviteName) || invite.isPending}
          >
            <Plus className="size-4" />
            Invite
          </Button>
        </form>
      ) : null}

      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead>GitHub</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Joined</TableHead>
              {instructor ? (
                <TableHead className="text-right">Actions</TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {detail.members.map((entry) => (
              <TableRow key={entry.memberId}>
                <TableCell className="text-sm font-medium">{entry.name}</TableCell>
                <TableCell className="font-mono text-xs">
                  {entry.githubUsername ?? "—"}
                </TableCell>
                <TableCell>
                  {entry.role === "member" ? (
                    <Badge variant="outline">Member</Badge>
                  ) : (
                    <Badge variant="secondary">Instructor</Badge>
                  )}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatRelativeTime(entry.joinedAt)}
                </TableCell>
                {instructor ? (
                  <TableCell className="text-right">
                    {entry.role !== "owner" ? (
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
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
            {detail.invites.map((entry) => (
              <TableRow key={entry.id} className="bg-muted/30">
                <TableCell className="text-sm text-muted-foreground">
                  Invited
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {entry.githubUsername}
                </TableCell>
                <TableCell>
                  <Badge variant="outline">Pending invite</Badge>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {formatRelativeTime(entry.createdAt)}
                </TableCell>
                <TableCell className="text-right">
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
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {actionError ? (
        <p className="text-sm text-destructive">
          {actionError instanceof Error ? actionError.message : "Action failed"}
        </p>
      ) : null}
    </div>
  );
}

function AssignmentsPanel({
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
      fetchJson<{ scenarios: Array<{ scenarioId: string; title: string }> }>(
        "/api/scenarios",
      ),
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

  if (assignments.error) {
    return (
      <ErrorState
        title="Could not load assignments"
        description={
          assignments.error instanceof Error
            ? assignments.error.message
            : "Failed to load assignments"
        }
      />
    );
  }
  if (assignments.isLoading) {
    return <LoadingState title="Loading assignments" />;
  }

  const entries = assignments.data?.assignments ?? [];
  const assignedIds = new Set(entries.map((entry) => entry.scenarioId));
  const assignable = (catalog.data?.scenarios ?? []).filter(
    (scenario) => !assignedIds.has(scenario.scenarioId),
  );

  return (
    <div className="space-y-4">
      {instructor && assignable.length ? (
        <div className="flex flex-wrap items-center gap-2">
          <select
            value={scenarioId}
            onChange={(event) => setScenarioId(event.target.value)}
            className="h-9 rounded-md border bg-background px-3 text-sm"
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
      ) : null}

      {entries.length ? (
        <div className="space-y-2">
          {entries.map((entry) => (
            <div
              key={entry.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border px-4 py-3"
            >
              <BookOpen className="size-4 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <Link
                  to="/scenarios/$scenarioId"
                  params={{ scenarioId: entry.scenarioId }}
                  className="text-sm font-medium hover:underline"
                >
                  {entry.scenarioTitle ?? entry.scenarioId}
                </Link>
                <p className="text-xs text-muted-foreground">
                  Assigned {formatRelativeTime(entry.createdAt)}
                </p>
              </div>
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
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {instructor
            ? "No scenarios assigned yet — pick one above to set the team's curriculum."
            : "No scenarios assigned yet."}
        </p>
      )}

      {assign.error ?? unassign.error ? (
        <p className="text-sm text-destructive">
          {(assign.error ?? unassign.error) instanceof Error
            ? ((assign.error ?? unassign.error) as Error).message
            : "Action failed"}
        </p>
      ) : null}
    </div>
  );
}

const PROGRESS_TONE: Record<string, string> = {
  not_started: "bg-muted/50 text-muted-foreground",
  in_progress: "bg-primary/15 text-primary",
  solved: "bg-success/15 text-success",
  assisted: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
};

const PROGRESS_LABEL: Record<string, string> = {
  not_started: "—",
  in_progress: "In progress",
  solved: "Solved",
  assisted: "Assisted",
};

function ProgressPanel({ orgId }: { orgId: string }) {
  const progress = useQuery({
    queryKey: ["teams", orgId, "progress"],
    queryFn: () =>
      fetchJson<ProgressResponse>(
        `/api/teams/${encodeURIComponent(orgId)}/progress`,
      ),
    staleTime: 10_000,
  });

  if (progress.error) {
    return (
      <ErrorState
        title="Could not load progress"
        description={
          progress.error instanceof Error
            ? progress.error.message
            : "Failed to load progress"
        }
      />
    );
  }
  if (progress.isLoading || !progress.data) {
    return <LoadingState title="Loading progress" />;
  }

  const { scenarios, rows } = progress.data.progress;
  if (!scenarios.length) {
    return (
      <p className="text-sm text-muted-foreground">
        Assign a scenario first — progress shows up here per member.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Member</TableHead>
            {scenarios.map((scenario) => (
              <TableHead key={scenario.scenarioId} className="min-w-32">
                {scenario.title ?? scenario.scenarioId}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
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
                      "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
                      PROGRESS_TONE[cell.status],
                    )}
                  >
                    {PROGRESS_LABEL[cell.status]}
                    {cell.solveDurationMs !== null ? (
                      <span className="font-normal opacity-75">
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
  );
}
