import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

export function Markdown({
  children,
  className,
  headingOffset = 0,
}: {
  children: string;
  className?: string;
  /** Content pages already own an h1 in the app bar. */
  headingOffset?: 0 | 1;
}) {
  const Heading1 = headingOffset ? "h2" : "h1";
  const Heading2 = headingOffset ? "h3" : "h2";
  const Heading3 = headingOffset ? "h4" : "h3";
  return (
    <div className={cn("space-y-4", className ?? "text-body")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <Heading1 className="text-section-title text-balance">
              {children}
            </Heading1>
          ),
          h2: ({ children }) => (
            <Heading2 className="text-card-title text-balance">
              {children}
            </Heading2>
          ),
          h3: ({ children }) => (
            <Heading3 className="text-base font-semibold text-balance">
              {children}
            </Heading3>
          ),
          p: ({ children }) => <p>{children}</p>,
          a: ({ children, ...props }) => (
            <a
              {...props}
              className="font-medium text-primary underline underline-offset-4"
              target={props.href?.startsWith("http") ? "_blank" : undefined}
              rel={props.href?.startsWith("http") ? "noreferrer" : undefined}
            >
              {children}
            </a>
          ),
          ul: ({ children }) => (
            <ul className="list-disc space-y-2 pl-5 marker:text-muted-foreground">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal space-y-2 pl-5 marker:font-medium marker:text-muted-foreground">
              {children}
            </ol>
          ),
          li: ({ children }) => <li className="pl-1">{children}</li>,
          code: ({ children }) => (
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[0.9em]">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-md border bg-muted/60 p-3 text-xs leading-6">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full border-collapse text-left text-sm">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b bg-muted/60 px-3 py-2 font-medium">
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
