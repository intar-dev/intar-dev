import { lazy, Suspense, useId, type ReactNode } from "react";
import { ChevronDown, EllipsisVertical, Trash2 } from "lucide-react";
import type { RunArtifactViewerState } from "@/components/app/RunArtifactViewer";
import { formatRelativeTime } from "@/components/app/lib/format";
import {
  COLLECTION_PAGE_SIZE,
  PaginatedCollection,
} from "@/components/app/patterns/CollectionPagination";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { adminScenarioRunArtifactContentPath } from "@/lib/artifact-content-paths";
import { cn } from "@/lib/utils";
import {
  artifactKindLabel,
  formatBytes,
  formatDurationMs,
  formatTimestampMs,
  milestoneLabel,
  runOutcomeTone,
  runStatusTone,
} from "./format";
import type {
  AgentRunArchiveHost,
  AgentVmRunArtifact,
  AgentVmRunRecord,
  AgentVmRunSummary,
} from "./types";

const LazyRunArtifactViewer = lazy(async () => {
  const { RunArtifactViewer } = await import("@/components/app/RunArtifactViewer");
  return { default: RunArtifactViewer };
});

export function archiveOwnerLabel(
  run: Pick<AgentVmRunSummary, "ownerName" | "ownerUsername" | "userId">,
) {
  if (run.ownerUsername?.trim()) return `@${run.ownerUsername.trim()}`;
  return run.ownerName.trim() || run.userId;
}

export function canDeleteArchivedRun(
  run: Pick<AgentVmRunSummary, "deleteBlockedReason">,
) {
  return run.deleteBlockedReason === null;
}

export function ScenarioRunArchiveCard(props: {
  host: AgentRunArchiveHost;
  run: AgentVmRunSummary;
  detail: AgentVmRunRecord | null;
  isDetailLoading: boolean;
  detailError: string | null;
  viewer: RunArtifactViewerState | null;
  isExpanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onStreamArtifact: (artifact: AgentVmRunArtifact) => void;
  isDeleting: boolean;
}) {
  const tone = runStatusTone(props.run.uploadStatus);
  const outcome = runOutcomeTone(props.run.outcome);
  const detailsId = useId();
  const scenarioName = props.run.scenarioMeta?.scenarioName ?? "Legacy run";
  const canDelete = canDeleteArchivedRun(props.run);
  const finishedAt =
    props.run.deletedAt ??
    props.run.uploadCompletedAt ??
    props.run.updatedAt ??
    props.run.createdAt;

  return (
    <article
      className="@container/archive-run py-4 first:pt-0 last:pb-0"
      data-archive-run={props.run.id}
    >
      <div className="grid gap-4 xl:grid-cols-[minmax(16rem,0.85fr)_minmax(30rem,1.35fr)_auto] xl:items-center">
        <div className="min-w-0 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={tone.badgeVariant}>{tone.label}</Badge>
            <Badge variant={outcome.badgeVariant}>{outcome.label}</Badge>
          </div>
          <h3 className="truncate text-sm font-semibold" title={scenarioName}>
            {scenarioName}
          </h3>
          <p className="truncate text-metadata">
            {props.run.scenarioMeta?.scenarioVmName ?? "Legacy VM"} ·{" "}
            {props.run.vmName}
          </p>
          <p className="flex flex-wrap items-center gap-x-1.5 text-metadata">
            <span className="font-medium text-foreground">
              {archiveOwnerLabel(props.run)}
            </span>
            <span aria-hidden="true">·</span>
            <span className="font-mono">{props.host.name}</span>
          </p>
          <p
            className="truncate font-mono text-xs text-muted-foreground"
            title={props.run.id}
          >
            {props.run.id}
          </p>
        </div>

        <dl
          className="grid grid-cols-2 gap-x-4 gap-y-3 border-y py-3 sm:grid-cols-4 xl:border-y-0 xl:py-0"
          aria-label={`${scenarioName} run summary`}
        >
          <ArchiveDefinition
            label="Finished"
            value={<ArchiveTime value={finishedAt} />}
          />
          <ArchiveDefinition
            label="Solve time"
            value={
              props.run.outcome === "succeeded"
                ? formatDurationMs(props.run.solveDurationMs)
                : "Not solved"
            }
          />
          <ArchiveDefinition
            label="Files"
            value={`${props.run.artifactCount} ${
              props.run.artifactCount === 1 ? "file" : "files"
            }`}
          />
          <ArchiveDefinition
            label="Activity"
            value={`${props.run.eventCount} ${
              props.run.eventCount === 1 ? "event" : "events"
            }`}
          />
        </dl>

        <div className="flex shrink-0 items-center gap-1.5 xl:justify-end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="min-h-11 sm:min-h-9"
            aria-expanded={props.isExpanded}
            aria-controls={detailsId}
            onClick={props.onToggle}
          >
            Details
            <ChevronDown
              className={cn(
                "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
                props.isExpanded && "rotate-180",
              )}
            />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="min-h-11 min-w-11 sm:min-h-9 sm:min-w-9"
                  aria-label={`Actions for ${scenarioName}`}
                />
              }
            >
              <EllipsisVertical className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem
                variant="destructive"
                onClick={props.onDelete}
                disabled={!canDelete || props.isDeleting}
              >
                <Trash2 className="size-4" />
                {props.isDeleting
                  ? "Deleting…"
                  : canDelete
                    ? "Delete run…"
                    : deleteBlockedLabel(props.run.deleteBlockedReason)}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {props.isExpanded ? (
        <div
          id={detailsId}
          className="mt-4 border-t bg-muted/20 px-4 py-5 sm:px-6"
        >
          {props.isDetailLoading ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading run details…
            </p>
          ) : props.detailError ? (
            <div
              role="alert"
              className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive"
            >
              {props.detailError}
            </div>
          ) : props.detail ? (
            <ArchiveRunDetails
              run={props.detail}
              viewer={props.viewer}
              onStreamArtifact={props.onStreamArtifact}
            />
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

function deleteBlockedLabel(
  reason: AgentVmRunSummary["deleteBlockedReason"],
) {
  switch (reason) {
    case "archive_in_progress":
      return "Delete after archive finishes";
    case "vm_teardown_pending":
      return "Delete after VM teardown";
    case "artifact_upload_pending":
      return "Delete after file upload";
    case null:
      return "Delete run…";
    default:
      return "Delete unavailable";
  }
}

function ArchiveRunDetails(props: {
  run: AgentVmRunRecord;
  viewer: RunArtifactViewerState | null;
  onStreamArtifact: (artifact: AgentVmRunArtifact) => void;
}) {
  return (
    <div className="space-y-6">
      <dl className="grid gap-x-5 gap-y-3 border-b pb-5 sm:grid-cols-2 xl:grid-cols-4">
        <ArchiveDefinition
          label="Created"
          value={formatTimestampMs(props.run.vmCreatedAt)}
        />
        <ArchiveDefinition
          label="Delete requested"
          value={formatTimestampMs(props.run.deleteRequestedAt)}
        />
        <ArchiveDefinition label="Upload state" value={props.run.uploadStatus} />
        <ArchiveDefinition
          label="User ID"
          value={<span className="font-mono text-xs">{props.run.userId}</span>}
        />
      </dl>

      {props.run.uploadError ? (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {props.run.uploadError}
        </div>
      ) : null}

      <div className="grid gap-8 xl:grid-cols-[minmax(0,0.4fr)_minmax(0,0.6fr)]">
        <section aria-labelledby={`run-${props.run.id}-milestones`}>
          <div className="flex items-center justify-between gap-2">
            <h4
              id={`run-${props.run.id}-milestones`}
              className="text-sm font-semibold"
            >
              Milestones
            </h4>
            <Badge variant="outline">{props.run.events.length}</Badge>
          </div>
          {props.run.events.length ? (
            <PaginatedCollection
              items={props.run.events}
              pageSize={COLLECTION_PAGE_SIZE.dense}
              itemLabel="milestones"
            >
              {(visibleEvents) => (
                <ol className="mt-3 divide-y border-y">
                  {visibleEvents.map((event) => (
                    <li key={event.id} className="relative py-3 pl-5 text-sm">
                      <span className="absolute top-[1.15rem] left-0 size-2 rounded-full bg-primary" />
                      <p className="font-medium">{milestoneLabel(event.kind)}</p>
                      <p className="mt-0.5 text-metadata">
                        {event.message ?? "No detail"}
                      </p>
                      <p className="mt-1 text-caption">
                        {formatTimestampMs(event.createdAt)}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </PaginatedCollection>
          ) : (
            <p className="mt-3 border-y py-4 text-metadata">
              No run events recorded.
            </p>
          )}
        </section>

        <section aria-labelledby={`run-${props.run.id}-artifacts`}>
          <div className="flex items-center justify-between gap-2">
            <h4
              id={`run-${props.run.id}-artifacts`}
              className="text-sm font-semibold"
            >
              Artifacts
            </h4>
            <Badge variant="outline">{props.run.artifacts.length}</Badge>
          </div>
          {props.run.artifacts.length ? (
            <PaginatedCollection
              items={props.run.artifacts}
              pageSize={COLLECTION_PAGE_SIZE.list}
              itemLabel="artifacts"
            >
              {(visibleArtifacts) => (
                <div className="mt-3 divide-y overflow-hidden rounded-lg border bg-background">
                  {visibleArtifacts.map((artifact) => {
                    const className = cn(
                      "flex min-h-14 w-full flex-col justify-between gap-2 px-3 py-3 text-left text-sm transition-colors duration-150 motion-reduce:transition-none sm:flex-row sm:items-center",
                      props.viewer?.artifact.id === artifact.id
                        ? "bg-brand-subtle text-foreground"
                        : "text-muted-foreground hover:bg-muted/50 hover:text-foreground focus-visible:bg-muted/50 focus-visible:text-foreground",
                    );
                    const label = `${artifact.ordinal}. ${
                      artifact.kind === "ssh_recording_raw_bundle"
                        ? "Raw Recording Bundle"
                        : artifactKindLabel(artifact.kind)
                    }`;
                    const metadata = (
                      <>
                        <span className="min-w-0">
                          <span className="block font-medium text-foreground">
                            {label}
                          </span>
                          <span className="mt-0.5 block break-all text-xs">
                            {artifact.filename}
                          </span>
                        </span>
                        <span className="shrink-0 text-xs font-medium">
                          {formatBytes(artifact.sizeBytes)} ·{" "}
                          {artifact.kind === "ssh_recording_raw_bundle"
                            ? "Download"
                            : "Preview"}
                        </span>
                      </>
                    );

                    if (artifact.kind === "ssh_recording_raw_bundle") {
                      return (
                        <a
                          key={artifact.id}
                          className={className}
                          href={`${adminScenarioRunArtifactContentPath(props.run.id, artifact.id)}?download=1`}
                        >
                          {metadata}
                        </a>
                      );
                    }

                    return (
                      <button
                        key={artifact.id}
                        type="button"
                        className={className}
                        onClick={() => props.onStreamArtifact(artifact)}
                      >
                        {metadata}
                      </button>
                    );
                  })}
                </div>
              )}
            </PaginatedCollection>
          ) : (
            <p className="mt-3 rounded-lg border bg-background px-4 py-4 text-metadata">
              No archived files for this run.
            </p>
          )}

          {props.viewer ? (
            <div className="mt-4">
              <Suspense fallback={null}>
                <LazyRunArtifactViewer
                  viewer={props.viewer}
                  emptyDescription="Select an artifact from this run."
                />
              </Suspense>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}

function ArchiveDefinition({
  label,
  value,
}: {
  label: string;
  value: ReactNode;
}) {
  return (
    <div className="min-w-0">
      <dt className="text-eyebrow">{label}</dt>
      <dd className="mt-1 text-sm font-medium break-words tabular-nums">
        {value}
      </dd>
    </div>
  );
}

function ArchiveTime({ value }: { value: number | null | undefined }) {
  if (!value || !Number.isFinite(value)) return <>—</>;
  return (
    <time
      dateTime={new Date(value).toISOString()}
      title={formatTimestampMs(value)}
    >
      {formatRelativeTime(value)}
    </time>
  );
}
