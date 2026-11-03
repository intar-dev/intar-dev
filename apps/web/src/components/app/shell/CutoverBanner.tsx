import { TriangleAlert } from "lucide-react";

// The scenario data cutover (intar-dev/intar-dev#300). A slipped window moves
// this date; the cutover PR removes the banner.
export const CUTOVER_DATE = "2026-11-17";

const cutoverDay = new Intl.DateTimeFormat("en-US", {
  dateStyle: "long",
  timeZone: "UTC",
}).format(new Date(`${CUTOVER_DATE}T00:00:00Z`));

// snap-start keeps the banner reachable on the landing page, whose html
// scroll snaps to its own screens and would otherwise scroll past it.
export function CutoverBanner() {
  return (
    <div
      role="status"
      className="flex snap-start items-start gap-2 border-b border-warning-border bg-warning-subtle pt-[max(0.5rem,env(safe-area-inset-top))] pr-[max(var(--page-inset),env(safe-area-inset-right))] pb-2 pl-[max(var(--page-inset),env(safe-area-inset-left))] text-support text-foreground"
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
      <p>
        <strong className="font-semibold">
          Scenario data cutover on <time dateTime={CUTOVER_DATE}>{cutoverDay}</time>.
        </strong>{" "}
        All lab runs, recordings, shares, course progress and assignments will
        be deleted that day. Your account, organizations and servers stay.
      </p>
    </div>
  );
}
