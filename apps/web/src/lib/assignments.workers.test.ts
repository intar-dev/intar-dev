/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import {
  member,
  organization,
  scenarioAssignments,
  user,
  type CourseCatalogCourseV2,
  type CourseCatalogSnapshotV2,
} from "@/db/schema";
import { listMyAssignments } from "@/lib/assignments";
import { syncScenarioCourseCatalogSnapshot } from "@/lib/scenario-course-catalogs";
import { resetD1Database } from "@/test/d1-migrations";

describe("course assignments", () => {
  beforeEach(resetD1Database);

  it("links a locked assignment to its required lecture", async () => {
    const db = drizzle(env.DB);
    await db.insert(user).values({
      id: "learner",
      name: "Learner",
      email: "learner@example.test",
      emailVerified: true,
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    await db.insert(organization).values({
      id: "org",
      name: "Organization",
      slug: "organization",
      createdAt: new Date(0),
    });
    await db.insert(member).values({
      id: "org:learner",
      organizationId: "org",
      userId: "learner",
      role: "member",
      createdAt: new Date(0),
    });
    await db.insert(scenarioAssignments).values({
      id: "assignment",
      organizationId: "org",
      scenarioId: "task",
      assignedBy: "learner",
      createdAt: 1,
    });
    await syncScenarioCourseCatalogSnapshot(db, {
      snapshot: snapshot(),
      sourceRevision: "course-revision",
      organizationId: "org",
      nowUnixMs: 1,
    });

    await expect(listMyAssignments({ userId: "learner" })).resolves.toEqual([
      expect.objectContaining({
        assignmentId: "assignment",
        scenarioTitle: "Apply theory",
        lecture: {
          courseId: "course",
          lectureId: "02-task",
          title: "Apply theory",
          state: "locked",
          blockedBy: {
            courseId: "course",
            lectureId: "01-theory",
            title: "Theory",
          },
          scope: "organization-private",
        },
        courseLocation: expect.objectContaining({
          courseId: "course",
          lectureId: "01-theory",
          scope: "organization-private",
        }),
      }),
    ]);
  });
});

function snapshot(): CourseCatalogSnapshotV2 {
  return {
    version: 2,
    courses: [
      {
        courseId: "course",
        title: "Course",
        summary: "Course summary",
        bodyMarkdown: "Course body",
        sequential: true,
        lectures: [
          lecture("01-theory", "Theory"),
          lecture("02-task", "Apply theory", "task"),
        ],
      },
    ],
  };
}

function lecture(
  lectureId: string,
  title: string,
  scenarioId?: string,
): CourseCatalogCourseV2["lectures"][number] {
  return {
    lectureId,
    title,
    summary: `${title} summary`,
    bodyMarkdown: `${title} body`,
    category: "test",
    tags: ["test"],
    difficulty: "easy",
    estimatedMinutes: 10,
    ...(scenarioId ? { scenarioId } : {}),
  };
}
