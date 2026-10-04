import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ListOrdered, LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useShortViewport } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";
import { CourseLink, LectureLink } from "./course-links";
import { LectureScenarioLabel } from "./LectureScenarioLabel";
import { LectureProgressTrack } from "./LectureProgressTrack";
import {
  lectureStatePresentation,
  type CourseCatalogCourse,
  type CourseLectureSummary,
  type CourseRouteRef,
} from "./course-wire";
import { RollingNumber } from "@/components/app/patterns/RollingNumber";
import { useJustReached } from "@/components/app/patterns/use-just-reached";

interface CourseOutlineProps {
  course: CourseCatalogCourse;
  route: CourseRouteRef;
  currentLectureId: string;
}

export function CourseOutlineRail(props: CourseOutlineProps) {
  return (
    <aside
      aria-label="Course outline"
      className="hidden min-w-0 @min-[58rem]/panel:block"
      data-course-outline-rail
    >
      {/* Below lg the bar also clears the top safe area (a notch). */}
      <div
        className="sticky top-[calc(var(--app-bar-h)+env(safe-area-inset-top)+2rem)] max-h-[calc(100dvh-var(--app-bar-h)-env(safe-area-inset-top)-3.5rem)] overflow-y-auto overscroll-contain py-1 pl-2 pr-1 lg:top-[calc(var(--app-bar-h)+2rem)] lg:max-h-[calc(100dvh-var(--app-bar-h)-3.5rem)]"
      >
        <CourseOutlineContent {...props} />
      </div>
    </aside>
  );
}

export function CourseOutlineMobile(props: CourseOutlineProps) {
  const { position, total, completed } = getCourseOutlineProgress(
    props.course.lectures,
    props.currentLectureId,
  );

  const [open, setOpen] = useState(false);
  const short = useShortViewport();
  // Tablets and landscape phones get a side sheet; portrait phones a bottom
  // one. Chosen when it opens, so it never flips under the reader's hands.
  const [side, setSide] = useState<"bottom" | "right">("bottom");

  // The trigger is hidden once the rail shows (a panel at least 58rem wide,
  // which only the page's own container can tell); a sheet left open would
  // stay a modal over a page that no longer has a trigger.
  useEffect(() => {
    const panel = document.getElementById("main-content");
    if (!panel) return;
    const observer = new ResizeObserver(() => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
      if (panel.clientWidth >= 58 * rem) setOpen(false);
    });
    observer.observe(panel);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="@min-[58rem]/panel:hidden" data-course-outline-mobile>
      <Sheet
        open={open}
        onOpenChange={(next) => {
          if (next) {
            setSide(
              short || window.matchMedia("(min-width: 48rem)").matches
                ? "right"
                : "bottom",
            );
          }
          setOpen(next);
        }}
      >
        <SheetTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-label={`Course outline, lecture ${position} of ${total}`}
            />
          }
        >
          <ListOrdered aria-hidden="true" />
          <span className="max-md:hidden">Outline</span>
        </SheetTrigger>
        <SheetContent
          side={side}
          handleLabel="Close course outline"
          className="overflow-hidden data-[side=right]:gap-0 data-[side=right]:rounded-l-2xl"
          data-course-outline-sheet
        >
          <SheetHeader className="border-b pr-14">
            <SheetTitle>Course outline</SheetTitle>
            <SheetDescription>
              Lecture <RollingNumber value={position} /> of {total} ·{" "}
          <RollingNumber value={completed} /> complete
            </SheetDescription>
          </SheetHeader>
          <div
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4"
            onClickCapture={(event) => {
              // Choosing a lecture closes the sheet so it leaves before the page changes.
              if ((event.target as Element).closest("a[href]")) setOpen(false);
            }}
          >
            <CourseOutlineContent {...props} compact />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** Moves an absolutely placed highlight onto one outline row. */
function placeAt(element: HTMLElement, item: HTMLElement) {
  element.style.transform = `translateY(${item.offsetTop}px)`;
  element.style.height = `${item.offsetHeight}px`;
}

function CourseOutlineContent({
  course,
  route,
  currentLectureId,
  compact = false,
}: CourseOutlineProps & { compact?: boolean }) {
  const { position, total, completed } = getCourseOutlineProgress(
    course.lectures,
    currentLectureId,
  );
  const list = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const ghost = useRef<HTMLSpanElement>(null);
  const justCompleted = useJustReached(
    course.lectures.map((lecture) => [lecture.lectureId, lecture.state] as const),
    "completed",
  );
  const currentIndex = course.lectures.findIndex(
    (lecture) => lecture.lectureId === currentLectureId,
  );

  // The raised card is one element that glides to the current lecture. It is
  // placed without travel first, then glides on later changes; a resize (a
  // title rewrapping) re-places it. A hidden rail measures 0, so the card
  // waits and is placed without travel once the rail shows again.
  useLayoutEffect(() => {
    const container = list.current;
    const raised = pill.current;
    if (!container || !raised) return;
    let ready = 0;
    const place = () => {
      const item = container.querySelector<HTMLElement>("li[data-current] > *");
      raised.hidden = !item;
      if (!item) return;
      if (!container.offsetHeight) {
        delete container.dataset.ready;
        return;
      }
      placeAt(raised, item);
      if (container.dataset.ready !== undefined) return;
      cancelAnimationFrame(ready);
      ready = requestAnimationFrame(() => {
        container.dataset.ready = "";
      });
    };
    // Picking a lecture hides the hover ghost so it never covers the card.
    if (ghost.current) delete ghost.current.dataset.on;
    place();
    const observer = new ResizeObserver(place);
    observer.observe(container);
    return () => {
      cancelAnimationFrame(ready);
      observer.disconnect();
    };
  }, [currentLectureId, course.lectures.length]);

  return (
    <nav aria-label={`${course.title} lectures`}>
      {compact ? null : (
        <div className="space-y-1 px-3">
          <CourseLink
            route={route}
            className="inline-flex rounded-sm text-card-title transition-colors duration-(--duration-fast) ease-standard hover:text-brand-text"
          >
            {course.title}
          </CourseLink>
          <p className="text-metadata">
            Lecture <RollingNumber value={position} /> of {total} ·{" "}
            <RollingNumber value={completed} /> complete
          </p>
          <LectureProgressTrack
            lectures={course.lectures}
            currentIndex={currentIndex}
            className="pt-2 *:h-1 *:flex-1 *:data-current:grow-[3]"
          />
        </div>
      )}
      <div
        ref={list}
        className={cn("group/outline relative", compact ? "" : "mt-4")}
        onPointerOver={(event) => {
          // Touch has no hover: a tap would leave the highlight behind.
          if (event.pointerType !== "mouse") return;
          const target = ghost.current;
          const row = (event.target as HTMLElement).closest<HTMLElement>(
            "li[data-lecture-state]",
          );
          if (!target || !row) return;
          // The current and locked rows aren't links: the ghost steps aside.
          const item = row.querySelector<HTMLElement>(":scope > a");
          if (!item) {
            delete target.dataset.on;
            return;
          }
          // Appear in place when arriving from outside; glide between rows.
          if (target.dataset.on === undefined) {
            delete target.dataset.glide;
            placeAt(target, item);
            void target.offsetWidth;
          } else {
            placeAt(target, item);
          }
          target.dataset.glide = "";
          target.dataset.on = "";
        }}
        onPointerLeave={() => {
          if (ghost.current) delete ghost.current.dataset.on;
        }}
      >
        <span ref={pill} aria-hidden="true" data-outline-pill />
        <span ref={ghost} aria-hidden="true" data-outline-ghost />
        <ol className="relative space-y-1">
          {course.lectures.map((lecture, index) => (
            <CourseOutlineItem
              key={lecture.lectureId}
              lecture={lecture}
              route={route}
              ordinal={index + 1}
              current={lecture.lectureId === currentLectureId}
              justCompleted={justCompleted.has(lecture.lectureId)}
            />
          ))}
        </ol>
      </div>
    </nav>
  );
}

function CourseOutlineItem({
  lecture,
  route,
  ordinal,
  current,
  justCompleted,
}: {
  lecture: CourseLectureSummary;
  route: CourseRouteRef;
  ordinal: number;
  current: boolean;
  justCompleted: boolean;
}) {
  const state = lectureStatePresentation(lecture.state);
  const kind =
    lecture.state === "completed"
      ? "done"
      : lecture.state === "locked"
        ? "locked"
        : current
          ? "live"
          : "ring";
  const word = current ? `Current · ${state.word}` : state.word;
  // Changes after the first render rise in; nothing animates on load.
  const firstKind = useRef(kind);
  const firstWord = useRef(word);
  const content = (
    <>
      <span
        className={cn(
          "pt-0.5 text-xs font-medium tabular-nums transition-colors duration-(--duration-moderate) ease-standard",
          current ? "text-brand-text" : "text-faint-foreground",
        )}
      >
        {String(ordinal).padStart(2, "0")}
      </span>
      <span className="min-w-0 space-y-1">
        <span className="block text-sm font-medium leading-5 [overflow-wrap:anywhere]">
          {lecture.title}
        </span>
        <span className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-faint-foreground">
          <span
            key={kind}
            aria-hidden="true"
            className={cn(
              "inline-grid size-3.5 shrink-0 place-items-center",
              kind !== firstKind.current && "animate-roll",
            )}
          >
            {kind === "done" ? (
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                className={cn(
                  "size-3.5 text-success [--draw-length:1]",
                  justCompleted && "draw-check",
                )}
              >
                <circle cx="12" cy="12" r="10" />
                <path pathLength={1} d="m9 12 2 2 4-4" />
              </svg>
            ) : kind === "locked" ? (
              <LockKeyhole className="size-3.5" />
            ) : (
              <span
                // The One Pulse Rule: the dot breathes only while no run's
                // live state does (global.css).
                data-pulse={kind === "live" ? "yields" : undefined}
                className={cn(
                  "size-2 rounded-full",
                  kind === "live"
                    ? "bg-primary text-primary motion-safe:animate-live"
                    : "border border-current",
                )}
              />
            )}
          </span>
          <span
            key={word}
            className={cn(
              "inline-block",
              word !== firstWord.current && "animate-roll",
            )}
          >
            {word}
          </span>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span aria-hidden="true">·</span>
            <LectureScenarioLabel scenarioId={lecture.scenarioId} />
          </span>
        </span>
      </span>
    </>
  );
  const className = cn(
    "grid min-h-14 grid-cols-[1.5rem_minmax(0,1fr)] gap-2 rounded-[0.625rem] px-3 py-2 text-left transition-colors duration-(--duration-fast) ease-standard",
    current && "text-foreground",
    lecture.state === "locked" && "text-muted-foreground",
  );

  return (
    <li data-lecture-state={lecture.state} data-current={current || undefined}>
      {!isCourseOutlineLectureNavigable(lecture, current) ? (
        <div className={className} aria-current={current ? "step" : undefined}>
          {content}
        </div>
      ) : (
        <LectureLink
          route={route}
          lectureId={lecture.lectureId}
          className={cn(
            className,
            "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
          )}
        >
          {content}
        </LectureLink>
      )}
    </li>
  );
}

export function getCourseOutlineProgress(
  lectures: readonly CourseLectureSummary[],
  currentLectureId: string,
) {
  const currentIndex = lectures.findIndex(
    (lecture) => lecture.lectureId === currentLectureId,
  );
  return {
    position: currentIndex >= 0 ? currentIndex + 1 : 1,
    total: lectures.length,
    completed: lectures.filter((lecture) => lecture.state === "completed").length,
  };
}

export function isCourseOutlineLectureNavigable(
  lecture: CourseLectureSummary,
  current: boolean,
) {
  return !current && lecture.state !== "locked";
}
