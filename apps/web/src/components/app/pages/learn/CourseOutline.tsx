import { useLayoutEffect, useRef } from "react";
import { CheckCircle2, ListTree, LockKeyhole } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
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
      className="hidden min-w-0 min-[1100px]:block"
      data-course-outline-rail
    >
      <div
        className="sticky top-[calc(var(--app-bar-h)+2rem)] max-h-[calc(100dvh-var(--app-bar-h)-3.5rem)] overflow-y-auto overscroll-contain pl-2 pr-1"
        role="region"
        aria-label="Course outline navigation"
        tabIndex={0}
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

  return (
    <div className="min-[1100px]:hidden" data-course-outline-mobile>
      <Sheet>
        <SheetTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="gap-1.5 px-2.5"
              aria-label={`Open course outline. Lecture ${position} of ${total}. ${completed} complete.`}
            />
          }
        >
          <ListTree className="size-4" aria-hidden="true" />
          <span className="tabular-nums">
            {position}/{total}
          </span>
        </SheetTrigger>
        <SheetContent
          side="bottom"
          className="max-h-[min(82dvh,48rem)] gap-0 overflow-hidden rounded-t-2xl border-x border-t pb-[max(1rem,env(safe-area-inset-bottom))] !shadow-none motion-reduce:transition-none"
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
            role="region"
            aria-label="Course outline navigation"
            tabIndex={0}
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
      <div className={cn("space-y-1 px-3", compact && "sr-only")}>
        <CourseLink
          route={route}
          className="inline-flex rounded-sm text-card-title transition-colors duration-150 hover:text-brand-text"
        >
          {course.title}
        </CourseLink>
        <p className="text-caption tabular-nums">
          Lecture <RollingNumber value={position} /> of {total} ·{" "}
          <RollingNumber value={completed} /> complete
        </p>
        <LectureProgressTrack
          lectures={course.lectures}
          currentIndex={currentIndex}
          className="pt-2 *:h-1 *:flex-1 *:data-current:grow-[3]"
        />
      </div>
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
  const content = (
    <>
      <span
        className={cn(
          "pt-0.5 text-xs font-medium tabular-nums",
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
          {lecture.state === "completed" ? (
            <CheckCircle2
              className={cn("size-3.5 text-success", justCompleted && "draw-check")}
              aria-hidden="true"
            />
          ) : lecture.state === "locked" ? (
            <LockKeyhole className="size-3.5" aria-hidden="true" />
          ) : (
            <span
              className={cn(
                "size-2 rounded-full",
                current
                  ? "bg-primary text-primary motion-safe:animate-live"
                  : "border border-current",
              )}
              aria-hidden="true"
            />
          )}
          <span>{current ? `Current · ${state.word}` : state.word}</span>
          <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
            <span aria-hidden="true">·</span>
            <LectureScenarioLabel scenarioId={lecture.scenarioId} />
          </span>
        </span>
      </span>
    </>
  );
  const className = cn(
    "grid min-h-14 grid-cols-[1.5rem_minmax(0,1fr)] gap-2 rounded-[0.625rem] px-3 py-2 text-left transition-colors duration-150 ease-standard",
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
