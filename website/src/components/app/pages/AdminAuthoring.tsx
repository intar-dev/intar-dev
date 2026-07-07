import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  FileCode2,
  Hammer,
  Save,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import { PageShell } from "@/components/app/patterns/PageShell";
import { EmptyState, ErrorState } from "../patterns/StateCard";
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
import { Textarea } from "@/components/ui/textarea";

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
  const [validating, setValidating] = useState(false);
  const [validationFailure, setValidationFailure] = useState<string | null>(
    null,
  );

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
        throw new Error(body?.error ?? `Failed to load drafts (${response.status})`);
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
    } catch (error) {
      setResult(null);
      setValidationFailure(
        error instanceof Error ? error.message : "Validator failed to load",
      );
    } finally {
      setValidating(false);
    }
  };

  const scenarioId = result?.preview?.name ?? null;

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
        throw new Error(body?.error ?? `Failed to save draft (${response.status})`);
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
      if (!prepared.ok || !prepared.content_hash || !prepared.kino_version) {
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
          kinoVersion: prepared.kino_version,
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
        throw new Error(result?.error ?? `Failed to queue build (${response.status})`);
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
      await queryClient.invalidateQueries({
        queryKey: ["admin", "authoring", "sources"],
      });
    },
  });

  return (
    <PageShell
      admin
      width="wide"
      compactHeader
      title="Authoring"
      description="Write scenario HCL, validate it with the exact build-pipeline rules (in your browser), preview, and save drafts."
    >
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Scenario HCL</CardTitle>
              <CardDescription>
                Paste a scenario.hcl — validation runs the same Rust code the
                image builder uses, compiled to WebAssembly.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                value={hcl}
                onChange={(event) => setHcl(event.target.value)}
                placeholder={'scenario "my-scenario" {\n  …\n}'}
                rows={18}
                className="font-mono text-xs"
              />
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
                  disabled={!result?.ok || !scenarioId || saveDraft.isPending}
                >
                  <Save className="size-4" />
                  {saveDraft.isPending ? "Saving…" : "Save draft"}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => queueBuild.mutate()}
                  disabled={
                    !result?.ok ||
                    !scenarioId ||
                    queueBuild.isPending ||
                    saveDraft.isPending
                  }
                >
                  <Hammer className="size-4" />
                  {queueBuild.isPending ? "Queueing…" : "Build images"}
                </Button>
                {saveDraft.isSuccess && !queueBuild.isSuccess ? (
                  <span className="text-xs text-success">Draft saved.</span>
                ) : null}
                {saveDraft.error ? (
                  <span className="text-xs text-destructive">
                    {saveDraft.error instanceof Error
                      ? saveDraft.error.message
                      : "Failed to save"}
                  </span>
                ) : null}
                {queueBuild.isSuccess ? (
                  <span className="text-xs text-success">
                    {queueBuild.data.queued === 0
                      ? "Images for this exact content already exist — nothing to build."
                      : `Build queued as ${queueBuild.data.rev}${
                          queueBuild.data.assigned?.length
                            ? ` — assigned to ${queueBuild.data.assigned.length} builder(s); watch Builds.`
                            : " — waiting for a builder; watch Builds."
                        }`}
                  </span>
                ) : null}
                {queueBuild.error ? (
                  <span className="text-xs text-destructive">
                    {queueBuild.error instanceof Error
                      ? queueBuild.error.message
                      : "Failed to queue build"}
                  </span>
                ) : null}
              </div>
            </CardContent>
          </Card>

          {validationFailure ? (
            <ErrorState title="Validator error" description={validationFailure} />
          ) : result ? (
            result.ok ? (
              <div className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/[0.06] px-4 py-3 text-sm text-success">
                <CheckCircle2 className="size-4" />
                Scenario is valid.
              </div>
            ) : (
              <div className="space-y-2 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3">
                <p className="flex items-center gap-2 text-sm font-medium text-destructive">
                  <ShieldAlert className="size-4" />
                  {result.errors.length} validation error
                  {result.errors.length === 1 ? "" : "s"}
                </p>
                <ul className="list-disc space-y-1 pl-5 text-xs text-destructive">
                  {result.errors.map((error) => (
                    <li key={error}>{error}</li>
                  ))}
                </ul>
              </div>
            )
          ) : null}

          {result?.preview ? <ScenarioPreviewCard preview={result.preview} /> : null}
        </div>

        <div className="space-y-4">
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base">Drafts</CardTitle>
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
                <div className="space-y-2">
                  {sources.data.sources.map((source) => (
                    <div
                      key={source.id}
                      className="flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2"
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
                          source.status === "published" ? "success" : "outline"
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
                        onClick={() => deleteDraft.mutate(source.scenarioId)}
                        aria-label="Delete draft"
                      >
                        <Trash2 className="size-3.5" />
                      </Button>
                    </div>
                  ))}
                </div>
              ) : (
                <EmptyState
                  icon={<FileCode2 className="size-6" />}
                  title="No drafts yet"
                  description="Validate a scenario and save it to start iterating here."
                />
              )}
            </CardContent>
          </Card>

          <Card>
            <CardContent className="py-4 text-xs leading-5 text-muted-foreground">
              Build images bundles the validated draft (with the pinned base
              images and kino version) and queues it exactly like a CI upload.
              The builder re-verifies the content hash before building;
              progress shows on the Builds page, and a published scenario
              lands in the registry.
            </CardContent>
          </Card>
        </div>
      </div>
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
        <CardTitle className="text-base">Preview</CardTitle>
        <CardDescription>How the scenario will read to learners.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{preview.name}</Badge>
          {preview.difficulty ? (
            <Badge variant="secondary" className="capitalize">
              {preview.difficulty}
            </Badge>
          ) : null}
          {preview.estimated_minutes ? (
            <Badge variant="outline">~{preview.estimated_minutes} min</Badge>
          ) : null}
          {preview.category ? (
            <Badge variant="outline">{preview.category}</Badge>
          ) : null}
          {preview.tags.map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
        </div>
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
                    · {vm.image} · {vm.cpu} vCPU · {vm.memory} MiB
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
                    <span className="text-muted-foreground"> · {probe.phase}</span>
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
