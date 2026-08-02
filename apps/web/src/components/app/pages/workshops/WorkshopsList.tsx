import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight,
  CalendarClock,
  ClipboardList,
  Presentation,
  Radio,
} from "lucide-react";
import { MetaLine } from "@/components/app/patterns/MetaLine";
import { PageShell } from "@/components/app/patterns/PageShell";
import { ErrorState, EmptyState } from "@/components/app/patterns/StateCard";
import { usePageChrome } from "@/components/app/shell/page-chrome";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { getWorkshops } from "@/components/app/workshops/api";
import type {
  WorkshopSessionState,
  WorkshopSessionSummary,
} from "@/components/app/workshops/types";
import { workshopSessionStateLabel } from "@/components/app/workshops/types";

export function WorkshopsList() {
  usePageChrome({ title: "Workshops" });
  const workshops = useQuery({
    queryKey: ["workshops", "list"],
    queryFn: getWorkshops,
    retry: 1,
    staleTime: 5_000,
    refetchInterval: (query) =>
      query.state.data?.sessions.some(
        (session) => session.state === "live" || session.state === "lobby",
      )
        ? 2_000
        : false,
  });

  const groups = useMemo(() => {
    const sessions = workshops.data?.sessions ?? [];
    return {
      live: sessions.filter(
        (session) => session.state === "live" || session.state === "lobby",
      ),
      upcoming: sessions.filter((session) => session.state === "draft"),
      archive: sessions.filter(
        (session) => session.state === "ended" || session.state === "cancelled",
      ),
    };
  }, [workshops.data?.sessions]);

  if (workshops.error) {
    return (
      <PageShell width="content">
        <ErrorState
          title="Could not load workshops"
          description={
            workshops.error instanceof Error
              ? workshops.error.message
              : "The workshop ledger is unavailable."
          }
          onRetry={() => void workshops.refetch()}
        />
      </PageShell>
    );
  }

  if (!workshops.data) {
    return <WorkshopsLoading />;
  }

  if (!workshops.data.sessions.length) {
    return (
      <PageShell width="content">
        <EmptyState
          icon={<Presentation />}
          title="No workshop sessions yet"
          description="When an organization enrolls you in a live workshop, its lobby and schedule will appear here."
        />
      </PageShell>
    );
  }

  return (
    <PageShell width="content" density="comfortable">
      <header className="max-w-2xl space-y-2 py-2">
        <p className="text-eyebrow">Facilitated practice</p>
        <p className="font-heading text-2xl font-semibold tracking-[-0.03em] text-balance sm:text-3xl">
          Learn together on live infrastructure.
        </p>
        <p className="max-w-[68ch] text-sm leading-6 text-muted-foreground">
          Check in before the start, keep one workspace for the whole session,
          and follow the room’s shared pace.
        </p>
      </header>

      {groups.live.length ? (
        <WorkshopGroup
          id="live-workshops"
          eyebrow="In the room"
          title="Live now"
          sessions={groups.live}
          emphasized
        />
      ) : null}
      {groups.upcoming.length ? (
        <WorkshopGroup
          id="upcoming-workshops"
          eyebrow="On your schedule"
          title="Upcoming"
          sessions={groups.upcoming}
        />
      ) : null}
      {groups.archive.length ? (
        <WorkshopGroup
          id="workshop-archive"
          eyebrow="Your record"
          title="Past workshops"
          sessions={groups.archive}
        />
      ) : null}
    </PageShell>
  );
}

function WorkshopGroup({
  id,
  eyebrow,
  title,
  sessions,
  emphasized = false,
}: {
  id: string;
  eyebrow: string;
  title: string;
  sessions: WorkshopSessionSummary[];
  emphasized?: boolean;
}) {
  return (
    <section aria-labelledby={id} className="space-y-3">
      <div>
        <p className="text-eyebrow">{eyebrow}</p>
        <h2 id={id} className="mt-1 text-section-title">
          {title}
        </h2>
      </div>
      <div
        className={cn(
          "divide-y overflow-hidden rounded-xl border bg-card",
          emphasized && "border-brand-border",
        )}
      >
        {sessions.map((session) => (
          <Link
            key={session.id}
            to="/workshops/$sessionId"
            params={{ sessionId: session.id }}
            className="group grid min-h-24 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 px-4 py-4 transition-colors hover:bg-muted/50 sm:gap-4 sm:px-6"
          >
            <span
              className={cn(
                "flex size-10 shrink-0 items-center justify-center rounded-lg",
                session.state === "live"
                  ? "bg-brand-subtle text-brand-text"
                  : "bg-muted text-muted-foreground",
              )}
            >
              {session.state === "live" ? (
                <Radio className="size-4 motion-safe:animate-pulse" />
              ) : session.state === "draft" ? (
                <CalendarClock className="size-4" />
              ) : (
                <ClipboardList className="size-4" />
              )}
            </span>
            <span className="min-w-0">
              <span className="flex flex-wrap items-center gap-2">
                <span className="text-card-title text-balance">
                  {session.title}
                </span>
                <SessionStateBadge state={session.state} />
              </span>
              <span className="mt-1 block text-sm text-muted-foreground">
                {session.organizationName}
                {session.currentModuleTitle
                  ? ` · ${session.currentModuleTitle}`
                  : ` · ${session.templateTitle}`}
              </span>
              <MetaLine
                className="mt-1"
                items={[
                  formatSessionTime(session),
                  `${session.participantCount} participant${session.participantCount === 1 ? "" : "s"}`,
                  session.workspaceState
                    ? session.workspaceState.replace("_", " ")
                    : null,
                ]}
              />
            </span>
            <span className="flex items-center gap-2 text-sm font-semibold text-brand-text">
              <span className="hidden sm:inline">
                {session.state === "live" || session.state === "lobby"
                  ? "Enter room"
                  : "Open"}
              </span>
              <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </span>
          </Link>
        ))}
      </div>
    </section>
  );
}

function SessionStateBadge({ state }: { state: WorkshopSessionState }) {
  const variant =
    state === "live"
      ? "default"
      : state === "lobby"
        ? "warning"
        : state === "ended"
          ? "success"
          : "outline";
  return <Badge variant={variant}>{workshopSessionStateLabel(state)}</Badge>;
}

function formatSessionTime(session: WorkshopSessionSummary): string {
  const start = new Date(session.startsAt);
  if (session.state === "ended" || session.state === "cancelled") {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
    }).format(start);
  }
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(start);
}

function WorkshopsLoading() {
  return (
    <PageShell width="content">
      <div role="status" className="space-y-6">
        <span className="sr-only">Loading workshops…</span>
        <div className="space-y-3 py-2">
          <Skeleton className="h-3 w-28" />
          <Skeleton className="h-9 w-full max-w-xl" />
          <Skeleton className="h-5 w-full max-w-2xl" />
        </div>
        <Skeleton className="h-44 w-full rounded-xl" />
        <Skeleton className="h-32 w-full rounded-xl" />
      </div>
    </PageShell>
  );
}
