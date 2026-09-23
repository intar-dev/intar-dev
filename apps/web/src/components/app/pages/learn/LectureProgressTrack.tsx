import { cn } from "@/lib/utils";
import type { CourseLectureSummary } from "./course-wire";

const PROGRESS_SEGMENT_TONES: Record<CourseLectureSummary["state"], string> = {
  completed: "bg-success",
  in_progress: "bg-primary",
  available: "bg-border-strong/70",
  waiting_for_scenario: "bg-border-strong/70",
  locked: "bg-border",
};

// One quiet segment per lecture: verified work, the current unit, and what is
// left. The adjacent "n of m complete" meta line carries the same fact in words.
export function LectureProgressTrack({
  lectures,
  className,
}: {
  lectures: readonly Pick<CourseLectureSummary, "state">[];
  className?: string;
}) {
  if (!lectures.length) return null;
  return (
    <span aria-hidden="true" className={cn("flex gap-1", className)}>
      {lectures.map((lecture, index) => (
        <span
          key={index}
          className={cn(
            "h-1 w-6 rounded-full transition-colors duration-300",
            PROGRESS_SEGMENT_TONES[lecture.state],
          )}
        />
      ))}
    </span>
  );
}
