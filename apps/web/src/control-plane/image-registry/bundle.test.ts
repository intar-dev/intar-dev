import { describe, expect, it, vi } from "vitest";
import { normalizeCourseCatalogSnapshot } from "./bundle";

vi.mock("cloudflare:workers", () => ({ env: {} }));

describe("course catalog snapshots", () => {
  it("normalizes ordered version-two snapshots", () => {
    expect(
      normalizeCourseCatalogSnapshot({
            version: 2,
            courses: [
              {
                course_id: "linux-operations",
                title: " Linux operations ",
                summary: " Diagnose common Linux failures. ",
                body_markdown: "\n# Linux operations\n",
                sequential: true,
                lectures: [
                  {
                    lecture_id: "01-broken-nginx",
                    title: " Repair nginx ",
                    summary: " Learn the nginx recovery loop. ",
                    body_markdown: "\n# Repair nginx\n",
                    category: " linux ",
                    tags: ["nginx", "service"],
                    difficulty: "easy",
                    estimated_minutes: 15,
                    scenario_id: "broken-nginx",
                  },
                  {
                    lecture_id: "02-theory",
                    title: " Theory only ",
                    summary: " Learn the model first. ",
                    body_markdown: "# Theory\n",
                    category: "linux",
                    tags: ["theory"],
                    estimated_minutes: 5,
                  },
                ],
              },
            ],
      }),
    ).toEqual({
      version: 2,
      courses: [
        {
          courseId: "linux-operations",
          title: "Linux operations",
          summary: "Diagnose common Linux failures.",
          bodyMarkdown: "\n# Linux operations\n",
          sequential: true,
          lectures: [
            {
              lectureId: "01-broken-nginx",
              title: "Repair nginx",
              summary: "Learn the nginx recovery loop.",
              bodyMarkdown: "\n# Repair nginx\n",
              category: "linux",
              tags: ["nginx", "service"],
              difficulty: "easy",
              estimatedMinutes: 15,
              scenarioId: "broken-nginx",
            },
            {
              lectureId: "02-theory",
              title: "Theory only",
              summary: "Learn the model first.",
              bodyMarkdown: "# Theory\n",
              category: "linux",
              tags: ["theory"],
              estimatedMinutes: 5,
            },
          ],
        },
      ],
    });
  });

  it("rejects V1, unknown fields, bad values, and duplicate IDs", () => {
    const invalidSnapshots: unknown[] = [
      { version: 1, courses: [courseMeta()] },
      { version: 2, courses: [], extra: true },
      {
        version: 2,
        courses: [courseMeta({ course_id: "../unsafe" })],
      },
      {
        version: 2,
        courses: [courseMeta({ course_id: " linux-operations " })],
      },
      {
        version: 2,
        courses: [courseMeta({ body_markdown: " " })],
      },
      {
        version: 2,
        courses: [courseMeta({ sequential: "true" })],
      },
      {
        version: 2,
        courses: [courseMeta({ lectures: [] })],
      },
      {
        version: 2,
        courses: [courseMeta({ lectures: [lectureMeta({ tags: [] })] })],
      },
      {
        version: 2,
        courses: [
          courseMeta({
            lectures: [lectureMeta({ tags: ["nginx", " nginx "] })],
          }),
        ],
      },
      {
        version: 2,
        courses: [
          courseMeta({ lectures: [lectureMeta({ estimated_minutes: 0 })] }),
        ],
      },
      {
        version: 2,
        courses: [
          courseMeta({ lectures: [lectureMeta({ difficulty: undefined })] }),
        ],
      },
      {
        version: 2,
        courses: [courseMeta({ lectures: [lectureMeta(), lectureMeta()] })],
      },
      {
        version: 2,
        courses: [courseMeta(), courseMeta()],
      },
      {
        version: 2,
        courses: [
          courseMeta(),
          courseMeta({
            course_id: "second-course",
            lectures: [lectureMeta({ lecture_id: "01-other" })],
          }),
        ],
      },
      {
        version: 2,
        courses: [courseMeta({ lectures: [lectureMeta({ extra: true })] })],
      },
    ];

    for (const courseCatalog of invalidSnapshots) {
      expect(normalizeCourseCatalogSnapshot(courseCatalog)).toBeNull();
    }
  });
});

function courseMeta(extra: Record<string, unknown> = {}) {
  return {
    course_id: "linux-operations",
    title: "Linux operations",
    summary: "Diagnose common Linux failures.",
    body_markdown: "# Linux operations\n",
    sequential: true,
    lectures: [lectureMeta()],
    ...extra,
  };
}

function lectureMeta(extra: Record<string, unknown> = {}) {
  return {
    lecture_id: "01-broken-nginx",
    title: "Repair nginx",
    summary: "Learn the nginx recovery loop.",
    body_markdown: "# Repair nginx\n",
    category: "linux",
    tags: ["nginx"],
    difficulty: "easy",
    estimated_minutes: 15,
    scenario_id: "broken-nginx",
    ...extra,
  };
}
