import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { ArrowRight, Check, Plus, Users } from "lucide-react";
import { PageHeader } from "../patterns/PageHeader";
import { EmptyState, ErrorState, LoadingState } from "../patterns/StateCard";
import { formatRelativeTime } from "../lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
  const [creating, setCreating] = useState(false);
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
      setCreating(false);
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

  const entries = teams.data?.teams ?? [];
  const invites = teams.data?.invites ?? [];

  return (
    <>
      <PageHeader
        eyebrow="Teams"
        title="Teams"
        description="Learn together: instructors assign scenarios and track the roster's progress."
        actions={
          <Button onClick={() => setCreating((current) => !current)}>
            <Plus className="size-4" />
            New team
          </Button>
        }
      />

      {creating ? (
        <Card>
          <CardContent className="py-4">
            <form
              className="flex flex-wrap items-center gap-2"
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
                className="max-w-xs"
                autoFocus
              />
              <Button
                type="submit"
                disabled={teamName.trim().length < 2 || createTeam.isPending}
              >
                {createTeam.isPending ? "Creating…" : "Create"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setCreating(false)}
              >
                Cancel
              </Button>
              {createTeam.error ? (
                <p className="w-full text-sm text-destructive">
                  {createTeam.error instanceof Error
                    ? createTeam.error.message
                    : "Failed to create team"}
                </p>
              ) : null}
            </form>
          </CardContent>
        </Card>
      ) : null}

      {invites.length ? (
        <section className="space-y-2">
          <h2 className="text-sm font-medium text-muted-foreground">
            Invitations
          </h2>
          {invites.map((invite) => (
            <Card key={invite.id} className="py-0">
              <CardContent className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <p className="text-sm">
                  You've been invited to{" "}
                  <span className="font-medium">{invite.teamName}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {formatRelativeTime(invite.createdAt)}
                  </span>
                </p>
                <Button
                  size="sm"
                  disabled={acceptInvite.isPending}
                  onClick={() => acceptInvite.mutate(invite.id)}
                >
                  <Check className="size-3.5" />
                  Join team
                </Button>
              </CardContent>
            </Card>
          ))}
          {acceptInvite.error ? (
            <p className="text-sm text-destructive">
              {acceptInvite.error instanceof Error
                ? acceptInvite.error.message
                : "Failed to accept invite"}
            </p>
          ) : null}
        </section>
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
          icon={<Users className="size-6" />}
          title="No teams yet"
          description="Create a team to invite learners, assign scenarios, and follow everyone's progress."
        />
      ) : entries.length ? (
        <div className="space-y-2">
          {entries.map((team) => (
            <Card key={team.id} className="py-0">
              <CardContent className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <div className="min-w-0 flex-1 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      to="/teams/$orgId"
                      params={{ orgId: team.id }}
                      className="text-sm font-medium hover:underline"
                    >
                      {team.name}
                    </Link>
                    {team.role !== "member" ? (
                      <Badge variant="secondary">Instructor</Badge>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {team.memberCount} member{team.memberCount === 1 ? "" : "s"} ·
                    created {formatRelativeTime(team.createdAt)}
                  </p>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  render={<Link to="/teams/$orgId" params={{ orgId: team.id }} />}
                >
                  Open
                  <ArrowRight className="size-3.5" />
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : null}
    </>
  );
}
