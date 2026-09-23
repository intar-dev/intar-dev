---
version: 1
slug: "rc-components-app-pages-learn-resourcecapacity-tsx"
primary_target: "apps/web/src/components/app/pages/learn/ResourceCapacity.tsx"
related_targets:
  - "apps/web/src/components/app/pages/learn/CourseCatalog.tsx"
---

## Scope and mode

Operate. Public and organization course catalog indexes show combined allocation capacity across platform hosts, the user's personal hosts, and hosts in the user's organizations. Host health, readiness, and reservations determine available capacity. Catalog totals are independent of the placement preference for a new run. This is an ordinary extension of the existing system in `apps/web/DESIGN.md`, with product context from `apps/web/PRODUCT.md`. No new visual system or world was created. `DESIGN.md` remains unchanged.

## Direction contract

THESIS: Two continuous meters make remaining CPU and memory capacity visible before a learner chooses a course.

OWN-WORLD: Geist, raised graphite or paper cards, neutral tracks, a success-green fill, and direct labels.

STORY: Read the available shares and amounts, then continue to assignments or courses.

FIRST VIEWPORT: A compact “Available for new runs” area follows the catalog heading. CPU and memory sit side by side on desktop and stack on mobile. Each meter is one rounded fill that eases in on arrival and follows value changes with a 500 ms transition; reduced motion disables both. Course actions remain unchanged.

FORM: Paired continuous meters; form 1 of 1; seed key `catalog-resource-capacity-v2` (design refresh of v1 segmented scales). Code-led extension approved by the user.

FINISH: Visual review complete. Reviewer disposition: ship. All eight review screenshots are valid; no material fixes are required. Final built behavior is recorded below.

## Built appearance and layout

- The capacity section follows the catalog heading and summary, before assignments, filters, and course rows. It stays visible in empty and filtered catalog states. Course detail pages have no capacity meters.
- The heading uses the card-title style. CPU and memory each sit in a raised card (`card` fill, quiet border, highlight and raised shadow, 12px corners) with 16px by 18px padding.
- Labels use Geist at 14px, medium. The available percentage uses the success color at 14px, medium. Amounts use the caption style at 12px in faint-foreground. Numbers use tabular figures.
- CPU and memory stack with a 12px gap below the 640px breakpoint and use two equal columns with a 12px gap at 640px and above.
- Each meter is a 6px rounded track (`muted`, `accent` in dark mode) with one rounded success fill scaled to the exact available share. The fill grows from zero on arrival and eases value changes over 500ms with the enter curve; reduced motion removes both.

## Built behavior

- The design refresh replaced the approved 20-segment bars with one continuous fill; the exact share and wording are unchanged. Each meter shows the available percentage and the available / total amount. CPU uses vCPUs (millicores divided by 1000); memory uses GiB (MiB divided by 1024). Percentages have at most one decimal place; amounts have at most three.
- Available values are clamped between zero and total. A nonpositive total gives a zero fill. Missing capacity shows “Capacity unavailable” without invented values. Zero capacity remains a numeric state.
- The catalog query supplies both courses and capacity. Visible index pages refresh every 15 seconds; course detail pages have no interval refresh. Query stale time is 10 seconds.
- A refresh failure with cached index data retains the latest courses and capacity. The section shows “Update failed · Showing last values”; when capacity is missing, it shows “Update failed · Try again shortly”. A successful refresh replaces the values and clears the warning.
- A first-load failure shows the existing course error state and retry action. Initial loading includes two capacity skeletons with the same responsive column layout.
- Access errors (401, 403, and 404) show the course error state, stop interval polling and automatic retries, and clear prior cached courses and capacity. A later failed retry cannot restore those values. A successful retry restores current data. Other errors use the existing bounded retry policy.
- The section has a labelled heading. Each meter exposes its label, minimum, maximum, current percentage, and a text value with percentage and units. The decorative fill is hidden from screen readers. Update failure text uses a status role.

## Validation record

Results supplied by the completed review and test runs; source behavior checked during this documentation pass.

| Check | Result |
| --- | --- |
| Visual review | Ship. All eight screenshots valid. Fonts, material, page ground, placement, and responsive values match the existing system. No material fixes. |
| Mechanical detector | `[]` (no findings). |
| Focused UI checks | 19 passed in the earlier focused run. |
| Resource Playwright tests | All 6 passed, including the 200 → 403 → 503 → 200 cache removal and restoration regression. |
| Production build | Passed after the final access cache fix, including Cloudflare type checks and Astro checks. |
| Code review | Access cache issue resolved. Cache clearing occurs before the failed request is rethrown; cancelled requests cannot clear newer values. No further actionable findings. |

Review screenshots are in `apps/web/.impeccable/review/`:

- `capacity-public-light-desktop.png`
- `capacity-public-light-mobile.png`
- `capacity-public-dark-desktop.png`
- `capacity-public-dark-mobile.png`
- `capacity-organization-light-desktop.png`
- `capacity-organization-light-mobile.png`
- `capacity-organization-dark-desktop.png`
- `capacity-organization-dark-mobile.png`

The access cache fix has no visual changes. No product raster assets, dependencies, or database migrations were added. Review screenshots are validation evidence, not product assets. These component details remain local to this surface; they do not add global design rules.
