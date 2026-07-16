import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AtSign, BookOpen, Plus, Trash2, UserMinus } from "lucide-react";
import { InlineFeedback } from "../../patterns/InlineFeedback";
import {
  MetaDifficulty,
  type ScenarioDifficulty,
} from "../../patterns/MetaLine";
import { Section } from "../../patterns/Section";
import { formatRelativeTime } from "../../lib/format";
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
import { isValidGithubUsername } from "@/lib/github-username";
import type { TeamDetailTab } from "../tab-search";
import {
  type AssignmentsResponse,
  type TeamDetailResponse,
  fetchJson,
  initials,
} from "./types";

export function TeamOverview({
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

export function InviteMemberDialog({ orgId }: { orgId: string }) {
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
            Invite someone by their GitHub username — the invitation shows up on
            their Teams page.
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
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpen(false)}
          >
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

export function MembersSection({
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
        throw new Error(
          body?.error ?? `Failed to remove member (${response.status})`,
        );
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
        throw new Error(
          body?.error ?? `Failed to change role (${response.status})`,
        );
      }
    },
    onSuccess: invalidate,
  });

  const actionError =
    revokeInvite.error ?? removeMember.error ?? changeRole.error;

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
              <Badge
                variant={entry.role === "member" ? "outline" : "secondary"}
              >
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

export function AssignmentsSection({
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
    queryClient.invalidateQueries({
      queryKey: ["teams", orgId, "assignments"],
    });

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
                {difficulty ? (
                  <MetaDifficulty
                    difficulty={difficulty}
                    className="text-xs text-muted-foreground"
                  />
                ) : null}
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
