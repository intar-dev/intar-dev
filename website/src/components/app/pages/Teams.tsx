import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, Plus, Users, X } from "lucide-react";
import { PageShell } from "../patterns/PageShell";
import { EmptyState, ErrorState, LoadingState } from "../patterns/StateCard";
import { formatRelativeTime } from "../lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";

interface TeamSummary {
  id: string;
  name: string;
  slug: string;
  role: "owner" | "admin" | "member";
  memberCount: number;
  createdAt: number;
}

interface PendingInvite {
  id: string;
  organizationId: string;
  teamName: string;
  createdAt: number;
}

interface TeamsResponse {
  teams: TeamSummary[];
  invites: PendingInvite[];
}

export function Teams() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [createOpen, setCreateOpen] = useState(false);
  const [teamName, setTeamName] = useState("");

  const teams = useQuery({
    queryKey: ["teams", "list"],
    queryFn: async () => {
      const response = await fetch("/api/teams", {
        method: "GET",
        credentials: "include",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Failed to load teams (${response.status})`);
      }
      return (await response.json()) as TeamsResponse;
    },
    staleTime: 5_000,
  });

  const createTeam = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/teams", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: teamName.trim() }),
      });
      const body = (await response.json().catch(() => null)) as {
        team?: TeamSummary;
        error?: string;
      } | null;
      if (!response.ok || !body?.team) {
        throw new Error(body?.error ?? `Failed to create team (${response.status})`);
      }
      return body.team;
    },
    onSuccess: async (team) => {
      setCreateOpen(false);
      setTeamName("");
      await queryClient.invalidateQueries({ queryKey: ["teams"] });
      void navigate({ to: "/teams/$orgId", params: { orgId: team.id } });
    },
  });

  const acceptInvite = useMutation({
    mutationFn: async (inviteId: string) => {
      const response = await fetch(
        `/api/teams/invites/${encodeURIComponent(inviteId)}/accept`,
        { method: "POST", credentials: "include" },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Failed to accept invite (${response.status})`);
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["teams"] });
    },
  });

  const declineInvite = useMutation({
    mutationFn: async (inviteId: string) => {
      const response = await fetch(
        `/api/teams/invites/${encodeURIComponent(inviteId)}/decline`,
        { method: "POST", credentials: "include" },
      );
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(body?.error ?? `Failed to decline invite (${response.status})`);
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["teams"] });
    },
  });

  const entries = teams.data?.teams ?? [];
  const invites = teams.data?.invites ?? [];

  const openCreateDialog = () => {
    setTeamName("");
    createTeam.reset();
    setCreateOpen(true);
  };

  return (
    <PageShell
      title="Teams"
      description="Learn together — gather your group, assign scenarios, and follow everyone's progress."
      actions={
        <Button onClick={openCreateDialog}>
          <Plus className="size-4" />
          New team
        </Button>
      }
    >
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create a team</DialogTitle>
            <DialogDescription>
              Name your team, then invite learners and pick the scenarios you
              want them to work through.
            </DialogDescription>
          </DialogHeader>
          <form
            id="create-team-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (teamName.trim().length >= 2 && !createTeam.isPending) {
                createTeam.mutate();
              }
            }}
          >
            <Input
              value={teamName}
              onChange={(event) => setTeamName(event.target.value)}
              placeholder="Team name"
              aria-label="Team name"
              autoFocus
            />
            {createTeam.error ? (
              <p className="mt-2 text-sm text-destructive">
                {createTeam.error instanceof Error
                  ? createTeam.error.message
                  : "Failed to create team"}
              </p>
            ) : null}
          </form>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setCreateOpen(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              form="create-team-form"
              disabled={teamName.trim().length < 2 || createTeam.isPending}
            >
              {createTeam.isPending ? "Creating…" : "Create team"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {invites.length ? (
        <div className="space-y-3">
          {invites.map((invite) => (
            <div
              key={invite.id}
              className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-primary/30 bg-primary/5 p-4"
            >
              <div className="min-w-0">
                <p className="text-sm">
                  You&apos;ve been invited to{" "}
                  <span className="font-heading font-semibold">
                    {invite.teamName}
                  </span>
                </p>
                <p className="text-caption">
                  Invited {formatRelativeTime(invite.createdAt)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={acceptInvite.isPending || declineInvite.isPending}
                  onClick={() => declineInvite.mutate(invite.id)}
                >
                  <X className="size-3.5" />
                  Decline
                </Button>
                <Button
                  size="sm"
                  disabled={acceptInvite.isPending || declineInvite.isPending}
                  onClick={() => acceptInvite.mutate(invite.id)}
                >
                  <Check className="size-3.5" />
                  Join team
                </Button>
              </div>
            </div>
          ))}
          {acceptInvite.error ? (
            <p className="text-sm text-destructive">
              {acceptInvite.error instanceof Error
                ? acceptInvite.error.message
                : "Failed to accept invite"}
            </p>
          ) : null}
          {declineInvite.error ? (
            <p className="text-sm text-destructive">
              {declineInvite.error instanceof Error
                ? declineInvite.error.message
                : "Failed to decline invite"}
            </p>
          ) : null}
        </div>
      ) : null}

      {teams.error ? (
        <ErrorState
          title="Could not load teams"
          description={
            teams.error instanceof Error
              ? teams.error.message
              : "Failed to load teams"
          }
        />
      ) : teams.isLoading ? (
        <LoadingState title="Loading teams" />
      ) : !entries.length && !invites.length ? (
        <EmptyState
          icon={<Users />}
          title="Teams let you learn together"
          description="Create a team to invite learners, assign scenarios, and follow everyone's progress in one place."
          action={
            <Button onClick={openCreateDialog}>
              <Plus className="size-4" />
              Create team
            </Button>
          }
        />
      ) : entries.length ? (
        <div className="grid gap-4 md:grid-cols-2">
          {entries.map((team) => (
            <Link
              key={team.id}
              to="/teams/$orgId"
              params={{ orgId: team.id }}
              className="group flex flex-col gap-3 rounded-2xl border bg-card p-6 shadow-xs transition-colors hover:border-primary/40"
            >
              <div className="flex items-start justify-between gap-3">
                <h2 className="font-heading font-semibold transition-colors group-hover:text-primary">
                  {team.name}
                </h2>
                <Badge variant={team.role === "member" ? "outline" : "secondary"}>
                  {team.role === "member" ? "Member" : "Instructor"}
                </Badge>
              </div>
              <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <Users className="size-4" />
                {team.memberCount} member{team.memberCount === 1 ? "" : "s"} ·
                created {formatRelativeTime(team.createdAt)}
              </p>
            </Link>
          ))}
        </div>
      ) : null}
    </PageShell>
  );
}
