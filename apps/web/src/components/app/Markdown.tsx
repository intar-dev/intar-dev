import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AsyncLabel } from "@/components/app/patterns/AsyncLabel";
import { cn } from "@/lib/utils";

export function Markdown({
  children,
  className,
  headingOffset = 0,
  pageContent = false,
  textOnly = false,
}: {
  children: string;
  className?: string;
  /** Content pages already own an h1 in the app bar. */
  headingOffset?: 0 | 1;
  /** Keep authored h1 and h2 headings below the app bar's route h1. */
  pageContent?: boolean;
  /** User posts may contain text, links, and code, but no embedded media. */
  textOnly?: boolean;
}) {
  const Heading1 = pageContent ? "h2" : headingOffset ? "h2" : "h1";
  const Heading2 = pageContent ? "h2" : headingOffset ? "h3" : "h2";
  const Heading3 = pageContent ? "h3" : headingOffset ? "h4" : "h3";
  const Heading4 = pageContent ? "h4" : headingOffset ? "h5" : "h4";
  const listRhythm = pageContent
    ? "[&_li+li]:mt-[0.375em] [&_li>:is(ul,ol)]:mt-[0.375em]"
    : "space-y-2";
  const headingRest = cn(
    "text-balance",
    pageContent ? "font-semibold" : "text-label",
  );
  // Only reading text holds the measure; code blocks and tables use the
  // column's full width.
  return (
    <div
      className={cn(
        pageContent ? "prose-flow" : "space-y-4",
        className ??
          (pageContent
            ? "text-prose [&>:not([data-wide])]:prose-measure"
            : "text-support"),
      )}
    >
      <ReactMarkdown
        skipHtml={textOnly}
        disallowedElements={textOnly ? ["img"] : undefined}
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <Heading1
              className={cn(
                "text-balance",
                pageContent ? "text-prose-heading" : "text-card-title",
              )}
            >
              {children}
            </Heading1>
          ),
          h2: ({ children }) => (
            <Heading2
              className={cn(
                "text-balance",
                pageContent ? "text-prose-heading" : "text-card-title",
              )}
            >
              {children}
            </Heading2>
          ),
          h3: ({ children }) => (
            <Heading3
              className={cn(
                "text-balance",
                pageContent
                  ? "text-prose-subheading"
                  : "text-support font-semibold",
              )}
            >
              {children}
            </Heading3>
          ),
          h4: ({ children }) => (
            <Heading4 className={headingRest}>{children}</Heading4>
          ),
          h5: ({ children }) => (
            <Heading4 className={headingRest}>{children}</Heading4>
          ),
          h6: ({ children }) => (
            <Heading4 className={headingRest}>{children}</Heading4>
          ),
          p: ({ children }) => <p>{children}</p>,
          hr: () => <hr className={pageContent ? undefined : "my-4"} />,
          blockquote: ({ children }) => (
            <blockquote
              className={
                pageContent
                  ? "border-l border-border-strong pl-[1em] text-muted-foreground italic"
                  : "border-l border-border-strong pl-3 text-muted-foreground"
              }
            >
              {children}
            </blockquote>
          ),
          a: ({ children, ...props }) => (
            <a
              {...props}
              className="text-brand-text underline decoration-1 decoration-[color-mix(in_oklab,var(--brand-text)_35%,transparent)] underline-offset-[0.18em] transition-[text-decoration-color] duration-(--duration-fast) ease-standard hover:decoration-current"
              target={props.href?.startsWith("http") ? "_blank" : undefined}
              rel={props.href?.startsWith("http") ? "noreferrer" : undefined}
            >
              {children}
            </a>
          ),
          ul: ({ children }) => (
            <ul className={cn("list-disc pl-5 marker:text-faint-foreground", listRhythm)}>
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol
              className={cn(
                "list-decimal pl-5 marker:text-faint-foreground",
                !pageContent && "marker:font-medium",
                listRhythm,
              )}
            >
              {children}
            </ol>
          ),
          li: ({ children }) => (
            <li className={pageContent ? undefined : "pl-1"}>{children}</li>
          ),
          code: ({ children }) => (
            <code
              className={cn(
                "box-decoration-clone rounded-xs border border-border bg-muted px-[0.3125rem] py-px font-mono font-normal tracking-normal text-foreground",
                pageContent
                  ? "text-[0.8125em] max-sm:[overflow-wrap:anywhere] sm:whitespace-nowrap"
                  : "text-code",
              )}
            >
              {children}
            </code>
          ),
          pre: ({ node, children }) => (
            <CodeBlock language={fenceLanguage(node)}>{children}</CodeBlock>
          ),
          table: ({ children }) => (
            <TableScroller>
              <table className="w-full border-collapse text-left text-sm">
                {children}
              </table>
            </TableScroller>
          ),
          th: ({ children, style }) => (
            <th
              style={style}
              className="h-9 border-b px-3 text-left text-label whitespace-nowrap"
            >
              {children}
            </th>
          ),
          td: ({ children, style }) => (
            <td
              style={style}
              className="border-b px-3 py-2 align-top [tr:last-child>&]:border-b-0"
            >
              {children}
            </td>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

// Commands read as terminal material in both themes. Copy confirms in place:
// the icon swaps to a check and the label says so, then settles back.
function CodeBlock({
  children,
  language,
}: {
  children: ReactNode;
  language?: string | undefined;
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

  const copy = () => {
    const text = preRef.current?.textContent ?? "";
    const settle = (next: "copied" | "failed") => {
      setStatus(next);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setStatus("idle"), 1600);
    };
    if (!text || !navigator.clipboard) return settle("failed");
    navigator.clipboard.writeText(text.replace(/\n$/, "")).then(
      () => settle("copied"),
      () => settle("failed"),
    );
  };

  const copied = status === "copied";
  return (
    <div
      data-wide
      className="overflow-hidden rounded-lg border border-terminal-border bg-terminal-background selection:bg-terminal-brand/25 selection:text-terminal-foreground"
    >
      <div className="flex min-h-9 items-center justify-between gap-3 border-b border-terminal-border bg-terminal-surface pr-1.5 pl-4">
        {language ? (
          <span className="font-sans text-xs leading-none font-medium tracking-[0.01em] text-terminal-muted">
            {language}
          </span>
        ) : null}
        <button
          type="button"
          onClick={copy}
          aria-label="Copy code"
          className={cn(
            "ml-auto inline-flex h-7 items-center rounded-md px-2 text-xs font-medium transition-[color,background-color] duration-(--duration-fast) ease-standard hover:bg-white/8 focus-visible:outline-terminal-brand",
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

/** Lucide's copy with its front sheet grouped, so it can slide off its twin. */
function CopyIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-3.5 overflow-visible"
    >
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
      <rect data-copy-front width="14" height="14" x="8" y="8" rx="2" ry="2" />
    </svg>
  );
}

// The fence language from the code child's `language-xxx` class.
function fenceLanguage(node: {
  children?: readonly unknown[];
} | undefined): string | undefined {
  const code = node?.children?.[0] as
    | { type?: string; properties?: { className?: unknown } }
    | undefined;
  if (code?.type !== "element") return undefined;
  const names = code.properties?.className;
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    const match = /^language-(\S+)$/.exec(String(name ?? ""));
    if (match) return match[1];
  }
  return undefined;
}

/**
 * Sets --fade-end while more of a strip waits to the right, and reports
 * whether it overflows, so only a strip that scrolls takes a tab stop.
 */
function useScrollCue(ref: RefObject<HTMLElement | null>): boolean {
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

function TableScroller({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const overflowing = useScrollCue(ref);
  return (
    <div
      ref={ref}
      data-wide
      data-scroll-fade
      {...(overflowing
        ? { tabIndex: 0, role: "region", "aria-label": "Table" }
        : {})}
      className="overflow-x-auto rounded-xl border bg-card"
    >
      {children}
    </div>
  );
}