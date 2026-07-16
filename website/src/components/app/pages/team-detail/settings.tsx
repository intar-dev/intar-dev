import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ArrowLeftRight, LogOut, Trash2 } from "lucide-react";
import { InlineFeedback } from "../../patterns/InlineFeedback";
import { Section } from "../../patterns/Section";
import { formatDurationMs } from "../../lib/format";
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
import {
  type ProgressResponse,
  type TeamDetailResponse,
  fetchJson,
} from "./types";

export function TeamSettingsSection({
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
        throw new Error(
          body?.error ?? `Failed to rename team (${response.status})`,
        );
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
        throw new Error(
          body?.error ?? `Failed to delete team (${response.status})`,
        );
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
        throw new Error(
          body?.error ?? `Failed to leave team (${response.status})`,
        );
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
      description={
        instructor ? "Rename the team or manage its lifecycle." : null
      }
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
                    <Button
                      variant="outline"
                      disabled={!transferCandidates.length}
                    >
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
                        {entry.githubUsername
                          ? ` (@${entry.githubUsername})`
                          : ""}
                      </option>
                    ))}
                  </select>
                  <div className="space-y-2">
                    <label
                      htmlFor="transfer-team-confirm"
                      className="text-sm font-medium"
                    >
                      Type <span className="font-semibold">{detail.name}</span>{" "}
                      to confirm
                    </label>
                    <Input
                      id="transfer-team-confirm"
                      value={transferConfirm}
                      onChange={(event) =>
                        setTransferConfirm(event.target.value)
                      }
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
                      {transfer.isPending
                        ? "Transferring…"
                        : "Transfer ownership"}
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
                      disabled={
                        deleteConfirm !== detail.name || deleteTeam.isPending
                      }
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
                  <label
                    htmlFor="leave-team-confirm"
                    className="text-sm font-medium"
                  >
                    Type <span className="font-semibold">{detail.name}</span> to
                    confirm
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

export function ProgressSection({ orgId }: { orgId: string }) {
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
