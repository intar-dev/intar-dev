import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, BookOpen, Plus, UserMinus, Users } from "lucide-react";
import { useState } from "react";
import { formatDurationMs, formatRelativeTime } from "../../lib/format";
import { InlineFeedback } from "../../patterns/InlineFeedback";
import {
  COLLECTION_PAGE_SIZE,
  PaginatedCollection,
} from "../../patterns/CollectionPagination";
import {
  MetaDifficulty,
  type ScenarioDifficulty,
} from "../../patterns/MetaLine";
import { Section } from "../../patterns/Section";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { ScenarioCatalogWireResponse } from "@/lib/scenario-runs";
import { findScenarioCourseLocation } from "@/lib/course-location";
import { CourseScenarioLink } from "../learn/course-route-links";
import type { OrganizationDetailTab } from "../tab-search";
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
      title="Organization control plane"
      description="Identity, private content, and execution capacity stay inside this boundary."
    >
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
          label="Runners"
          value="Isolated"
          action={admin ? "Manage runners" : "View runners"}
          onClick={() => setTab("runners")}
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
    <div className="rounded-lg bg-muted/40 p-4">
      <dt className="text-eyebrow">{label}</dt>
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

export function MembersSection({ detail }: { detail: Detail }) {
  const queryClient = useQueryClient();
  const admin = detail.role !== "member";
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: ["organizations", detail.id, "detail"],
    });
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
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: async (memberId: string) => {
      const response = await fetch(
        `/api/organizations/${encodeURIComponent(detail.id)}/members/${encodeURIComponent(memberId)}`,
        { method: "DELETE", credentials: "include" },
      );
      await mutationResponse(response, "Failed to remove member");
    },
    onSuccess: invalidate,
  });
  const actionError = changeRole.error ?? remove.error;

  return (
    <Section
      title="Members"
      description="Successful sign-in through the verified OIDC provider creates membership automatically."
    >
      <PaginatedCollection
        items={detail.members}
        pageSize={COLLECTION_PAGE_SIZE.list}
        itemLabel="members"
      >
        {(visibleMembers) => (
          <ul className="divide-y overflow-hidden rounded-lg border">
            {visibleMembers.map((entry) => (
              <li
                key={entry.memberId}
                className="flex flex-wrap items-center gap-4 p-4 sm:p-6"
              >
                <Avatar>
                  <AvatarFallback>{initials(entry.name)}</AvatarFallback>
                </Avatar>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{entry.name}</p>
                  <p className="text-caption">
                    {entry.email}
                    {entry.githubUsername
                      ? ` · @${entry.githubUsername}`
                      : ""}{" "}
                    · joined {formatRelativeTime(entry.joinedAt)}
                  </p>
                </div>
                {admin && entry.role !== "owner" ? (
                  <select
                    value={entry.role}
                    onChange={(event) =>
                      changeRole.mutate({
                        memberId: entry.memberId,
                        role: event.target.value as "admin" | "member",
                      })
                    }
                    disabled={changeRole.isPending}
                    className="h-11 rounded-lg border bg-card px-3 text-sm"
                    aria-label={`Role for ${entry.name}`}
                  >
                    <option value="admin">Admin</option>
                    <option value="member">Member</option>
                  </select>
                ) : (
                  <Badge
                    variant={entry.role === "member" ? "outline" : "secondary"}
                  >
                    {entry.role === "owner"
                      ? "Owner"
                      : entry.role === "admin"
                        ? "Admin"
                        : "Member"}
                  </Badge>
                )}
                {admin && entry.role !== "owner" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-muted-foreground hover:text-destructive"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(entry.memberId)}
                  >
                    <UserMinus className="size-3.5" />
                    Remove
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </PaginatedCollection>
      {actionError ? (
        <InlineFeedback tone="error" className="mt-3">
          {actionError instanceof Error ? actionError.message : "Action failed"}
        </InlineFeedback>
      ) : null}
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
    queryKey: ["organizations", detail.id, "scenarios"],
    queryFn: () =>
      fetchJson<ScenarioCatalogWireResponse>(
        `/api/organizations/${encodeURIComponent(detail.id)}/scenarios`,
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
    onSuccess: invalidate,
  });

  const entries = assignments.data?.assignments ?? [];
  const assignedIds = new Set(entries.map((entry) => entry.scenarioId));
  const catalogEntries =
    catalog.data?.courses.flatMap((course) => course.scenarios) ?? [];
  const assignable = catalogEntries.filter(
    (scenario) => !assignedIds.has(scenario.scenarioId),
  );
  const scenarioById = new Map(
    catalogEntries.map((scenario) => [scenario.scenarioId, scenario]),
  );
  const courseByScenarioId = new Map(
    (catalog.data?.courses ?? []).flatMap((course) =>
      course.scenarios.map((scenario) => [scenario.scenarioId, course] as const),
    ),
  );
  const actionError = assign.error ?? unassign.error;

  return (
    <Section
      title="Assignments"
      description="Assignment markers are separate from catalog visibility: every member can browse the organization library."
      actions={
        admin && assignable.length ? (
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={scenarioId}
              onChange={(event) => setScenarioId(event.target.value)}
              className="h-11 rounded-lg border bg-card px-3 text-sm"
              aria-label="Scenario to assign"
            >
              <option value="">Choose a scenario…</option>
              {assignable.map((scenario) => (
                <option key={scenario.scenarioId} value={scenario.scenarioId}>
                  {scenario.title}
                </option>
              ))}
            </select>
            <Button
              disabled={!scenarioId || assign.isPending}
              onClick={() => assign.mutate(scenarioId)}
            >
              <Plus className="size-4" />
              Assign
            </Button>
          </div>
        ) : null
      }
    >
      {entries.length ? (
        <PaginatedCollection
          items={entries}
          pageSize={COLLECTION_PAGE_SIZE.list}
          itemLabel="assignments"
        >
          {(visibleAssignments) => (
            <ul className="divide-y overflow-hidden rounded-lg border">
              {visibleAssignments.map((entry) => {
                const scenario = scenarioById.get(entry.scenarioId);
                return (
                  <li
                    key={entry.id}
                    className="flex flex-wrap items-center gap-4 p-4 sm:p-6"
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground">
                      <BookOpen className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <CourseScenarioLink
                        location={findScenarioCourseLocation(
                          courseByScenarioId.get(entry.scenarioId)
                            ? [courseByScenarioId.get(entry.scenarioId)!]
                            : [],
                          entry.scenarioId,
                          detail.id,
                        )}
                        scenarioId={entry.scenarioId}
                        fallbackOrganizationId={detail.id}
                        className="text-sm font-semibold hover:text-primary"
                      >
                        {entry.scenarioTitle ?? entry.scenarioId}
                      </CourseScenarioLink>
                      <p className="text-caption">
                        Assigned {formatRelativeTime(entry.createdAt)}
                      </p>
                    </div>
                    {scenario ? (
                      <MetaDifficulty
                        difficulty={scenario.difficulty as ScenarioDifficulty}
                      />
                    ) : null}
                    {admin ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={unassign.isPending}
                        onClick={() => unassign.mutate(entry.id)}
                      >
                        Remove
                      </Button>
                    ) : (
                      <ArrowRight className="size-4 text-muted-foreground" />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </PaginatedCollection>
      ) : (
        <div className="flex min-h-40 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
          <Users className="size-5" />
          <p className="text-sm">No scenarios are assigned yet.</p>
        </div>
      )}
      {actionError ? (
        <InlineFeedback tone="error" className="mt-3">
          {actionError instanceof Error
            ? actionError.message
            : "Assignment action failed"}
        </InlineFeedback>
      ) : null}
    </Section>
  );
}

export function ProgressSection({ detail }: { detail: Detail }) {
  const progress = useQuery({
    queryKey: ["organizations", detail.id, "progress"],
    queryFn: () =>
      fetchJson<ProgressResponse>(
        `/api/organizations/${encodeURIComponent(detail.id)}/progress`,
      ),
  });
  if (progress.error) {
    return (
      <InlineFeedback tone="error">
        {progress.error instanceof Error
          ? progress.error.message
          : "Failed to load progress"}
      </InlineFeedback>
    );
  }
  const data = progress.data?.progress;
  return (
    <Section
      title="Progress"
      description="Latest learner status across assigned scenarios."
    >
      {!data ? (
        <p className="text-sm text-muted-foreground">Loading progress…</p>
      ) : !data.scenarios.length ? (
        <p className="text-sm text-muted-foreground">
          Assign a scenario to start tracking progress.
        </p>
      ) : (
        <PaginatedCollection
          items={data.rows}
          pageSize={COLLECTION_PAGE_SIZE.dense}
          itemLabel="members"
        >
          {(visibleRows) => (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Member</TableHead>
                  {data.scenarios.map((scenario) => (
                    <TableHead key={scenario.scenarioId}>
                      {scenario.title ?? scenario.scenarioId}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRows.map((row) => (
                  <TableRow key={row.userId}>
                    <TableCell>
                      <p className="font-medium">{row.name}</p>
                      {row.githubUsername ? (
                        <p className="text-caption">@{row.githubUsername}</p>
                      ) : null}
                    </TableCell>
                    {row.cells.map((cell) => (
                      <TableCell key={cell.scenarioId}>
                        <Badge
                          variant={
                            cell.status === "solved"
                              ? "success"
                              : cell.status === "in_progress"
                                ? "secondary"
                                : "outline"
                          }
                        >
                          {cell.status.replace("_", " ")}
                        </Badge>
                        {cell.solveDurationMs !== null ? (
                          <p className="mt-1 text-caption">
                            {formatDurationMs(cell.solveDurationMs)}
                          </p>
                        ) : null}
                      </TableCell>
                    ))}
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
