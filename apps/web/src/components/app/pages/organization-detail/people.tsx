import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Check, Plus, Users } from "lucide-react";
import { useState } from "react";
import { useSession } from "../../hooks/useSession";
import { formatDurationMs, formatRelativeTime } from "../../lib/format";
import { BinIcon, InlineConfirm } from "../../patterns/InlineConfirm";
import { ConfirmDialog } from "../../patterns/ConfirmDialog";
import { InlineFeedback } from "../../patterns/InlineFeedback";
import {
  COLLECTION_PAGE_SIZE,
  PaginatedCollection,
} from "../../patterns/CollectionPagination";
import { MetaLine } from "../../patterns/MetaLine";
import { Section } from "../../patterns/Section";
import { ListSkeleton } from "../../patterns/Skeletons";
import { EmptyState, ErrorState } from "../../patterns/StateCard";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/native-select";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from "@/components/ui/table";
import { LectureLink } from "../learn/course-links";
import {
  courseRouteForCatalogCourse,
  type CourseCatalogCourse,
  type CourseCatalogResponse,
  type CourseLectureSummary,
} from "../learn/course-wire";
import type { OrganizationDetailTab } from "../tab-search";
import { invalidateOrganizationDetail } from "./queries";
import { RemovedMemberList } from "./RemovedMemberList";
import {
  type AssignmentsResponse,
  type OrganizationDetailResponse,
  type ProgressResponse,
  fetchJson,
  initials,
  mutationResponse,
} from "./types";

type Detail = OrganizationDetailResponse["organization"];

export function OrganizationOverview({
  detail,
  setTab,
  onOpenCourses,
}: {
  detail: Detail;
  setTab: (tab: OrganizationDetailTab) => void;
  onOpenCourses: () => void;
}) {
  const admin = detail.role !== "member";
  return (
    <Section
      variant="flat"
      density="compact"
      title="Organization"
      description="Manage members, courses, and private content."
    >
      <dl className="grid gap-3 sm:grid-cols-3">
        <OverviewMetric
          label="Members"
          value={detail.members.length}
          action="Review access"
          onClick={() => setTab("people")}
        />
        <OverviewMetric
          label="Courses"
          value="Catalog"
          action="Open courses"
          onClick={onOpenCourses}
        />
        <OverviewMetric
          label="Your role"
          value={
            detail.role === "owner"
              ? "Owner"
              : detail.role === "admin"
                ? "Admin"
                : "Member"
          }
          action={admin ? "Identity settings" : "Open settings"}
          onClick={() => setTab("settings")}
        />
      </dl>
    </Section>
  );
}

function OverviewMetric({
  label,
  value,
  action,
  onClick,
}: {
  label: string;
  value: string | number;
  action: string;
  onClick: () => void;
}) {
  return (
    <div className="rounded-lg bg-muted/40 p-3">
      <dt className="text-label">{label}</dt>
      <dd>
        <span className="mt-1 block text-section-title tabular-nums">
          {value}
        </span>
        <Button variant="link" className="mt-1 h-auto p-0" onClick={onClick}>
          {action}
        </Button>
      </dd>
    </div>
  );
}

const wait = (ms: number) =>
  new Promise<void>((resolve) => window.setTimeout(resolve, ms));

export function MembersSection({ detail }: { detail: Detail }) {
  const queryClient = useQueryClient();
  const { data: session } = useSession();
  const viewerUserId = session?.user.id ?? null;
  const admin = detail.role !== "member";
  const invalidate = () => invalidateOrganizationDetail(queryClient, detail);
  const changeRole = useMutation({
    mutationFn: async (input: {
      memberId: string;
      role: "admin" | "member";
    }) => {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(detail.id)}/members/${encodeURIComponent(input.memberId)}`,
        {
          method: "PATCH",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role: input.role }),
        },
      );
      await mutationResponse(response, "Failed to change member role");
    },
    // Only the latest action's failure shows; one still running keeps its own.
    onMutate: () => {
      if (!restore.isPending) restore.reset();
    },
    onSuccess: invalidate,
  });
  // The target outlives the dialog's close animation, so its text holds.
  const [removeTarget, setRemoveTarget] = useState<{
    memberId: string;
    name: string;
  } | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const remove = useMutation({
    mutationFn: async (memberId: string) => {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(detail.id)}/members/${encodeURIComponent(memberId)}`,
        { method: "DELETE", credentials: "include" },
      );
      await mutationResponse(response, "Failed to remove member");
    },
    onSuccess: () => setRemoveOpen(false),
    // A failure can follow a committed removal (run shutdown still pending),
    // so the list refreshes either way.
    onSettled: invalidate,
  });
  const closeRemoveDialog = () => {
    setRemoveOpen(false);
    remove.reset();
  };
  const restore = useMutation({
    mutationFn: async (userId: string) => {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(detail.id)}/removed-members/${encodeURIComponent(userId)}`,
        { method: "DELETE", credentials: "include" },
      );
      await mutationResponse(response, "Failed to restore access");
    },
    // Only the latest action's failure shows; one still running keeps its own.
    onMutate: () => {
      if (!changeRole.isPending) changeRole.reset();
    },
    // A refused restore (someone else restored them first) refreshes the list
    // too.
    onSettled: invalidate,
  });
  // Removal errors show in the confirmation dialog, which covers the page.
  const actionError = changeRole.error ?? restore.error;

  return (
    <Section
      density="compact"
      title="Members"
      description="Signing in through the organization's verified OIDC provider makes people members. First-timers get an Intar account."
    >
      <PaginatedCollection
        items={detail.members}
        pageSize={COLLECTION_PAGE_SIZE.list}
        itemLabel="members"
      >
        {(visibleMembers) => (
          <ul className="divide-y">
            {visibleMembers.map((entry) => {
              // The select keeps the role just picked while it saves.
              const saving =
                changeRole.isPending &&
                changeRole.variables?.memberId === entry.memberId;
              return (
              <li
                key={entry.memberId}
                className="flex flex-wrap items-center gap-3 py-3"
              >
                <Avatar>
                  <AvatarFallback>{initials(entry.name)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{entry.name}</p>
                  <MetaLine
                    dense
                    items={[
                      entry.email,
                      entry.githubUsername ? `@${entry.githubUsername}` : null,
                      `Joined ${formatRelativeTime(entry.joinedAt)}`,
                    ]}
                  />
                </div>
                {/* Fixed role and action columns keep the badge, selects and
                    Remove buttons on shared edges across rows. */}
                <div className="ml-auto flex shrink-0 items-center justify-end gap-2">
                  <div
                    className={cn(
                      "flex items-center",
                      admin ? "w-28 justify-start" : "justify-end",
                    )}
                  >
                    {admin && entry.role !== "owner" ? (
                      <NativeSelect
                        className="w-full"
                        value={
                          saving && changeRole.variables
                            ? changeRole.variables.role
                            : entry.role
                        }
                        onChange={(event) => {
                          if (saving) return;
                          changeRole.mutate({
                            memberId: entry.memberId,
                            role: event.target.value as "admin" | "member",
                          });
                        }}
                        aria-disabled={saving || undefined}
                        aria-label={`Role for ${entry.name}`}
                      >
                        <option value="admin">Admin</option>
                        <option value="member">Member</option>
                      </NativeSelect>
                    ) : (
                      <Badge
                        variant={
                          entry.role === "member" ? "outline" : "secondary"
                        }
                      >
                        {entry.role === "owner"
                          ? "Owner"
                          : entry.role === "admin"
                            ? "Admin"
                            : "Member"}
                      </Badge>
                    )}
                  </div>
                  {admin ? (
                    <div className="flex w-24 items-center justify-end">
                      {/* A removal sticks, so admins leave from Settings
                          instead of removing themselves. */}
                      {entry.role !== "owner" &&
                      entry.userId !== viewerUserId ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="text-muted-foreground hover:text-destructive"
                          disabled={remove.isPending}
                          onClick={() => {
                            remove.reset();
                            setRemoveTarget({
                              memberId: entry.memberId,
                              name: entry.name,
                            });
                            setRemoveOpen(true);
                          }}
                        >
                          <BinIcon />
                          Remove
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              </li>
              );
            })}
          </ul>
        )}
      </PaginatedCollection>
      {admin && detail.removedMembers.length > 0 ? (
        <div className="mt-6 space-y-3">
          <div>
            <h3 className="text-sm font-medium">Removed</h3>
            <p className="text-caption">
              They can't sign in through this organization's identity provider
              until you restore them. Restored people rejoin on their next
              organization sign-in.
            </p>
          </div>
          <RemovedMemberList
            entries={detail.removedMembers}
            restoring={restore.isPending}
            onRestore={(userId) => restore.mutate(userId)}
          />
        </div>
      ) : null}
      {actionError ? (
        <InlineFeedback tone="error" className="mt-4">
          {actionError instanceof Error ? actionError.message : "Action failed"}
        </InlineFeedback>
      ) : null}
      <ConfirmDialog
        open={removeOpen}
        onClose={closeRemoveDialog}
        title={`Remove ${removeTarget?.name}?`}
        description="They lose access to this organization and can't sign in through its identity provider until an admin restores them. If they connected it, they're signed out everywhere now."
        error={remove.error ? remove.error.message : null}
        pending={remove.isPending}
        confirmLabel="Remove member"
        pendingLabel="Removing…"
        confirmDisabled={!removeTarget}
        onConfirm={() => {
          if (removeTarget) remove.mutate(removeTarget.memberId);
        }}
      />
    </Section>
  );
}

export function AssignmentsSection({ detail }: { detail: Detail }) {
  const queryClient = useQueryClient();
  const admin = detail.role !== "member";
  const [scenarioId, setScenarioId] = useState("");
  const assignments = useQuery({
    queryKey: ["organizations", detail.id, "assignments"],
    queryFn: () =>
      fetchJson<AssignmentsResponse>(
        `/api/organizations/${encodeURIComponent(detail.id)}/assignments`,
      ),
  });
  const catalog = useQuery({
    queryKey: ["courses", "organization", detail.id],
    queryFn: () =>
      fetchJson<CourseCatalogResponse>(
        `/api/organizations/${encodeURIComponent(detail.id)}/courses`,
      ),
  });
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: ["organizations", detail.id, "assignments"],
    });
  const assign = useMutation({
    mutationFn: async (target: string) => {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(detail.id)}/assignments`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ scenarioId: target }),
        },
      );
      await mutationResponse(response, "Failed to assign scenario");
    },
    onSuccess: async () => {
      setScenarioId("");
      await invalidate();
    },
  });
  const unassign = useMutation({
    mutationFn: async (assignmentId: string) => {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(detail.id)}/assignments/${encodeURIComponent(assignmentId)}`,
        { method: "DELETE", credentials: "include" },
      );
      await mutationResponse(response, "Failed to remove assignment");
    },
  });
  // A removed row shows "Removed" with a drawn check, then folds away.
  const [removal, setRemoval] = useState<{
    id: string;
    folding: boolean;
  } | null>(null);
  const removeAssignment = (id: string) =>
    unassign.mutate(id, {
      onSuccess: async () => {
        setRemoval({ id, folding: false });
        await wait(600);
        setRemoval({ id, folding: true });
        await wait(300);
        queryClient.setQueryData<AssignmentsResponse>(
          ["organizations", detail.id, "assignments"],
          (data) =>
            data && {
              ...data,
              assignments: data.assignments.filter((item) => item.id !== id),
            },
        );
        setRemoval(null);
        await invalidate();
      },
    });

  const entries = assignments.data?.assignments ?? [];
  const assignedIds = new Set(entries.map((entry) => entry.scenarioId));
  const catalogLectures = (catalog.data?.courses ?? []).flatMap((course) =>
    course.lectures.flatMap((lecture) =>
      lecture.scenarioId ? [{ course, lecture }] : [],
    ),
  );
  const assignable = catalogLectures.filter(
    ({ lecture }) => lecture.scenarioId && !assignedIds.has(lecture.scenarioId),
  );
  const catalogLectureByScenarioId = new Map(
    catalogLectures.map(({ course, lecture }) => [
      lecture.scenarioId!,
      { course, lecture },
    ]),
  );
  const actionError = assign.error ?? unassign.error;

  return (
    <Section
      density="compact"
      title="Assignments"
      description="Assignment markers are separate from catalog visibility: every member can browse the organization library."
      actions={
        admin && assignable.length ? (
          <>
            <NativeSelect
              value={scenarioId}
              onChange={(event) => setScenarioId(event.target.value)}
              aria-label="Scenario to assign"
            >
              <option value="">Choose a scenario…</option>
              {assignable.map(({ lecture }) => (
                <option key={lecture.scenarioId} value={lecture.scenarioId!}>
                  {lecture.title}
                </option>
              ))}
            </NativeSelect>
            <Button
              disabled={!scenarioId || assign.isPending}
              onClick={() => assign.mutate(scenarioId)}
            >
              <Plus className="size-4" />
              Assign
            </Button>
          </>
        ) : null
      }
    >
      {assignments.isPending ? (
        <ListSkeleton rows={2} className="divide-y border-0 bg-transparent shadow-none *:px-0" />
      ) : assignments.error ? (
        <ErrorState
          headingLevel={3}
          title="Could not load assignments"
          description="The assignments could not be loaded."
          onRetry={() => assignments.refetch()}
        />
      ) : entries.length ? (
        <PaginatedCollection
          items={entries}
          pageSize={COLLECTION_PAGE_SIZE.list}
          itemLabel="assignments"
        >
          {(visibleAssignments) => (
            <ul className="divide-y">
              {visibleAssignments.map((entry) => {
                const catalogLecture = catalogLectureByScenarioId.get(
                  entry.scenarioId,
                );
                const lecture = entry.lecture ?? assignmentLecture(
                  catalogLecture?.course,
                  catalogLecture?.lecture,
                  detail.id,
                );
                const target =
                  lecture?.state === "locked" ? lecture.blockedBy : lecture;
                const route =
                  lecture && target
                    ? {
                        scope: lecture.scope,
                        courseId: target.courseId,
                        organizationId: detail.id,
                      }
                    : null;
                const title = target?.title ?? entry.scenarioTitle ?? entry.scenarioId;
                const removed = removal?.id === entry.id;
                return (
                  <li
                    key={entry.id}
                    data-folding={(removed && removal.folding) || undefined}
                    // A removed row folds away (rows 1fr → 0fr) before the
                    // list refreshes, so the rows below close up smoothly.
                    className="grid grid-rows-[1fr] transition-[grid-template-rows,opacity,background-color] duration-(--duration-slow) ease-enter has-[[data-inline-confirm][data-asking]]:bg-destructive-subtle/60 data-folding:grid-rows-[0fr] data-folding:opacity-0"
                  >
                    <div className="flex min-h-0 flex-wrap items-center gap-3 overflow-hidden py-3">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                      <BookOpen className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      {route && target ? (
                        <LectureLink
                          route={route}
                          lectureId={target.lectureId}
                          className="text-sm font-semibold hover:text-brand-text"
                        >
                          {target.title}
                        </LectureLink>
                      ) : (
                        <span className="text-sm font-semibold">
                          {entry.scenarioTitle ?? entry.scenarioId}
                        </span>
                      )}
                      <MetaLine
                        dense
                        items={[
                          lecture?.state === "locked" && lecture.blockedBy
                            ? `Complete “${lecture.blockedBy.title}” first`
                            : null,
                          `Assigned ${formatRelativeTime(entry.createdAt)}`,
                        ]}
                      />
                    </div>
                    {admin ? (
                      <InlineConfirm
                        label="Remove"
                        name={`Remove the ${title} assignment`}
                        question={`Remove the ${title} assignment?`}
                        confirmLabel="Remove assignment"
                        pendingLabel="Removing…"
                        doneLabel="Removed"
                        pending={
                          unassign.isPending && unassign.variables === entry.id
                        }
                        done={removed}
                        disabled={
                          (unassign.isPending &&
                            unassign.variables !== entry.id) ||
                          (removal !== null && !removed)
                        }
                        onConfirm={() => removeAssignment(entry.id)}
                      />
                    ) : null}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </PaginatedCollection>
      ) : (
        <div className="flex min-h-40 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
          <Users className="size-5" />
          <p className="text-sm">No scenarios are assigned yet.</p>
        </div>
      )}
      {actionError ? (
        <InlineFeedback tone="error" className="mt-4">
          {actionError.message}
        </InlineFeedback>
      ) : null}
    </Section>
  );
}

function assignmentLecture(
  course: CourseCatalogCourse | undefined,
  lecture: CourseLectureSummary | undefined,
  organizationId: string,
): NonNullable<AssignmentsResponse["assignments"][number]["lecture"]> | null {
  if (!course || !lecture) return null;
  const route = courseRouteForCatalogCourse(course, organizationId);
  if (route.scope === "public") return null;
  return {
    courseId: course.courseId,
    lectureId: lecture.lectureId,
    title: lecture.title,
    state: lecture.state,
    blockedBy: lecture.blockedBy,
    scope: route.scope,
  };
}

const PROGRESS_LABEL = {
  not_started: "Not started",
  in_progress: "In progress",
  solved: "Solved",
  // An assisted solve is a solve; the caption says the solution was used.
  assisted: "Solved",
} as const;

export function ProgressSection({
  detail,
  onAssign,
}: {
  detail: Detail;
  onAssign: () => void;
}) {
  const progress = useQuery({
    queryKey: ["organizations", detail.id, "progress"],
    queryFn: () =>
      fetchJson<ProgressResponse>(
        `/api/organizations/${encodeURIComponent(detail.id)}/progress`,
      ),
    // Assignment and roster changes elsewhere on this page do not invalidate
    // it, so read it fresh each time the tab opens.
    staleTime: 0,
  });
  const data = progress.data?.progress;
  return (
    <Section
      density="compact"
      title="Progress"
      description="Latest learner status across assigned scenarios."
    >
      {!data && progress.error ? (
        <ErrorState
          headingLevel={3}
          title="Could not load progress"
          description="The learner progress could not be loaded."
          onRetry={() => progress.refetch()}
        />
      ) : !data ? (
        <ListSkeleton rows={3} action={false} label="Loading progress…" className="divide-y border-0 bg-transparent shadow-none *:px-0" />
      ) : !data.scenarios.length ? (
        <EmptyState
          headingLevel={3}
          title="No scenarios assigned"
          description="Assign a scenario to start tracking progress."
          action={
            <Button size="sm" variant="outline" onClick={onAssign}>
              Open assignments
            </Button>
          }
        />
      ) : (
        <PaginatedCollection
          items={data.rows}
          pageSize={COLLECTION_PAGE_SIZE.dense}
          itemLabel="members"
        >
          {(visibleRows) => (
            <Table label="Learner progress">
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  {data.scenarios.map((scenario) => (
                    <TableHead key={scenario.scenarioId}>
                      {scenario.title ?? (
                        <code className="text-xs font-normal">
                          {scenario.scenarioId}
                        </code>
                      )}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((row) => (
                  <TableRow key={row.userId}>
                    <TableRowHeader>
                      <p className="font-medium">{row.name}</p>
                      {row.githubUsername ? (
                        <p className="text-caption">@{row.githubUsername}</p>
                      ) : null}
                    </TableRowHeader>
                    {row.cells.map((cell) => {
                      const solved =
                        cell.status === "solved" || cell.status === "assisted";
                      const caption = [
                        cell.solveDurationMs !== null
                          ? formatDurationMs(cell.solveDurationMs)
                          : null,
                        cell.status === "assisted" ? "Solution used" : null,
                      ]
                        .filter(Boolean)
                        .join(" · ");
                      return (
                        <TableCell key={cell.scenarioId}>
                          <Badge
                            variant={
                              solved
                                ? "success"
                                : cell.status === "in_progress"
                                  ? "secondary"
                                  : "outline"
                            }
                          >
                            {solved ? <Check /> : null}
                            {PROGRESS_LABEL[cell.status]}
                          </Badge>
                          {caption ? (
                            <p className="mt-1 text-caption">{caption}</p>
                          ) : null}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </PaginatedCollection>
      )}
    </Section>
  );
}
