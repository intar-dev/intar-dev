import { useCallback, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Check, Plus, Users, X } from "lucide-react";
import { usePageChrome } from "../shell/page-chrome";
import { PageShell } from "../patterns/PageShell";
import { CardGridSkeleton } from "../patterns/Skeletons";
import { EmptyState, ErrorState } from "../patterns/StateCard";
import { InlineFeedback } from "../patterns/InlineFeedback";
import { formatRelativeTime } from "../lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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

  const createTeamReset = createTeam.reset;
  const openCreateDialog = useCallback(() => {
    setTeamName("");
    createTeamReset();
    setCreateOpen(true);
  }, [createTeamReset]);

  usePageChrome({
    action: useMemo(
      () => (
        <Button size="sm" onClick={openCreateDialog}>
          <Plus className="size-3.5" />
          New team
        </Button>
      ),
      [openCreateDialog],
    ),
  });

  return (
    <PageShell width="content">
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
          <div className="flex items-end justify-between gap-4">
            <div>
              <p className="text-eyebrow text-primary">Invitations</p>
              <h2 className="mt-1 text-section-title">Your next team is waiting</h2>
            </div>
            <span className="text-metadata tabular-nums">
              {invites.length} pending
            </span>
          </div>
          {invites.map((invite) => (
            <div
              key={invite.id}
              className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-brand-border bg-brand-subtle p-4 sm:p-6"
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
                  {declineInvite.isPending &&
                  declineInvite.variables === invite.id
                    ? "Declining…"
                    : "Decline"}
                </Button>
                <Button
                  size="sm"
                  disabled={acceptInvite.isPending || declineInvite.isPending}
                  onClick={() => acceptInvite.mutate(invite.id)}
                >
                  <Check className="size-3.5" />
                  {acceptInvite.isPending &&
                  acceptInvite.variables === invite.id
                    ? "Joining…"
                    : "Join team"}
                </Button>
              </div>
            </div>
          ))}
          {acceptInvite.error ? (
            <InlineFeedback tone="error">
              {acceptInvite.error instanceof Error
                ? acceptInvite.error.message
                : "Failed to accept invite"}
            </InlineFeedback>
          ) : null}
          {declineInvite.error ? (
            <InlineFeedback tone="error">
              {declineInvite.error instanceof Error
                ? declineInvite.error.message
                : "Failed to decline invite"}
            </InlineFeedback>
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
      ) : teams.isPending ? (
        <CardGridSkeleton cards={3} cardClassName="h-20" className="sm:grid-cols-1" />
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
        <div className="space-y-3">
          <div className="flex items-end justify-between gap-4">
            <h2 className="text-section-title">Your teams</h2>
            <span className="text-metadata tabular-nums">
              {entries.length} total
            </span>
          </div>
          {entries.map((team) => (
            <Link
              key={team.id}
              to="/teams/$orgId"
              params={{ orgId: team.id }}
              className="group block rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
            >
              <Card
                as="article"
                variant="interactive"
                className="gap-3 px-(--card-spacing) group-focus-visible:border-ring"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-card-title transition-colors group-hover:text-primary">
                      {team.name}
                    </h3>
                    <p className="mt-1 flex items-center gap-1.5 text-metadata">
                      <Users className="size-4" />
                      {team.memberCount} member
                      {team.memberCount === 1 ? "" : "s"} · created{" "}
                      {formatRelativeTime(team.createdAt)}
                    </p>
                  </div>
                  <Badge
                    variant={team.role === "member" ? "outline" : "secondary"}
                  >
                    {team.role === "member" ? "Member" : "Instructor"}
                  </Badge>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      ) : null}
    </PageShell>
  );
}
