---
version: 1
slug: "pps-web-src-components-app-pages-learn-lecture-tsx"
primary_target: "apps/web/src/components/app/pages/learn/Lecture.tsx"
related_targets: ["apps/web/src/components/app/pages/learn/CourseCatalog.tsx","apps/web/src/components/app/run/RunLearningPanel.tsx","apps/web/src/components/app/run/RunRecap.tsx"]
---

## Scope and mode

The course catalog is an Operate surface. The lecture route is a Read surface with one clear transition into a scenario.

## Audience, job, and action

Learners need the technical model before they repair the linked system. They read the lecture, understand the current unit state, then start or resume the scenario. A theory-only lecture ends with one completion action.

## Direction

Keep the established Intar visual system. Use a narrow reading measure, visible course and unit context, and one action section after the Markdown body. Locked content never appears. Waiting, active, failed, and completed states use direct text as well as color.

## Direction contract

THESIS: One ordered reading path teaches the model before the scenario; it refuses a catalog of equal-weight scenario cards.

OWN-WORLD: Warm neutral ground, the existing Intar sidebar frame, quiet borders, direct status text, rust actions, and a narrow Markdown reading rail.

STORY: The learner sees the course position, reads the theory, understands the unit state, and then starts or completes one unit.

FIRST VIEWPORT: Course context and the lecture title lead. Metadata follows. Theory fills the narrow central rail. The primary scenario or completion action comes only after the body.

FORM: Reading rail with a trailing scenario gate; form 1 of 1; seed key `course-lecture-reading-first-v2`.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Constraints

The server owns access and sequence checks. The interface must work with keyboard and screen readers on mobile and desktop. Do not add a new visual identity, a hero, decorative cards, or an action above the theory.
