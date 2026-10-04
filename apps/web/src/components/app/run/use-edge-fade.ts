import { useEffect, type RefObject } from "react";

const FADE = "1.5rem";

/**
 * Sets --fade-start and --fade-end on a sideways-scrolling strip: 1.5rem at
 * whichever edge has more waiting, 0 where it is flush. The scroll-fade-x
 * utility turns them into a mask, so overflow shows before anyone swipes.
 */
export function useEdgeFade(ref: RefObject<HTMLElement | null>, deps: unknown[] = []) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const max = el.scrollWidth - el.clientWidth;
      el.style.setProperty("--fade-start", el.scrollLeft > 2 ? FADE : "0px");
      el.style.setProperty("--fade-end", el.scrollLeft < max - 2 ? FADE : "0px");
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    observer?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      observer?.disconnect();
    };
    // `deps` re-measures when the strip's content changes.
  }, [ref, ...deps]);
}
