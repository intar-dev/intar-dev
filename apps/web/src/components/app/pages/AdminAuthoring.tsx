import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FileCode2, Hammer, Save, Trash2 } from "lucide-react";
import { PageShell } from "@/components/app/patterns/PageShell";
import {
  COLLECTION_PAGE_SIZE,
  PaginatedCollection,
} from "@/components/app/patterns/CollectionPagination";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { ScenarioSourceEditor } from "@/components/app/admin/authoring/ScenarioSourceEditor";
import { EmptyState } from "../patterns/StateCard";
import { formatRelativeTime } from "../lib/format";
import {
  prepareScenarioBuild,
  validateScenarioHcl,
  type ScenarioValidationResult,
} from "@/lib/authoring-wasm";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

interface SourceSummary {
  id: string;
  scenarioId: string;
  status: "draft" | "published";
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export function AdminAuthoring() {
  const queryClient = useQueryClient();
  const [hcl, setHcl] = useState("");
  const [result, setResult] = useState<ScenarioValidationResult | null>(null);
  const [validatedHcl, setValidatedHcl] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [validationFailure, setValidationFailure] = useState<string | null>(
    null,
  );
  const [deleteTarget, setDeleteTarget] = useState<SourceSummary | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");

  const sources = useQuery({
    queryKey: ["admin", "authoring", "sources"],
    queryFn: async () => {
      const response = await fetch("/api/admin/authoring/sources", {
        method: "GET",
        credentials: "include",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to load drafts (${response.status})`,
        );
      }
      return (await response.json()) as { sources: SourceSummary[] };
    },
    staleTime: 5_000,
  });

  const runValidation = async (nextHcl: string) => {
    setValidating(true);
    setValidationFailure(null);
    try {
      setResult(await validateScenarioHcl(nextHcl));
      setValidatedHcl(nextHcl);
    } catch (error) {
      setResult(null);
      setValidatedHcl(null);
      setValidationFailure(
        error instanceof Error ? error.message : "Validator failed to load",
      );
    } finally {
      setValidating(false);
    }
  };

  const currentResult = validatedHcl === hcl ? result : null;
  const scenarioId = currentResult?.preview?.name ?? null;

  const saveDraft = useMutation({
    mutationFn: async () => {
      if (!scenarioId) throw new Error("validate first");
      const response = await fetch("/api/admin/authoring/sources", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenarioId, hcl }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to save draft (${response.status})`,
        );
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["admin", "authoring", "sources"],
      });
    },
  });

  const queueBuild = useMutation({
    mutationFn: async () => {
      if (!scenarioId) throw new Error("validate first");
      const prepared = await prepareScenarioBuild(hcl);
      if (!prepared.ok || !prepared.content_hash) {
        throw new Error(
          prepared.errors.join("; ") || "scenario failed build preparation",
        );
      }
      // Save the draft first so the queued bundle matches what's stored.
      await saveDraft.mutateAsync();
      const response = await fetch("/api/admin/authoring/build", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          scenarioId,
          contentHash: prepared.content_hash,
          imageArch: prepared.image_arch,
        }),
      });
      const result = (await response.json().catch(() => null)) as {
        rev?: string;
        queued?: number;
        assigned?: Array<{ buildId: string; hostId: string }>;
        error?: string;
      } | null;
      if (!response.ok || !result?.rev) {
        throw new Error(
          result?.error ?? `Failed to queue build (${response.status})`,
        );
      }
      return result;
    },
  });

  const loadDraft = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(
        `/api/admin/authoring/sources/${encodeURIComponent(id)}`,
        { method: "GET", credentials: "include" },
      );
      if (!response.ok) {
        throw new Error(`Failed to load draft (${response.status})`);
      }
      return (await response.json()) as { source: { hcl: string } };
    },
    onSuccess: async (data) => {
      setHcl(data.source.hcl);
      await runValidation(data.source.hcl);
    },
  });

  const deleteDraft = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(
        `/api/admin/authoring/sources/${encodeURIComponent(id)}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!response.ok && response.status !== 204) {
        throw new Error(`Failed to delete draft (${response.status})`);
      }
    },
    onSuccess: async () => {
      setDeleteTarget(null);
      setDeleteConfirm("");
      await queryClient.invalidateQueries({
        queryKey: ["admin", "authoring", "sources"],
      });
    },
  });

  return (
    <PageShell width="workspace" density="compact">
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle as="h2" className="text-base">
                Scenario HCL
              </CardTitle>
              <CardDescription>
                Paste a scenario.hcl — validation runs the same Rust code the
                image builder uses, compiled to WebAssembly.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(17rem,0.38fr)]">
                <ScenarioSourceEditor value={hcl} onChange={setHcl} />
                <aside
                  className="space-y-3 rounded-lg border bg-muted/30 p-4"
                  aria-label="Validation results"
                >
                  <div>
                    <p className="text-label">WASM validation</p>
                    <h3 className="mt-1 text-card-title">Pipeline result</h3>
                  </div>
                  {validating ? (
                    <InlineFeedback tone="pending">
                      Validating scenario source…
                    </InlineFeedback>
                  ) : validationFailure ? (
                    <InlineFeedback tone="error">
                      {validationFailure}
                    </InlineFeedback>
                  ) : currentResult?.ok ? (
                    <InlineFeedback tone="success">
                      Scenario is valid.
                    </InlineFeedback>
                  ) : currentResult ? (
                    <div className="space-y-2">
                      <InlineFeedback tone="error">
                        {currentResult.errors.length} validation error
                        {currentResult.errors.length === 1 ? "" : "s"}
                      </InlineFeedback>
                      <ul className="max-h-72 list-disc space-y-1 overflow-auto pl-5 text-xs text-destructive">
                        {currentResult.errors.map((error) => (
                          <li key={error}>{error}</li>
                        ))}
                      </ul>
                    </div>
                  ) : validatedHcl && validatedHcl !== hcl ? (
                    <p className="text-metadata">
                      Source changed. Validate again before saving or building.
                    </p>
                  ) : (
                    <p className="text-metadata">
                      Run validation to inspect this source with the same Rust
                      rules used by builders.
                    </p>
                  )}
                </aside>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  onClick={() => void runValidation(hcl)}
                  disabled={!hcl.trim() || validating}
                >
                  <FileCode2 className="size-4" />
                  {validating ? "Validating…" : "Validate"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => saveDraft.mutate()}
                  disabled={
                    !currentResult?.ok || !scenarioId || saveDraft.isPending
                  }
                >
                  <Save className="size-4" />
                  {saveDraft.isPending ? "Saving…" : "Save draft"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => queueBuild.mutate()}
                  disabled={
                    !currentResult?.ok ||
                    !scenarioId ||
                    queueBuild.isPending ||
                    saveDraft.isPending
                  }
                >
                  <Hammer className="size-4" />
                  {queueBuild.isPending ? "Queueing…" : "Build images"}
                </Button>
                {saveDraft.isSuccess && !queueBuild.isSuccess ? (
                  <InlineFeedback tone="success">Draft saved.</InlineFeedback>
                ) : null}
                {saveDraft.error ? (
                  <InlineFeedback tone="error">
                    {saveDraft.error instanceof Error
                      ? saveDraft.error.message
                      : "Failed to save"}
                  </InlineFeedback>
                ) : null}
                {queueBuild.isSuccess ? (
                  <InlineFeedback tone="success">
                    {queueBuild.data.queued === 0
                      ? "Images for this exact content already exist — nothing to build."
                      : `Build queued as ${queueBuild.data.rev}${
                          queueBuild.data.assigned?.length
                            ? ` — assigned to ${queueBuild.data.assigned.length} builder(s); watch Builds.`
                            : " — waiting for a builder; watch Builds."
                        }`}
                  </InlineFeedback>
                ) : null}
                {queueBuild.error ? (
                  <InlineFeedback tone="error">
                    {queueBuild.error instanceof Error
                      ? queueBuild.error.message
                      : "Failed to queue build"}
                  </InlineFeedback>
                ) : null}
              </div>
            </CardContent>
          </Card>

          {currentResult?.preview ? (
            <ScenarioPreviewCard preview={currentResult.preview} />
          ) : null}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle as="h2" className="text-base">
                Drafts
              </CardTitle>
              <CardDescription>Saved scenario sources.</CardDescription>
            </CardHeader>
            <CardContent>
              {sources.error ? (
                <p className="text-sm text-destructive">
                  {sources.error instanceof Error
                    ? sources.error.message
                    : "Failed to load drafts"}
                </p>
              ) : sources.data?.sources.length ? (
                <PaginatedCollection
                  items={sources.data.sources}
                  pageSize={COLLECTION_PAGE_SIZE.list}
                  itemLabel="drafts"
                >
                  {(visibleSources) => (
                    <div className="divide-y overflow-hidden rounded-lg border">
                      {visibleSources.map((source) => (
                        <div
                          key={source.id}
                          className="flex flex-wrap items-center gap-3 p-4"
                        >
                          <div className="min-w-0 flex-1">
                            <p className="font-mono text-xs font-medium">
                              {source.scenarioId}
                            </p>
                            <p className="text-xs text-muted-foreground">
                              Updated {formatRelativeTime(source.updatedAt)}
                            </p>
                          </div>
                          <Badge
                            variant={
                              source.status === "published"
                                ? "success"
                                : "outline"
                            }
                          >
                            {source.status}
                          </Badge>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={loadDraft.isPending}
                            onClick={() => loadDraft.mutate(source.scenarioId)}
                          >
                            Open
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="ghost"
                            className="text-muted-foreground hover:text-destructive"
                            disabled={deleteDraft.isPending}
                            onClick={() => {
                              deleteDraft.reset();
                              setDeleteConfirm("");
                              setDeleteTarget(source);
                            }}
                            aria-label={`Delete ${source.scenarioId} draft`}
                          >
                            <Trash2 className="size-3.5" />
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </PaginatedCollection>
              ) : (
                <EmptyState
                  icon={<FileCode2 className="size-6" />}
                  title="No drafts yet"
                  description="Validate a scenario and save it to start iterating here."
                />
              )}
              {deleteDraft.error ? (
                <InlineFeedback tone="error" className="mt-3">
                  {deleteDraft.error instanceof Error
                    ? deleteDraft.error.message
                    : "Failed to delete draft"}
                </InlineFeedback>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="py-4 text-xs leading-5 text-muted-foreground">
              Build images bundles the validated draft (with the pinned base
              images and kino version) and queues it exactly like a CI upload.
              The builder re-verifies the content hash before building; progress
              shows on the Builds page, and a published scenario lands in the
              registry.
            </CardContent>
          </Card>
        </div>
      </div>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open && !deleteDraft.isPending) {
            setDeleteTarget(null);
            setDeleteConfirm("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this draft?</DialogTitle>
            <DialogDescription>
              This permanently removes the saved source. Published scenario
              records and existing builds are unchanged. Type the scenario ID to
              confirm.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label htmlFor="delete-draft-confirm" className="font-mono text-sm">
              {deleteTarget?.scenarioId}
            </label>
            <Input
              id="delete-draft-confirm"
              value={deleteConfirm}
              onChange={(event) => setDeleteConfirm(event.target.value)}
              autoComplete="off"
            />
          </div>
          {deleteDraft.error ? (
            <InlineFeedback tone="error">
              {deleteDraft.error instanceof Error
                ? deleteDraft.error.message
                : "Failed to delete draft"}
            </InlineFeedback>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteTarget(null)}
              disabled={deleteDraft.isPending}
            >
              Keep draft
            </Button>
            <Button
              variant="destructive"
              disabled={
                !deleteTarget ||
                deleteConfirm !== deleteTarget.scenarioId ||
                deleteDraft.isPending
              }
              onClick={() => {
                if (deleteTarget) deleteDraft.mutate(deleteTarget.scenarioId);
              }}
            >
              {deleteDraft.isPending ? "Deleting…" : "Delete draft"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}

function ScenarioPreviewCard({
  preview,
}: {
  preview: NonNullable<ScenarioValidationResult["preview"]>;
}) {
  const probes = Object.entries(preview.kino?.probes ?? {}).map(
    ([name, probe]) => ({ ...probe, name: probe.name || name }),
  );
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle as="h2" className="text-base">
          Preview
        </CardTitle>
        <CardDescription>
          How the scenario will read to learners.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <dl className="grid gap-x-6 gap-y-3 border-y py-3 sm:grid-cols-2">
          <PreviewMeta label="Scenario ID" value={preview.name} mono />
          <PreviewMeta
            label="Difficulty"
            value={preview.difficulty ?? "Not set"}
            capitalize
          />
          <PreviewMeta
            label="Estimated time"
            value={
              preview.estimated_minutes
                ? `~${preview.estimated_minutes} min`
                : "Not set"
            }
          />
          <PreviewMeta label="Category" value={preview.category || "Not set"} />
          <PreviewMeta
            label="Tags"
            value={preview.tags.length ? preview.tags.join(", ") : "None"}
            className="sm:col-span-2"
          />
        </dl>
        <div>
          <h3 className="text-lg font-semibold tracking-tight">
            {preview.title || preview.name}
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {preview.description}
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg border bg-muted/20 p-3">
            <p className="text-xs font-medium text-muted-foreground">
              Machines ({preview.vms.length})
            </p>
            <ul className="mt-2 space-y-1 text-xs">
              {preview.vms.map((vm) => (
                <li key={vm.name}>
                  <code>{vm.name}</code>
                  <span className="text-muted-foreground">
                    {" "}
                    · {vm.image} · {vm.cpu_millis / 1000} CPU · {vm.vcpu_count}{" "}
                    vCPU · {vm.memory} MiB
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="rounded-lg border bg-muted/20 p-3">
            <p className="text-xs font-medium text-muted-foreground">
              Probes ({probes.length})
            </p>
            <ul className="mt-2 space-y-1 text-xs">
              {probes.slice(0, 8).map((probe) => (
                <li key={probe.name}>
                  <code>{probe.name}</code>
                  {probe.phase ? (
                    <span className="text-muted-foreground">
                      {" "}
                      · {probe.phase}
                    </span>
                  ) : null}
                </li>
              ))}
              {probes.length > 8 ? (
                <li className="text-muted-foreground">
                  +{probes.length - 8} more
                </li>
              ) : null}
            </ul>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function PreviewMeta({
  label,
  value,
  mono = false,
  capitalize = false,
  className,
}: {
  label: string;
  value: string;
  mono?: boolean;
  capitalize?: boolean;
  className?: string;
}) {
  return (
    <div className={className}>
      <dt className="text-label">{label}</dt>
      <dd
        className={cn(
          "mt-1 break-words",
          mono && "font-mono text-xs",
          capitalize && "capitalize",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
