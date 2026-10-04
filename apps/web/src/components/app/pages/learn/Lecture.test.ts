import { describe, expect, it } from "vitest";
import { lectureGateCopy } from "./Lecture";

describe("lectureGateCopy", () => {
  it("names the lecture that opens next", () => {
    const copy = lectureGateCopy({ sequential: true, next: { title: "Broken Nginx" } });
    expect(copy.todoText).toContain("one lecture at a time");
    expect(copy.todoText).toContain("Broken Nginx");
    expect(copy.doneText).toBe("Broken Nginx is open.");
    expect(copy.announcement).toBe("Lecture complete. Broken Nginx is open.");
    expect(copy.doneHeading).toBe("Lecture complete");
  });

  it("drops the sequential claim for a free-order course", () => {
    const copy = lectureGateCopy({ sequential: false, next: { title: "Next" } });
    expect(copy.todoText).not.toContain("one lecture at a time");
  });

  it("finishes the course on the last lecture", () => {
    const copy = lectureGateCopy({ sequential: true, next: null });
    expect(copy.doneHeading).toBe("Course complete");
    expect(copy.doneText).toBe("You completed every lecture in this course.");
  });
});
