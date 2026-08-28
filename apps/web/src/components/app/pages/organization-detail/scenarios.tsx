import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
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
} from "../../patterns/CollectionPagination";
import { CourseCurriculumItem } from "../../patterns/ScenarioCard";
import { Section } from "../../patterns/Section";
import { usePageChrome } from "../../shell/page-chrome";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  prepareScenarioBuild,
  validateScenarioHcl,
  type ScenarioValidationResult,
} from "@/lib/authoring-wasm";
import type {
  ScenarioCatalogCourseWireEntry,
  ScenarioCatalogWireResponse,
} from "@/lib/scenario-runs";
import {
  findScenarioCourseLocation,
  matchesCourseRoute,
  type CourseRouteMatch,
} from "@/lib/course-location";
import {
  buildCourseCatalogView,
  courseHeadingId,
  getCourseCurriculumState,
  type CourseCatalogSectionView,
} from "../learn/course-catalog";
import { CourseCredits } from "../learn/CourseCredits";
import { CourseCatalogLink } from "../learn/course-route-links";
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

export function OrganizationScenariosSection({
  detail,
  courseRoute = null,
}: {
  detail: Detail;
  courseRoute?: CourseRouteMatch | null;
}) {
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
      fetchJson<ScenarioCatalogWireResponse>(
        `/api/organizations/${encodeURIComponent(detail.id)}/scenarios`,
      ),
  });
  const sources = useQuery({
    queryKey: ["organizations", detail.id, "scenario-sources"],
    queryFn: () =>
      fetchJson<{ sources: SourceSummary[] }>(
        `/api/organizations/${encodeURIComponent(detail.id)}/scenarios/sources`,
      ),
    enabled: admin && !courseRoute,
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

  const courses = catalog.data?.courses ?? [];
  const entries = courses.flatMap((course) => course.scenarios);
  const catalogView = useMemo(
    () =>
      buildCourseCatalogView(courses, {
        q: "",
        tags: [],
        sort: null,
      }),
    [courses],
  );
  const selectedCourse = useMemo(
    () =>
      courseRoute
        ? (catalogView.courses.find((section) => {
            const scenario = section.accessibleScenarios[0];
            if (!scenario) return false;
            return matchesCourseRoute(
              findScenarioCourseLocation(
                [section.course],
                scenario.scenarioId,
                detail.id,
              ),
              courseRoute,
            );
          }) ?? null)
        : null,
    [catalogView.courses, courseRoute, detail.id],
  );
  const privateEntries = entries.filter(
    (scenario) => scenario.organizationId === detail.id,
  );
  const actionError = save.error ?? build.error ?? deleteSource.error;
  const breadcrumbLabels = useMemo(() => {
    if (!courseRoute) return undefined;
    if (courseRoute.scope === "organization-general-practice") {
      return {
        [`/organizations/${detail.id}/courses`]: `${detail.name} courses`,
      };
    }
    const scopeSegment =
      courseRoute.scope === "organization-public" ? "public" : "private";
    return {
      [`/organizations/${detail.id}/courses/${scopeSegment}`]:
        `${detail.name} courses`,
    };
  }, [courseRoute, detail.id, detail.name]);
  usePageChrome({
    title: selectedCourse?.course.title,
    breadcrumbLabels,
  });

  return (
    <div className="space-y-8">
      {catalog.isLoading && !catalog.data ? (
        <div role="status" className="space-y-4">
          <span className="sr-only">Loading organization courses…</span>
          <Skeleton className="h-9 w-48" />
          <Skeleton className="h-7 w-80 max-w-full" />
          <Skeleton className="h-4 w-full max-w-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      ) : selectedCourse ? (
        <OrganizationCourseDetail
          section={selectedCourse}
          organizationId={detail.id}
          organizationName={detail.name}
        />
      ) : (
        <Section
          title={
            courseRoute
              ? catalog.error
                ? "Could not load organization courses"
                : "Course not available"
              : "Organization courses"
          }
          description={
            courseRoute
              ? catalog.error
                ? "Retry to restore this organization's course catalog."
                : "This course is not available in this organization catalog."
              : "Public and private repair courses available to this organization."
          }
        >
          {courseRoute ? (
            <Button
              variant="link"
              size="sm"
              className="-ml-1 h-9 px-1"
              render={
                <Link
                  to="/organizations/$orgId/courses"
                  params={{ orgId: detail.id }}
                />
              }
            >
              <ArrowLeft className="size-4" />
              All courses
            </Button>
          ) : null}
          {catalog.error ? (
            <div className="space-y-3">
              <InlineFeedback tone="error">
                {catalog.error instanceof Error
                  ? catalog.error.message
                  : "Failed to load courses"}
              </InlineFeedback>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={catalog.isFetching}
                onClick={() => void catalog.refetch()}
              >
                Retry
              </Button>
            </div>
          ) : courseRoute ? null : entries.length ? (
            <OrganizationCourseCatalog
              courses={catalogView.courses}
              organizationId={detail.id}
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              No published courses are available yet.
            </p>
          )}
          {admin && !courseRoute && privateEntries.length ? (
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
      )}

      {admin && !courseRoute ? (
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

      {admin && !courseRoute ? (
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

function OrganizationCourseCatalog({
  courses,
  organizationId,
}: {
  courses: readonly CourseCatalogSectionView[];
  organizationId: string;
}) {
  return (
    <PaginatedCollection
      items={courses}
      pageSize={COLLECTION_PAGE_SIZE.cards}
      itemLabel="courses"
      resetKey="organization-courses"
    >
      {(visibleCourses) => (
        <div className="space-y-6">
          {visibleCourses.map((section) => (
            <OrganizationCourseIndex
              key={organizationCourseKey(section.course)}
              section={section}
              organizationId={organizationId}
            />
          ))}
        </div>
      )}
    </PaginatedCollection>
  );
}

function OrganizationCourseIndex({
  section,
  organizationId,
}: {
  section: CourseCatalogSectionView;
  organizationId: string;
}) {
  const course = section.course;
  const firstScenario = section.accessibleScenarios[0];
  const courseLocation = firstScenario
    ? findScenarioCourseLocation(
        [course],
        firstScenario.scenarioId,
        organizationId,
      )
    : null;
  return (
    <section
      className="space-y-3 border-t pt-6 first:border-t-0 first:pt-0"
      data-course-id={course.courseId ?? "general-practice"}
      data-course-scope={organizationCourseScope(course)}
      data-course-view="index"
    >
      {courseLocation ? (
        <CourseCatalogLink
          location={courseLocation}
          className="group block rounded-lg px-2 py-1 -mx-2 outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/40"
        >
          <CourseHeading course={course} linked />
        </CourseCatalogLink>
      ) : (
        <CourseHeading course={course} linked={false} />
      )}
      <p className="text-metadata">
        {section.accessibleScenarios.length}{" "}
        {section.accessibleScenarios.length === 1 ? "scenario" : "scenarios"}
        {" · ~"}
        {section.totalEstimatedMinutes} min total
      </p>
    </section>
  );
}

function OrganizationCourseDetail({
  section,
  organizationId,
  organizationName,
}: {
  section: CourseCatalogSectionView;
  organizationId: string;
  organizationName: string;
}) {
  const course = section.course;
  const headingId = courseHeadingId(course);
  const scenarioCount = section.accessibleScenarios.length;
  const curriculumState = getCourseCurriculumState(section.accessibleScenarios);
  const nextVisibleIndex = curriculumState.nextScenarioId
    ? section.visibleScenarios.findIndex(
        (scenario) => scenario.scenarioId === curriculumState.nextScenarioId,
      )
    : -1;
  const initialCurriculumPage =
    nextVisibleIndex >= 0
      ? Math.floor(nextVisibleIndex / COLLECTION_PAGE_SIZE.cards) + 1
      : 1;
  const sequenceByScenarioId =
    course.kind === "authored"
      ? new Map(
          section.accessibleScenarios.map((scenario, index) => [
            scenario.scenarioId,
            index + 1,
          ]),
        )
      : undefined;

  return (
    <section
      className="space-y-4 sm:space-y-5"
      aria-labelledby={headingId}
      data-course-id={course.courseId ?? "general-practice"}
      data-course-scope={organizationCourseScope(course)}
      data-course-view="detail"
    >
      <header className="border-b pb-5">
        <Button
          variant="link"
          size="sm"
          className="-ml-1 h-9 px-1 sm:hidden"
          render={
            <Link
              to="/organizations/$orgId/courses"
              params={{ orgId: organizationId }}
            />
          }
        >
          <ArrowLeft className="size-4" />
          {organizationName} courses
        </Button>
        <div className="mt-2 min-w-0 space-y-2">
          <h2
            id={headingId}
            className="font-heading text-2xl font-bold tracking-[-0.03em] text-balance [overflow-wrap:anywhere] sm:text-3xl"
          >
            {course.title}
          </h2>
          <CourseCredits
            credits={course.kind === "authored" ? course.credits : undefined}
          />
          <p className="max-w-3xl text-body text-muted-foreground text-pretty">
            {course.description}
          </p>
          <dl className="flex flex-wrap gap-x-2 gap-y-1 pt-1 text-sm text-muted-foreground tabular-nums">
            <CourseFact label="Course type" value={courseKindLabel(course)} />
            <CourseFact
              label="Scenarios"
              value={`${scenarioCount} ${scenarioCount === 1 ? "scenario" : "scenarios"}`}
            />
            <CourseFact
              label="Estimated time"
              value={`~${section.totalEstimatedMinutes} min total`}
            />
            <CourseFact
              label="Solved progress"
              value={`${section.solvedCount} of ${scenarioCount} solved`}
            />
          </dl>
        </div>
      </header>
      <PaginatedCollection
        items={section.visibleScenarios}
        pageSize={COLLECTION_PAGE_SIZE.cards}
        itemLabel="scenarios"
        initialPage={initialCurriculumPage}
        resetKey={organizationCourseKey(course)}
      >
        {(visibleScenarios) => (
          <ol
            className="divide-y overflow-hidden rounded-xl border bg-card"
            aria-label={course.title + " course steps"}
          >
            {visibleScenarios.map((scenario) => (
              <li key={scenario.scenarioId}>
                <CourseCurriculumItem
                  scenario={scenario}
                  headingLevel={3}
                  sequence={
                    sequenceByScenarioId
                      ? {
                          position:
                            sequenceByScenarioId.get(scenario.scenarioId) ?? 1,
                          total: scenarioCount,
                        }
                      : undefined
                  }
                  isNext={
                    curriculumState.nextScenarioId === scenario.scenarioId
                  }
                  sourceLabel={
                    course.kind === "general-practice"
                      ? scenario.organizationId
                        ? "Private"
                        : "Public"
                      : undefined
                  }
                  courseLocation={findScenarioCourseLocation(
                    [course],
                    scenario.scenarioId,
                    organizationId,
                  )}
                />
              </li>
            ))}
          </ol>
        )}
      </PaginatedCollection>
    </section>
  );
}

function organizationCourseKey(course: ScenarioCatalogCourseWireEntry): string {
  return course.kind === "general-practice"
    ? "general-practice"
    : `${course.organizationId ?? "public"}:${course.courseId}`;
}

function organizationCourseScope(
  course: ScenarioCatalogCourseWireEntry,
): string {
  return course.kind === "general-practice"
    ? "generated"
    : (course.organizationId ?? "public");
}

function courseKindLabel(course: ScenarioCatalogCourseWireEntry): string {
  return course.kind === "general-practice"
    ? "Open practice"
    : course.organizationId
      ? "Private course"
      : "Public course";
}

function CourseHeading({
  course,
  linked,
}: {
  course: ScenarioCatalogCourseWireEntry;
  linked: boolean;
}) {
  return (
    <div>
      <p className="text-eyebrow">{courseKindLabel(course)}</p>
      <h2
        className={
          "mt-1 text-section-title" +
          (linked ? " group-hover:text-primary" : "")
        }
      >
        {course.title}
      </h2>
      <p className="mt-2 text-sm text-muted-foreground">{course.description}</p>
    </div>
  );
}

function CourseFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="inline-flex items-center gap-2 after:text-border after:content-['·'] last:after:hidden">
      <dt className="sr-only">{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
