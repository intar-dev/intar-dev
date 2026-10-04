import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "@/lib/utils";
import { AsyncLabel } from "./AsyncLabel";
import { CopyIcon } from "./CopyIcon";

const COPIED_MS = 1600;

/**
 * Commands and Markdown code on the always-dark terminal surface, the same in
 * both themes: a header bar with the language and an in-bar Copy that swaps to
 * a drawn check and "Copied" for duration-flash. Long lines scroll sideways
 * with an edge fade and never wrap; a strip that scrolls takes a tab stop.
 * A polite status line reports the copy for assistive technology.
 */
export function CodeBlock({
  children,
  language,
  copyName = "Copy code",
  copyDisabled = false,
  onCopied,
  onCopyError,
  className,
}: {
  children: ReactNode;
  language?: string | undefined;
  /** The copy button's accessible name, e.g. "Copy the SSH command". */
  copyName?: string;
  /** Blocks copying on purpose, e.g. until a key has been downloaded. */
  copyDisabled?: boolean;
  onCopied?: () => void;
  onCopyError?: (error: unknown) => void;
  className?: string;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const timer = useRef<number | null>(null);
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const overflowing = useScrollCue(preRef);

  useEffect(
    () => () => {
      if (timer.current) window.clearTimeout(timer.current);
    },
    [],
  );

  const copy = async () => {
    const text = (preRef.current?.textContent ?? "").replace(/\n$/, "");
    const settle = (next: "copied" | "failed") => {
      setStatus(next);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setStatus("idle"), COPIED_MS);
    };
    try {
      if (!text || !navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      settle("copied");
      onCopied?.();
    } catch (error) {
      settle("failed");
      onCopyError?.(error);
    }
  };

  const copied = status === "copied";
  return (
    <div
      data-wide
      className={cn(
        "overflow-hidden rounded-lg border border-terminal-border bg-terminal-background selection:bg-terminal-brand/25 selection:text-terminal-foreground",
        className,
      )}
    >
      <div className="flex min-h-9 items-center justify-between gap-3 border-b border-terminal-border bg-terminal-surface pr-1.5 pl-4">
        {language ? (
          <span className="font-sans text-xs leading-none font-medium tracking-[0.01em] text-terminal-muted">
            {language}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => void copy()}
          disabled={copyDisabled}
          aria-label={copyName}
          className={cn(
            "ml-auto inline-flex h-7 items-center rounded-md px-2 text-xs font-medium transition-[color,background-color] duration-(--duration-fast) ease-standard hover:bg-white/8 focus-visible:outline-terminal-brand disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent",
            copied
              ? "text-terminal-success"
              : "text-terminal-muted hover:text-terminal-foreground",
          )}
        >
          <span aria-hidden="true">
            <AsyncLabel
              state={copied ? "done" : "idle"}
              idle={
                <>
                  <CopyIcon />
                  Copy
                </>
              }
              pending={null}
              done="Copied"
            />
          </span>
        </button>
        <span role="status" className="sr-only">
          {copied ? "Code copied." : status === "failed" ? "Could not copy." : ""}
        </span>
      </div>
      <pre
        ref={preRef}
        data-scroll-fade
        {...(overflowing
          ? { tabIndex: 0, role: "region", "aria-label": "Code" }
          : {})}
        className="m-0 overflow-x-auto px-4 py-3 text-[0.8125rem] leading-6 text-terminal-foreground focus-visible:outline-terminal-brand focus-visible:-outline-offset-2 [&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[1em] [&_code]:whitespace-pre [&_code]:text-inherit"
      >
        {children}
      </pre>
    </div>
  );
}

/**
 * Sets --fade-end while more of a strip waits to the right, and reports
 * whether it overflows, so only a strip that scrolls takes a tab stop.
 */
export function useScrollCue(ref: RefObject<HTMLElement | null>): boolean {
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const cue = () => {
      const over =
        el.scrollWidth > el.clientWidth + 1 ||
        el.scrollHeight > el.clientHeight + 1;
      const more = el.scrollLeft < el.scrollWidth - el.clientWidth - 2;
      el.style.setProperty("--fade-end", more ? "2rem" : "0px");
      setOverflowing(over);
    };
    cue();
    el.addEventListener("scroll", cue, { passive: true });
    if (typeof ResizeObserver === "undefined") {
      return () => el.removeEventListener("scroll", cue);
    }
    const observer = new ResizeObserver(cue);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", cue);
      observer.disconnect();
    };
  }, [ref]);
  return overflowing;
}
