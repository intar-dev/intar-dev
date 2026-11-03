import { TriangleAlert } from "lucide-react";

// The scenario data cutover (intar-dev/intar-dev#300). The cutover PR removes
// the banner.
//
// A labelled region, not a status: it is on the page from load, and pages keep
// role="status" for their own feedback. snap-start keeps it reachable on the
// landing page, whose html scroll snaps to its own screens.
export function CutoverBanner() {
  return (
    <section
      aria-label="Cutover notice"
      className="flex snap-start items-start gap-2 border-b border-warning-border bg-warning-subtle pt-[max(0.5rem,env(safe-area-inset-top))] pr-[max(var(--page-inset),env(safe-area-inset-right))] pb-2 pl-[max(var(--page-inset),env(safe-area-inset-left))] text-support text-foreground"
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
      <p>
        <strong className="font-semibold">
          A big cutover is coming in the next two weeks, and scenario data will
          be lost.
        </strong>{" "}
        Lab runs, recordings, shares, course progress and assignments will be
        deleted. Your account, organizations and servers stay.
      </p>
    </section>
  );
}
