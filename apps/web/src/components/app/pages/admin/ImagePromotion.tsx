import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ImageUp, LockOpen } from "lucide-react";
import { formatRelativeTime } from "@/components/app/lib/format";
import { fetchJson, mutationResponse } from "@/components/app/pages/organization-detail/types";
import { ConfirmDialog } from "@/components/app/patterns/ConfirmDialog";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { Section } from "@/components/app/patterns/Section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  ImagePromotionView,
  PromotionPhase,
} from "@/control-plane/image-promotion";

const ENDPOINT = "/api/admin/image-promotion";

const PHASE_LABELS: Record<PromotionPhase, string> = {
  waiting: "Waiting",
  drained: "Runs paused, waiting to swap",
  promoting: "Swapping images",
  cleaning: "Cleaning up old images",
  verifying: "Checking the hosts",
  done: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
  released: "Runs reopened by an admin",
  yielded: "Stepped aside for an operator drain",
};

const ENDED = new Set<PromotionPhase>(["done", "failed", "cancelled", "released", "yielded"]);

type Confirm = { kind: "start"; revision: string; forced: boolean } | { kind: "release" } | null;

/**
 * Intar's image promotion: a public commit's new images go live at the next
 * idle moment. Admins can promote at once, promote a given revision (also
 * inside an operator drain), or end a promotion.
 */
export function ImagePromotionSection() {
  const queryClient = useQueryClient();
  const queryKey = ["image-promotion"];
  const view = useQuery({
    queryKey,
    queryFn: () => fetchJson<ImagePromotionView>(ENDPOINT),
    refetchInterval: 10_000,
  });
  const [revision, setRevision] = useState("");
  const [confirm, setConfirm] = useState<Confirm>(null);
  const change = useMutation({
    mutationFn: async (body: Record<string, string>) => {
      const response = await fetch(ENDPOINT, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      await mutationResponse(response, "The image promotion could not be changed");
    },
    onSuccess: async () => {
      setConfirm(null);
      setRevision("");
      await queryClient.invalidateQueries({ queryKey });
    },
  });
  if (!view.data) return null;
  const { attempt, holdingRuns, operatorDrained, pendingRevision, runningVms } = view.data;
  const active = attempt !== null && !ENDED.has(attempt.phase);
  const canPromoteNow = pendingRevision !== null && !holdingRuns;

  return (
    <Section
      density="compact"
      title="Image promotion"
      description="New scenario images go live at the next moment no VM is running. New runs pause only for the swap."
    >
      <div className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={holdingRuns ? "warning" : "success"}>
            {holdingRuns ? "New runs paused" : "Runs open"}
          </Badge>
          {operatorDrained ? <Badge variant="warning">Operator drain active</Badge> : null}
          <span className="text-muted-foreground">
            {runningVms} VM{runningVms === 1 ? "" : "s"} running
          </span>
        </div>
        {attempt ? (
          <dl className="grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-label">Revision</dt>
              <dd className="mt-1 font-mono text-xs break-all">{attempt.revision}</dd>
            </div>
            <div>
              <dt className="text-label">Status</dt>
              <dd className="mt-1">
                {PHASE_LABELS[attempt.phase]}
                {attempt.origin === "admin" ? " · started by an admin" : ""}
              </dd>
            </div>
            <div>
              <dt className="text-label">Started</dt>
              <dd className="mt-1">{formatRelativeTime(attempt.createdAt)}</dd>
            </div>
          </dl>
        ) : (
          <p className="text-muted-foreground">No image promotion has run yet.</p>
        )}
        {attempt?.detail ? <p className="text-muted-foreground">{attempt.detail}</p> : null}
        {canPromoteNow || active ? (
          <div className="flex flex-wrap gap-2">
            {canPromoteNow ? (
              <Button
                disabled={change.isPending}
                onClick={() => setConfirm({ kind: "start", revision: pendingRevision, forced: true })}
              >
                <ImageUp className="size-4" />
                Promote now
              </Button>
            ) : null}
            {active ? (
              <Button
                variant="outline"
                disabled={change.isPending}
                onClick={() => setConfirm({ kind: "release" })}
              >
                <LockOpen className="size-4" />
                {holdingRuns ? "Reopen runs" : "Cancel promotion"}
              </Button>
            ) : null}
          </div>
        ) : null}
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (revision.trim()) {
              setConfirm({ kind: "start", revision: revision.trim(), forced: false });
            }
          }}
        >
          <Input
            value={revision}
            onChange={(event) => setRevision(event.target.value)}
            placeholder="Candidate revision"
            className="max-w-sm font-mono"
            aria-label="Candidate revision"
          />
          <Button
            type="submit"
            variant="outline"
            disabled={!revision.trim() || holdingRuns || change.isPending}
          >
            Promote a revision
          </Button>
        </form>
        {change.error && confirm === null ? (
          <InlineFeedback tone="error">{change.error.message}</InlineFeedback>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirm !== null}
        onClose={() => {
          setConfirm(null);
          change.reset();
        }}
        title={
          confirm?.kind === "release"
            ? holdingRuns
              ? "Reopen runs?"
              : "Cancel this promotion?"
            : confirm?.forced
              ? "Promote the new images now?"
              : `Promote ${confirm?.revision ?? "this revision"}?`
        }
        description={
          confirm?.kind === "release"
            ? attempt?.committedAt
              ? "The images are already swapped. Runs reopen now, and the cleanup and host checks are left to finish on their own."
              : "Nothing is swapped. This revision will not be promoted automatically again; you can still promote it here."
            : "Once the images are ready, Intar pauses new runs without waiting for an idle moment, lets active runs finish, swaps the images and reopens runs. An operator drain stays in place."
        }
        error={change.error ? change.error.message : null}
        pending={change.isPending}
        confirmLabel={confirm?.kind === "release" ? (holdingRuns ? "Reopen runs" : "Cancel promotion") : "Promote"}
        pendingLabel={confirm?.kind === "release" ? "Reopening…" : "Starting…"}
        onConfirm={() =>
          change.mutate(
            confirm?.kind === "start"
              ? { action: "start", revision: confirm.revision }
              : { action: "release" },
          )
        }
      />
    </Section>
  );
}
