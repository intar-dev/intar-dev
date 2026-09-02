import { describe, expect, it } from "vitest";
import {
  getCourseOutlineProgress,
  isCourseOutlineLectureNavigable,
} from "./CourseOutline";
import type { CourseLectureSummary } from "./course-wire";

const lecture = (
  lectureId: string,
  state: CourseLectureSummary["state"],
): CourseLectureSummary => ({
  lectureId,
  title: lectureId,
  summary: "",
  category: "",
  tags: [],
  estimatedMinutes: null,
  scenarioId: null,
  state,
  blockedBy: null,
  activeRunId: null,
  scenarioReady: null,
});

describe("course outline", () => {
  const lectures = [
    lecture("first", "completed"),
    lecture("current", "in_progress"),
    lecture("next", "locked"),
  ];

  it("shows the current position and completed count", () => {
    expect(getCourseOutlineProgress(lectures, "current")).toEqual({
      position: 2,
      total: 3,
      completed: 1,
    });
  });

  it("links accessible lectures but not the current or locked lecture", () => {
    expect(isCourseOutlineLectureNavigable(lectures[0]!, false)).toBe(true);
    expect(isCourseOutlineLectureNavigable(lectures[1]!, true)).toBe(false);
    expect(isCourseOutlineLectureNavigable(lectures[2]!, false)).toBe(false);
  });
});
