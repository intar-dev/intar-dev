import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  FileArchive,
  FileCode2,
  Hammer,
  Save,
  Trash2,
} from "lucide-react";
import { ScenarioSourceEditor } from "../../admin/authoring/ScenarioSourceEditor";
import { formatRelativeTime } from "../../lib/format";
import { InlineFeedback } from "../../patterns/InlineFeedback";
import {
  COLLECTION_PAGE_SIZE,
  PaginatedCollection,
  PaginatedWeightedCollection,
} from "../../patterns/CollectionPagination";
import { MetaDifficulty } from "../../patterns/MetaLine";
import { Section } from "../../patterns/Section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  prepareScenarioBuild,
  validateScenarioHcl,
  type ScenarioValidationResult,
} from "@/lib/authoring-wasm";
import type {
  ScenarioCatalogWireEntry,
  ScenarioCourseWireEntry,
} from "@/lib/scenario-runs";
import { CourseCatalogSections } from "../learn/CourseCatalogSections";
import { buildCourseCatalogView } from "../learn/course-catalog";
import {
  type OrganizationDetailResponse,
  fetchJson,
  mutationResponse,
} from "./types";

type Detail = OrganizationDetailResponse["organization"];

interface SourceSummary {
  id: string;
  scenarioId: string;
  organizationId: string;
  status: "draft" | "published";
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

interface SavedSource extends SourceSummary {
  hcl: string;
}

export function OrganizationScenariosSection({ detail }: { detail: Detail }) {
  const queryClient = useQueryClient();
  const admin = detail.role !== "member";
  const [hcl, setHcl] = useState("");
  const [validation, setValidation] = useState<ScenarioValidationResult | null>(
    null,
  );
  const [validatedHcl, setValidatedHcl] = useState<string | null>(null);
  const [validating, setValidating] = useState(false);
  const [bundle, setBundle] = useState<File | null>(null);
  const [bundleMeta, setBundleMeta] = useState("");

  const catalog = useQuery({
    queryKey: ["organizations", detail.id, "scenarios"],
    queryFn: () =>
      fetchJson<{
        scenarios: ScenarioCatalogWireEntry[];
        courses: ScenarioCourseWireEntry[];
      }>(`/api/organizations/${encodeURIComponent(detail.id)}/scenarios`),
  });
  const sources = useQuery({
    queryKey: ["organizations", detail.id, "scenario-sources"],
    queryFn: () =>
      fetchJson<{ sources: SourceSummary[] }>(
        `/api/organizations/${encodeURIComponent(detail.id)}/scenarios/sources`,
      ),
    enabled: admin,
  });

  const runValidation = async () => {
    setValidating(true);
    try {
      setValidation(await validateScenarioHcl(hcl));
      setValidatedHcl(hcl);
    } finally {
      setValidating(false);
    }
  };
  const currentValidation = validatedHcl === hcl ? validation : null;
  const localScenarioId = currentValidation?.preview?.name ?? null;

  const saveSourceRequest = async (): Promise<SavedSource> => {
    if (!currentValidation?.ok || !localScenarioId) {
      throw new Error("Validate the local scenario source first");
    }
    const response = await fetch(
      `/api/organizations/${encodeURIComponent(detail.id)}/scenarios/sources`,
      {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ scenarioId: localScenarioId, hcl }),
      },
    );
    const body = (await response.json().catch(() => null)) as {
      source?: SavedSource;
      error?: string;
    } | null;
    if (!response.ok || !body?.source) {
      throw new Error(
        body?.error ?? `Failed to save source (${response.status})`,
      );
    }
    return body.source;
  };

  const save = useMutation({
    mutationFn: saveSourceRequest,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["organizations", detail.id, "scenario-sources"],
      });
    },
  });
  const build = useMutation({
    mutationFn: async () => {
      const source = await saveSourceRequest();
      const prepared = await prepareScenarioBuild(source.hcl);
      if (!prepared.ok || !prepared.content_hash || !prepared.kino_version) {
        throw new Error(
          prepared.errors.join("; ") || "Scenario failed build preparation",
        );
      }
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(detail.id)}/scenarios/build`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            scenarioId: source.scenarioId,
            contentHash: prepared.content_hash,
            kinoVersion: prepared.kino_version,
            imageArch: prepared.image_arch,
          }),
        },
      );
      const body = (await response.json().catch(() => null)) as {
        rev?: string;
        queued?: number;
        error?: string;
      } | null;
      if (!response.ok || !body?.rev) {
        throw new Error(
          body?.error ?? `Failed to queue build (${response.status})`,
        );
      }
      return body;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["organizations", detail.id, "scenario-sources"],
      });
    },
  });
  const deleteSource = useMutation({
    mutationFn: async (source: SourceSummary) => {
      const response = await fetch(
        source.status === "published"
          ? `/api/organizations/${encodeURIComponent(detail.id)}/scenarios/${encodeURIComponent(source.scenarioId)}`
          : `/api/organizations/${encodeURIComponent(detail.id)}/scenarios/sources/${encodeURIComponent(source.scenarioId)}`,
        { method: "DELETE", credentials: "include" },
      );
      await mutationResponse(response, "Failed to delete source");
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["organizations", detail.id, "scenario-sources"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["organizations", detail.id, "scenarios"],
        }),
      ]);
    },
  });
  const uploadBundle = useMutation({
    mutationFn: async () => {
      if (!bundle || !bundleMeta.trim()) {
        throw new Error("Choose a bundle archive and paste its metadata JSON");
      }
      const form = new FormData();
      form.set("meta", bundleMeta);
      form.set("bundle", bundle);
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(detail.id)}/scenarios/bundles`,
        { method: "POST", credentials: "include", body: form },
      );
      const body = (await response.json().catch(() => null)) as {
        rev?: string;
        queued?: number;
        error?: string;
      } | null;
      if (!response.ok || !body?.rev) {
        throw new Error(
          body?.error ?? `Bundle upload failed (${response.status})`,
        );
      }
      return body;
    },
  });
  const deleteScenario = useMutation({
    mutationFn: async (scenarioId: string) => {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(detail.id)}/scenarios/${encodeURIComponent(scenarioId)}`,
        { method: "DELETE", credentials: "include" },
      );
      await mutationResponse(response, "Failed to delete scenario");
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["organizations", detail.id, "scenarios"],
        }),
        queryClient.invalidateQueries({
          queryKey: ["organizations", detail.id, "scenario-sources"],
        }),
      ]);
    },
  });

  const entries = catalog.data?.scenarios ?? [];
  const courses = catalog.data?.courses ?? [];
  const catalogView = useMemo(
    () =>
      buildCourseCatalogView(entries, courses, {
        q: "",
        tags: [],
        sort: null,
      }),
    [courses, entries],
  );
  const paginationUnits = useMemo(
    () =>
      catalogView.units.map((unit) => ({
        item: unit,
        weight: unit.weight,
      })),
    [catalogView.units],
  );
  const privateEntries = entries.filter(
    (scenario) => scenario.organizationId === detail.id,
  );
  const actionError = save.error ?? build.error ?? deleteSource.error;

  return (
    <div className="space-y-8">
      <Section
        title="Organization catalog"
        description="Public scenarios and this organization's private scenarios are visible to every member. Private runs use organization runners only."
      >
        {catalog.error ? (
          <InlineFeedback tone="error">
            {catalog.error instanceof Error
              ? catalog.error.message
              : "Failed to load scenarios"}
          </InlineFeedback>
        ) : entries.length ? (
          <PaginatedWeightedCollection
            units={paginationUnits}
            pageSize={COLLECTION_PAGE_SIZE.cards}
            itemLabel="scenarios"
          >
            {(visibleUnits) => (
              <CourseCatalogSections
                units={visibleUnits}
                gridClassName="sm:grid-cols-2"
                renderScenario={(scenario) => (
                  <OrganizationScenarioCard
                    scenario={scenario}
                    organizationId={detail.id}
                  />
                )}
              />
            )}
          </PaginatedWeightedCollection>
        ) : (
          <p className="text-sm text-muted-foreground">
            No published scenarios are available yet.
          </p>
        )}
        {admin && privateEntries.length ? (
          <div className="mt-5 space-y-2 border-t pt-4">
            <p className="text-eyebrow">Private catalog cleanup</p>
            <PaginatedCollection
              items={privateEntries}
              pageSize={COLLECTION_PAGE_SIZE.list}
              itemLabel="private scenarios"
            >
              {(visiblePrivateScenarios) => (
                <div className="flex flex-wrap gap-2">
                  {visiblePrivateScenarios.map((scenario) => (
                    <Button
                      key={scenario.scenarioId}
                      variant="outline"
                      size="sm"
                      disabled={deleteScenario.isPending}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Delete ${scenario.title} and its finished build records?`,
                          )
                        ) {
                          deleteScenario.mutate(scenario.scenarioId);
                        }
                      }}
                    >
                      <Trash2 className="size-3.5" />
                      Delete {scenario.title}
                    </Button>
                  ))}
                </div>
              )}
            </PaginatedCollection>
            {deleteScenario.error ? (
              <InlineFeedback tone="error">
                {deleteScenario.error instanceof Error
                  ? deleteScenario.error.message
                  : "Failed to delete scenario"}
              </InlineFeedback>
            ) : null}
          </div>
        ) : null}
      </Section>

      {admin ? (
        <Card>
          <CardHeader className="border-b">
            <p className="text-eyebrow">Private authoring</p>
            <CardTitle as="h2" className="text-section-title">
              Upload scenario HCL
            </CardTitle>
            <p className="text-sm text-muted-foreground">
              Use a local scenario label. Intar namespaces it as{" "}
              <code>{detail.slug}-&lt;local-id&gt;</code> before the platform
              builder receives it.
            </p>
          </CardHeader>
          <CardContent className="space-y-4 pt-6">
            <ScenarioSourceEditor value={hcl} onChange={setHcl} />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => void runValidation()}
                disabled={!hcl.trim() || validating}
              >
                <FileCode2 className="size-4" />
                {validating ? "Validating…" : "Validate"}
              </Button>
              <Button
                variant="outline"
                onClick={() => save.mutate()}
                disabled={
                  !currentValidation?.ok || save.isPending || build.isPending
                }
              >
                <Save className="size-4" />
                {save.isPending ? "Saving…" : "Save draft"}
              </Button>
              <Button
                variant="outline"
                onClick={() => build.mutate()}
                disabled={
                  !currentValidation?.ok || build.isPending || save.isPending
                }
              >
                <Hammer className="size-4" />
                {build.isPending ? "Queueing…" : "Save and build"}
              </Button>
            </div>
            {currentValidation ? (
              <InlineFeedback tone={currentValidation.ok ? "success" : "error"}>
                {currentValidation.ok
                  ? `Valid local scenario: ${currentValidation.preview?.name ?? "unknown"}`
                  : currentValidation.errors.join("; ")}
              </InlineFeedback>
            ) : validatedHcl && validatedHcl !== hcl ? (
              <InlineFeedback tone="pending">
                Source changed. Validate it again.
              </InlineFeedback>
            ) : null}
            {save.isSuccess ? (
              <InlineFeedback tone="success">
                Draft saved in the organization namespace.
              </InlineFeedback>
            ) : null}
            {build.data ? (
              <InlineFeedback tone="success">
                Build {build.data.rev} queued ({build.data.queued ?? 0} image
                job(s)).
              </InlineFeedback>
            ) : null}
            {actionError ? (
              <InlineFeedback tone="error">
                {actionError instanceof Error
                  ? actionError.message
                  : "Scenario action failed"}
              </InlineFeedback>
            ) : null}

            {(sources.data?.sources ?? []).length ? (
              <PaginatedCollection
                items={sources.data?.sources ?? []}
                pageSize={COLLECTION_PAGE_SIZE.list}
                itemLabel="scenario sources"
              >
                {(visibleSources) => (
                  <div className="divide-y overflow-hidden rounded-xl border">
                    {visibleSources.map((source) => (
                      <div
                        key={source.id}
                        className="flex flex-wrap items-center gap-4 p-4 sm:p-6"
                      >
                        <FileCode2 className="size-4 text-brand-text" />
                        <div className="min-w-0 flex-1">
                          <p className="font-mono text-sm break-all">
                            {source.scenarioId}
                          </p>
                          <p className="text-caption">
                            Updated {formatRelativeTime(source.updatedAt)}
                          </p>
                        </div>
                        <Badge variant="outline">{source.status}</Badge>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={deleteSource.isPending}
                          onClick={() => deleteSource.mutate(source)}
                        >
                          <Trash2 className="size-3.5" />
                          {source.status === "published"
                            ? "Delete scenario"
                            : "Delete draft"}
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </PaginatedCollection>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {admin ? (
        <Section
          title="Upload a full source bundle"
          description="For multi-scenario bundles produced by the image CLI. Every metadata scenario id and archive path must already use the organization namespace."
        >
          <div className="grid gap-4 lg:grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)]">
            <label className="flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed bg-muted/30 p-6 text-center">
              <FileArchive className="size-6 text-brand-text" />
              <span className="text-sm font-medium">
                {bundle?.name ?? "Choose .tar.gz bundle"}
              </span>
              <Input
                type="file"
                accept=".tar.gz,.tgz,application/gzip"
                className="sr-only"
                onChange={(event) => setBundle(event.target.files?.[0] ?? null)}
              />
            </label>
            <Textarea
              value={bundleMeta}
              onChange={(event) => setBundleMeta(event.target.value)}
              placeholder="Paste bundle metadata JSON, including build_format_version, kino_version, and scenarios."
              className="min-h-32 font-mono text-xs"
              aria-label="Bundle metadata JSON"
            />
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <Button
              disabled={!bundle || !bundleMeta.trim() || uploadBundle.isPending}
              onClick={() => uploadBundle.mutate()}
            >
              <FileArchive className="size-4" />
              {uploadBundle.isPending ? "Uploading…" : "Upload and queue"}
            </Button>
            {uploadBundle.data ? (
              <InlineFeedback tone="success">
                Bundle {uploadBundle.data.rev} queued (
                {uploadBundle.data.queued ?? 0} image job(s)).
              </InlineFeedback>
            ) : uploadBundle.error ? (
              <InlineFeedback tone="error">
                {uploadBundle.error instanceof Error
                  ? uploadBundle.error.message
                  : "Bundle upload failed"}
              </InlineFeedback>
            ) : null}
          </div>
        </Section>
      ) : null}
    </div>
  );
}

function OrganizationScenarioCard({
  scenario,
  organizationId,
}: {
  scenario: ScenarioCatalogWireEntry;
  organizationId: string;
}) {
  return (
    <Link
      to="/scenarios/$scenarioId"
      params={{ scenarioId: scenario.scenarioId }}
      search={{ organizationId }}
      className="group rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/40"
    >
      <Card variant="interactive" className="h-full gap-4 px-(--card-spacing)">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h4 className="text-card-title group-hover:text-primary">
              {scenario.title}
            </h4>
            <p className="mt-1 text-metadata">
              {scenario.category || "Systems"} · ~{scenario.estimatedMinutes}{" "}
              min
            </p>
          </div>
          <Badge variant={scenario.organizationId ? "secondary" : "outline"}>
            {scenario.organizationId ? "Private" : "Public"}
          </Badge>
        </div>
        <div className="flex items-center justify-between gap-3">
          <MetaDifficulty difficulty={scenario.difficulty} />
          <ArrowRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
        </div>
      </Card>
    </Link>
  );
}
