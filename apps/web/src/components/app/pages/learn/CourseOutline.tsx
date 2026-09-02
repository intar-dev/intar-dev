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
import {
  lectureStatePresentation,
  type CourseCatalogCourse,
  type CourseLectureSummary,
  type CourseRouteRef,
} from "./course-wire";

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
        className="sticky top-[calc(var(--app-bar-h)+1.5rem)] max-h-[calc(100dvh-var(--app-bar-h)-3rem)] overflow-y-auto overscroll-contain border-l pl-6 pr-1"
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
          <SheetHeader className="border-b px-4 py-3 pr-14">
            <SheetTitle>Course outline</SheetTitle>
            <SheetDescription>
              Lecture {position} of {total} · {completed} complete
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

  return (
    <nav aria-label={`${course.title} lectures`}>
      <div className={cn("space-y-2", compact && "sr-only")}>
        <CourseLink
          route={route}
          className="inline-flex rounded-sm text-card-title transition-colors hover:text-primary"
        >
          {course.title}
        </CourseLink>
        <p className="text-caption tabular-nums">
          Lecture {position} of {total} · {completed} complete
        </p>
      </div>
      <ol className={cn("divide-y", compact ? "border-y" : "mt-4 border-y")}>
        {course.lectures.map((lecture, index) => (
          <CourseOutlineItem
            key={lecture.lectureId}
            lecture={lecture}
            route={route}
            ordinal={index + 1}
            current={lecture.lectureId === currentLectureId}
          />
        ))}
      </ol>
    </nav>
  );
}

function CourseOutlineItem({
  lecture,
  route,
  ordinal,
  current,
}: {
  lecture: CourseLectureSummary;
  route: CourseRouteRef;
  ordinal: number;
  current: boolean;
}) {
  const state = lectureStatePresentation(lecture.state);
  const content = (
    <>
      <span className="pt-0.5 text-xs text-muted-foreground tabular-nums">
        {String(ordinal).padStart(2, "0")}
      </span>
      <span className="min-w-0 space-y-1">
        <span className="block text-sm font-medium leading-5 [overflow-wrap:anywhere]">
          {lecture.title}
        </span>
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {lecture.state === "completed" ? (
            <CheckCircle2 className="size-3.5 text-success" aria-hidden="true" />
          ) : lecture.state === "locked" ? (
            <LockKeyhole className="size-3.5" aria-hidden="true" />
          ) : (
            <span
              className={cn(
                "size-2 rounded-full",
                current ? "bg-primary" : "border border-current",
              )}
              aria-hidden="true"
            />
          )}
          {current ? `Current · ${state.word}` : state.word}
        </span>
      </span>
    </>
  );
  const className = cn(
    "grid min-h-14 grid-cols-[1.5rem_minmax(0,1fr)] gap-2.5 px-2 py-3 text-left transition-colors",
    current && "bg-brand-subtle text-brand-text",
    !current && lecture.state !== "locked" && "hover:bg-muted",
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
            "rounded-sm focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40",
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
