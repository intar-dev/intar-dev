# UI release gate

This suite is fully test-only. It installs one catch-all route for `/api/**`
and one WebSocket route before every navigation. Any API request without an
explicit fixture receives a deterministic `501` response and fails the test at
teardown. No fixture module is imported by `src/` or included in the production
bundle.

## Suites

- `bun run test:ui:visual` runs the Chromium visual suites.
  - `routes.visual.spec.ts`: 24 routes × 2 themes × desktop/mobile = 96.
  - `dense.visual.spec.ts`: 10 dense routes × 2 themes × tablet = 20.
  - `states.visual.spec.ts`: 46 focused run, workshop, organization, build,
    people, and authoring snapshots.
  - The visual baseline count is therefore exactly 162.
- `bun run test:ui:a11y` runs 124 checks: axe on all 24 routes in both themes;
  high-risk empty, error, permission, dialog, operational-detail,
  remote-access, validation, and mobile-sheet states; and keyboard, focus,
  reduced-motion, coarse-pointer, overflow, 200%-text, and terminal-cell
  behavior.
- `bun run test:ui:smoke` runs 24 workflow archetypes in Chromium, Firefox,
  and WebKit, for 72 checks.
- `bun run test:ui` runs the complete 368-test release gate, including 10 VM
  lifecycle checks, with one worker in CI.

Install the browser revisions pinned by `@playwright/test` and `bun.lock` with:

```sh
bun run ui:install
```

## Updating visual baselines

Do not generate committed baselines on macOS and reuse them on Linux. Browser
and font rasterization differ even when the browser revision is identical.
Regenerate them in a Linux/amd64 GitHub Actions job using the same pinned
Playwright container as the `ui` job, upload `tests/ui/__screenshots__/` as an
artifact, review every changed image, and then commit the reviewed files. The
repository intentionally provides no local Docker runner or Docker build for
this operation.

The command intentionally fails on missing or changed baselines until the
reviewed images are committed. The CI UI job uploads
`.tmp/website-playwright/playwright-report/` and
`.tmp/website-playwright/test-results/` on failure so diffs can be inspected
without rerunning locally. Ephemeral output lives outside `apps/web/` so the
Astro development watcher cannot invalidate optimized dependencies mid-test.

Fixture time is fixed at `2026-07-10T09:00:00Z`. Animations, carets, terminal
cursors, API payloads, and WebSocket output are deterministic. Tests wait for a
visible page landmark and loaded fonts, never `networkidle`, because run and
operations pages poll by design.
