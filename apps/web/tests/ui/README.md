# UI release gate

This suite is fully test-only. It installs one catch-all route for `/api/**`
and one WebSocket route before every navigation. Any API request without an
explicit fixture receives a deterministic `501` response and fails the test at
teardown. No fixture module is imported by `src/` or included in the production
bundle.

## Suites

Run from `apps/web`:

| Command | What it runs |
| --- | --- |
| `bun run test:ui` | Everything: the complete release gate, with one worker in CI |
| `bun run test:ui:visual` | The Chromium screenshot suites: every route in both themes on desktop and mobile (`routes.visual.spec.ts`), the dense routes on a tablet (`dense.visual.spec.ts`), and focused states (`states.visual.spec.ts`) |
| `bun run test:ui:a11y` | axe on every route in both themes and on the high-risk states, plus keyboard, focus, reduced-motion, coarse-pointer, overflow, 200%-text and terminal-cell behavior |
| `bun run test:ui:smoke` | The workflow checks in `smoke.spec.ts`, in Chromium, Firefox and WebKit. CI's `web-ui` job runs the Chromium ones (`cuenv task test-ui-smoke`) |
| `bun run test:ui:perf` | The performance checks |

Add `-- --list` to any of them to see the tests it would run, and
`-- <file>` or `-- -g <title>` to run some of them.

Install the browser revisions pinned by `@playwright/test` and `bun.lock` with:

```sh
bun run ui:install
```

## Updating visual baselines

Generate and commit visual baselines only on macOS. Do not generate or update
them in Linux containers, Linux CI jobs, or remote Linux runners. Browser and
font rasterization differ even when the browser revision is identical.

On a Mac, install the pinned browsers, regenerate the baselines, review every
changed image, and then commit the reviewed files:

```sh
bun run ui:install
bun run test:ui:visual:update
```

Linux CI may run non-visual smoke and accessibility checks, but it must not
rewrite or replace the committed macOS baseline images.

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
