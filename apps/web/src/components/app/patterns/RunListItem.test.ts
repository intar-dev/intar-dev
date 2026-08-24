import { describe, expect, it } from "vitest";
import {
  runCourseContextLabel,
  runListItemActionLabel,
  runListItemLinkLabel,
  type RunListItemData,
} from "./RunListItem";

describe("run list item labels", () => {
  it("gives repeated replay actions distinct accessible names", () => {
    const firstAttempt = run({ attemptNumber: 1 });
    const secondAttempt = run({ attemptNumber: 2 });

    expect(runListItemActionLabel(firstAttempt)).toBe(
      "Watch replay of Restore the web rollout, attempt 1",
    );
    expect(runListItemActionLabel(secondAttempt)).toBe(
      "Watch replay of Restore the web rollout, attempt 2",
    );
    expect(runListItemLinkLabel(secondAttempt)).toBe(
      "View Restore the web rollout, attempt 2",
    );
  });

  it("shows captured course context and its step when available", () => {
    expect(runCourseContextLabel(run().courseLocation)).toBe(
      "Kubernetes DevOps Fundamentals · Step 4 of 8",
    );
  });
});

function run(overrides: Partial<RunListItemData> = {}): RunListItemData {
  return {
    runId: "run-1",
    title: "Restore the web rollout",
    outcome: "succeeded",
    active: false,
    activity: "settled",
    createdAt: 1_724_537_400_000,
    solveDurationMs: 45_000,
    hasReplay: true,
    courseLocation: {
      courseKind: "authored",
      scope: "public",
      organizationId: null,
      courseId: "kubernetes-devops-fundamentals",
      courseTitle: "Kubernetes DevOps Fundamentals",
      step: 4,
      steps: 8,
    },
    ...overrides,
  };
}
