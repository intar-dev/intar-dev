import {
  RunArtifactViewer,
  type RunArtifactViewerState,
} from "@/components/app/RunArtifactViewer";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  artifactKindLabel,
  formatBytes,
  formatDurationMs,
  formatTimestampMs,
  milestoneLabel,
  runOutcomeTone,
  runStatusTone,
} from "./format";
import { Stat } from "@/components/app/patterns/Stat";
import {
  COLLECTION_PAGE_SIZE,
  PaginatedCollection,
} from "@/components/app/patterns/CollectionPagination";
import { scenarioRunArtifactContentPath } from "@/lib/artifact-content-paths";
import type {
  AgentHostApi,
  AgentVmRunArtifact,
  AgentVmRunRecord,
} from "./types";

export function ScenarioRunArchiveCard(props: {
  host: AgentHostApi;
  run: AgentVmRunRecord;
  viewer: RunArtifactViewerState | null;
  isExpanded: boolean;
  onToggle: () => void;
  onDelete: () => void;
  onStreamArtifact: (artifact: AgentVmRunArtifact) => void;
  isDeleting: boolean;
}) {
  const tone = runStatusTone(props.run.uploadStatus);
  const outcome = runOutcomeTone(props.run.outcome);

  return (
    <article className="overflow-hidden rounded-xl border bg-card shadow-xs">
      <div className={`h-1 w-full ${tone.rail}`} />
      <div className="flex flex-col gap-4 px-4 py-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={tone.badgeVariant}>{tone.label}</Badge>
            <Badge variant={outcome.badgeVariant}>{outcome.label}</Badge>
            <span className="text-xs font-semibold text-foreground">
              {props.run.scenarioMeta?.scenarioName ?? "Legacy run"}
            </span>
            <span aria-hidden="true" className="text-muted-foreground">
              ·
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {props.host.name}
            </span>
          </div>

          <div>
            <h3 className="text-lg font-semibold tracking-tight">
              {props.run.vmName}
            </h3>
            <p className="text-sm text-muted-foreground">
              {props.run.scenarioMeta?.scenarioVmName ?? "Legacy VM"} •{" "}
              {props.run.id}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat
              size="sm"
              label="Deleted"
              value={formatTimestampMs(props.run.deletedAt)}
            />
            <Stat
              size="sm"
              label="Uploaded"
              value={
                props.run.uploadCompletedAt
                  ? formatTimestampMs(props.run.uploadCompletedAt)
                  : props.run.uploadStartedAt
                    ? `Started ${formatTimestampMs(props.run.uploadStartedAt)}`
                    : "Pending"
              }
            />
            <Stat
              size="sm"
              label="Artifacts"
              value={String(props.run.artifacts.length)}
              detail={
                props.run.artifacts.length === 1
                  ? "file captured"
                  : "files captured"
              }
            />
            <Stat
              size="sm"
              label="Solve time"
              value={
                props.run.outcome === "succeeded"
                  ? formatDurationMs(props.run.solveDurationMs)
                  : "Not solved"
              }
              {...(props.run.solvedAt
                ? { detail: `Solved ${formatTimestampMs(props.run.solvedAt)}` }
                : props.run.outcome === "cancelled"
                  ? { detail: "Cancelled before solve" }
                  : {})}
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={props.onToggle}
          >
            {props.isExpanded ? "Hide details" : "Details"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={props.onDelete}
            disabled={props.isDeleting}
          >
            {props.isDeleting ? "Deleting..." : "Delete run"}
          </Button>
        </div>
      </div>

      <div
        className={`grid transition-all duration-300 ease-out motion-reduce:transition-none ${
          props.isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="grid gap-6 border-t px-4 py-4 xl:grid-cols-[minmax(0,0.4fr)_minmax(0,0.6fr)]">
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Stat
                  size="sm"
                  label="Created"
                  value={formatTimestampMs(props.run.vmCreatedAt)}
                />
                <Stat
                  size="sm"
                  label="Delete requested"
                  value={formatTimestampMs(props.run.deleteRequestedAt)}
                />
                <Stat
                  size="sm"
                  label="Upload state"
                  value={props.run.uploadStatus}
                />
                <Stat size="sm" label="Owner" value={props.run.userId} />
              </div>

              {props.run.uploadError ? (
                <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                  {props.run.uploadError}
                </div>
              ) : null}

              <div className="rounded-xl bg-muted/40 p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">Milestones</p>
                  <Badge variant="outline">{props.run.events.length}</Badge>
                </div>
                {props.run.events.length ? (
                  <PaginatedCollection
                    items={props.run.events}
                    pageSize={COLLECTION_PAGE_SIZE.dense}
                    itemLabel="milestones"
                  >
                    {(visibleEvents) => (
                      <div className="mt-4 space-y-4">
                        {visibleEvents.map((event) => (
                          <div
                            key={event.id}
                            className="relative min-h-11 py-1 pl-5 text-sm"
                          >
                            <span className="absolute left-0 top-1.5 h-2 w-2 rounded-full bg-primary" />
                            <p className="font-medium">
                              {milestoneLabel(event.kind)}
                            </p>
                            <p className="text-sm text-muted-foreground">
                              {event.message ?? "No detail"}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              {formatTimestampMs(event.createdAt)}
                            </p>
                          </div>
                        ))}
                      </div>
                    )}
                  </PaginatedCollection>
                ) : (
                  <p className="mt-4 text-sm text-muted-foreground">
                    No run events recorded.
                  </p>
                )}
              </div>
            </div>

            <div className="space-y-4">
              <div className="rounded-xl bg-muted/40 p-4">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">Artifacts</p>
                  <Badge variant="outline">{props.run.artifacts.length}</Badge>
                </div>
                {props.run.artifacts.length ? (
                  <PaginatedCollection
                    items={props.run.artifacts}
                    pageSize={COLLECTION_PAGE_SIZE.list}
                    itemLabel="artifacts"
                  >
                    {(visibleArtifacts) => (
                      <div className="mt-4 grid gap-3 sm:grid-cols-2">
                        {visibleArtifacts.map((artifact) => {
                          const className = `min-h-16 rounded-xl border px-4 py-4 text-left text-sm transition-colors ${
                            props.viewer?.artifact.id === artifact.id
                              ? "border-primary/40 bg-primary/10 text-foreground"
                              : "border-border bg-card text-muted-foreground hover:border-primary/30 hover:text-foreground"
                          }`;

                          if (artifact.kind === "ssh_recording_raw_bundle") {
                            return (
                              <a
                                key={artifact.id}
                                className={className}
                                href={`${scenarioRunArtifactContentPath(props.run.id, artifact.id)}?download=1`}
                              >
                                <span className="block font-medium">
                                  {artifact.ordinal}. Raw Recording Bundle
                                </span>
                                <span className="mt-1 block text-xs">
                                  {artifact.filename} •{" "}
                                  {formatBytes(artifact.sizeBytes)} • Download
                                </span>
                              </a>
                            );
                          }

                          return (
                            <button
                              key={artifact.id}
                              type="button"
                              className={className}
                              onClick={() => {
                                props.onStreamArtifact(artifact);
                              }}
                            >
                              <span className="block font-medium">
                                {artifact.ordinal}.{" "}
                                {artifactKindLabel(artifact.kind)}
                              </span>
                              <span className="mt-1 block text-xs">
                                {artifact.filename} •{" "}
                                {formatBytes(artifact.sizeBytes)}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </PaginatedCollection>
                ) : (
                  <p className="mt-4 text-sm text-muted-foreground">
                    No archived files for this run.
                  </p>
                )}
              </div>

              <RunArtifactViewer
                viewer={props.viewer}
                emptyDescription="Select an artifact from this run."
              />
            </div>
          </div>
        </div>
      </div>
    </article>
  );
}
