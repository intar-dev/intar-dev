# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

- Learners study systems theory and then apply it in isolated repair scenarios.
- Organization instructors assign course work and review learner progress.
- Administrators publish, inspect, and prove course scenarios without weakening learner access rules.

## Product Purpose

Intar teaches practical systems operation through courses that pair written lectures with runnable repair scenarios. A successful course gives the learner the theory first, a safe system in which to apply it, and clear proof that the repair is complete.

## Positioning

Course content and runnable infrastructure form one ordered learning unit. The lecture explains the model, and the linked scenario proves that the learner can apply it in a real system.

## Operating Context

- Learners use public or organization-scoped courses in the web app.
- Course authors keep Markdown lectures and optional HCL scenarios together in a version-controlled repository.
- The CLI validates and publishes a complete course catalog. The runtime builds and starts only the linked technical scenario content.
- Scenario runs can include terminals, checks, hints, solutions, saved replays, and course progress.

## Capabilities and Constraints

- A course contains ordered lecture units. A lecture can link to one scenario or stand alone.
- Strict courses require each unit to be complete before the next lecture opens.
- A theory-only unit completes through an explicit learner action. A linked unit completes only after a successful finished scenario run.
- Lecture text updates do not rebuild VM images and do not reset stable learner progress.
- Standalone learner scenarios and browser HCL authoring are not supported.
- Administrators can bypass course order for proof, but cannot bypass access, membership, readiness, capacity, or host rules.

## Brand Commitments

- Preserve the current Intar visual system and direct product language.
- Use the terms course, lecture, scenario, run, check, hint, and solution consistently.
- Keep required source credit and license links visible in course content.

## Evidence on Hand

- The repository contains the production course catalog, scenario runtime, progress model, organization flows, and learner UI.
- The companion scenarios repository contains two current courses and twelve runnable scenarios.
- Existing UI tests cover desktop, mobile, accessibility, and learner interactions.

## Product Principles

- Teach the model before asking for the repair.
- Make course order clear and enforce it on the server.
- Keep content changes independent from VM image builds.
- Preserve scenario IDs and successful learner history across publication changes.
- Treat build acceptance as pending work until the scenario is runnable and proven.

## Accessibility & Inclusion

- Keep keyboard operation, visible focus, semantic headings, non-color status labels, responsive reading width, and screen-reader feedback for locked, waiting, error, and completed states.
