import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { AtSign, BookOpen, Plus, Trash2, UserMinus, Users } from "lucide-react";
import { PageShell } from "../patterns/PageShell";
import { PageHeader } from "../patterns/PageHeader";
import { Section } from "../patterns/Section";
import { ErrorState, LoadingState } from "../patterns/StateCard";
import { DifficultyChip, MetaChip, type ScenarioDifficulty } from "../patterns/MetaChip";
import { formatDurationMs, formatRelativeTime } from "../lib/format";
import { useBreadcrumbLabel } from "../shell/breadcrumbs";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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

const BACK_LINK = { to: "/teams", label: "All teams" };

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

  const team = useQuery({
    queryKey: ["teams", orgId, "detail"],
    queryFn: () => fetchJson<TeamDetailResponse>(`/api/teams/${encodeURIComponent(orgId)}`),
    staleTime: 5_000,
  });

  useBreadcrumbLabel(team.data?.team.name);

  if (team.error) {
    return (
      <PageShell title="Team" showHeader={false}>
        <PageHeader title="Team" backLink={BACK_LINK} compact />
        <ErrorState
          title="Could not load team"
          description={
            team.error instanceof Error ? team.error.message : "Failed to load team"
          }
        />
      </PageShell>
    );
  }
  if (team.isLoading || !team.data) {
    return (
      <PageShell title="Team" showHeader={false}>
        <PageHeader title="Team" backLink={BACK_LINK} compact />
        <LoadingState title="Loading team" />
      </PageShell>
    );
  }

  const detail = team.data.team;
  const instructor = detail.role !== "member";

  return (
    <PageShell title={detail.name} showHeader={false}>
      <PageHeader
        backLink={BACK_LINK}
        title={detail.name}
        description={`Created ${formatRelativeTime(detail.createdAt)}`}
        meta={
          <>
            <Badge variant={instructor ? "secondary" : "outline"}>
              {instructor ? "Instructor" : "Member"}
            </Badge>
            <MetaChip icon={<Users />}>
              {detail.members.length} member
              {detail.members.length === 1 ? "" : "s"}
            </MetaChip>
          </>
        }
        actions={instructor ? <InviteMemberDialog orgId={orgId} /> : undefined}
      />
      <MembersSection orgId={orgId} detail={detail} instructor={instructor} />
      <AssignmentsSection orgId={orgId} instructor={instructor} />
      {instructor ? <ProgressSection orgId={orgId} /> : null}
    </PageShell>
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

  const actionError = revokeInvite.error ?? removeMember.error;

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
            <Badge variant={entry.role === "member" ? "outline" : "secondary"}>
              {entry.role === "member" ? "Member" : "Instructor"}
            </Badge>
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
        <p className="mt-3 text-sm text-destructive">
          {actionError instanceof Error ? actionError.message : "Action failed"}
        </p>
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
                {difficulty ? <DifficultyChip difficulty={difficulty} /> : null}
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
        <p className="mt-3 text-sm text-destructive">
          {actionError instanceof Error ? actionError.message : "Action failed"}
        </p>
      ) : null}
    </Section>
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
      )}
    </Section>
  );
}
