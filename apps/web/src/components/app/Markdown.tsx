import { useRef, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { CodeBlock, useScrollCue } from "@/components/app/patterns/CodeBlock";
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