import { ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LectureLink } from "./course-links";
import type { CourseLectureSummary, CourseRouteRef } from "./course-wire";

export function CourseNextAction({
  route,
  lecture,
  variant = "default",
}: {
  route: CourseRouteRef;
  lecture: Pick<CourseLectureSummary, "lectureId" | "title">;
  variant?: "default" | "outline";
}) {
  return (
    <div
      className="grid w-full max-w-4xl min-w-0 gap-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center"
      data-course-next-action
    >
      <div className="min-w-0 space-y-1">
        <p className="text-label">Up next</p>
        <p className="text-card-title text-pretty [overflow-wrap:anywhere]">
          {lecture.title}
        </p>
      </div>
      <Button
        variant={variant}
        className="group w-full [@media(pointer:coarse)]:min-h-11 md:w-auto"
        render={
          <LectureLink route={route} lectureId={lecture.lectureId}>
            Next lecture
            <ArrowRight
              className="size-4 motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5"
              aria-hidden
            />
          </LectureLink>
        }
      />
    </div>
  );
}
