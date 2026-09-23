import { useEffect, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "lucide-react";
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
  return (
    <div className={cn("space-y-4", className ?? "text-body")}>
      <ReactMarkdown
        skipHtml={textOnly}
        disallowedElements={textOnly ? ["img"] : undefined}
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <Heading1
              className={cn(
                "text-balance",
                pageContent
                  ? "pt-5 text-[1.25rem] leading-snug font-semibold tracking-[-0.015em]"
                  : "text-section-title",
              )}
            >
              {children}
            </Heading1>
          ),
          h2: ({ children }) => (
            <Heading2
              className={cn(
                "text-balance",
                pageContent
                  ? "pt-5 text-[1.25rem] leading-snug font-semibold tracking-[-0.015em]"
                  : "text-card-title",
              )}
            >
              {children}
            </Heading2>
          ),
          h3: ({ children }) => (
            <Heading3
              className={cn(
                "text-base font-semibold text-balance",
                pageContent && "pt-3",
              )}
            >
              {children}
            </Heading3>
          ),
          p: ({ children }) => <p>{children}</p>,
          a: ({ children, ...props }) => (
            <a
              {...props}
              className="font-medium text-brand-text underline decoration-brand-border underline-offset-4 transition-colors duration-150 hover:decoration-current"
              target={props.href?.startsWith("http") ? "_blank" : undefined}
              rel={props.href?.startsWith("http") ? "noreferrer" : undefined}
            >
              {children}
            </a>
          ),
          ul: ({ children }) => (
            <ul className="list-disc space-y-2 pl-5 marker:text-faint-foreground">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal space-y-2 pl-5 marker:font-medium marker:text-faint-foreground">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="pl-1">{children}</li>,
          code: ({ children }) => (
            <code className="box-decoration-clone rounded-[0.3125rem] border border-border bg-muted px-1.5 py-px font-mono text-[0.85em] text-foreground">
              {children}
            </code>
          ),
          pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
          table: ({ children }) => (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full border-collapse text-left text-sm">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b bg-muted/60 px-3 py-2 text-xs font-medium text-faint-foreground">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b px-3 py-2 align-top last:border-b-0">
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
function CodeBlock({ children }: { children: ReactNode }) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    const text = preRef.current?.textContent ?? "";
    if (!text || !navigator.clipboard) return;
    navigator.clipboard.writeText(text.replace(/\n$/, "")).then(
      () => setCopied(true),
      () => {
        // Clipboard access can be denied; the block stays selectable.
      },
    );
  };

  return (
    <div className="group/code relative">
      <pre
        ref={preRef}
        className="overflow-x-auto rounded-lg border border-terminal-border bg-terminal-background py-3 pr-20 pl-4 text-[0.8125rem] leading-6 text-terminal-foreground [&_code]:border-0 [&_code]:bg-transparent [&_code]:p-0 [&_code]:text-[1em] [&_code]:text-inherit"
      >
        {children}
      </pre>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy code"}
        className={cn(
          "absolute top-1.5 right-1.5 inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-[color,background-color,opacity] duration-150 ease-standard hover:bg-white/8 focus-visible:opacity-100 sm:opacity-0 sm:group-hover/code:opacity-100 [@media(pointer:coarse)]:opacity-100",
          copied
            ? "text-terminal-success sm:opacity-100"
            : "text-terminal-muted hover:text-terminal-foreground",
        )}
      >
        {copied ? (
          <Check className="size-3.5 motion-safe:animate-pop" aria-hidden="true" />
        ) : (
          <Copy className="size-3.5" aria-hidden="true" />
        )}
        <span aria-hidden="true">{copied ? "Copied" : "Copy"}</span>
      </button>
    </div>
  );
}
