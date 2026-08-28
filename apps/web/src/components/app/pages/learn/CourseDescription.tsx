import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

export function CourseDescription({
  children,
  className,
  links = true,
}: {
  children: string;
  className?: string;
  links?: boolean;
}) {
  return (
    <span className={cn(className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        allowedElements={["p", "a", "strong", "em", "del", "code", "br"]}
        unwrapDisallowed
        components={{
          p: ({ children: content }) => <>{content}</>,
          a: ({ children: content, ...props }) =>
            links ? (
              <a
                {...props}
                className="font-medium text-primary underline underline-offset-4"
                target={props.href?.startsWith("http") ? "_blank" : undefined}
                rel={props.href?.startsWith("http") ? "noreferrer" : undefined}
              >
                {content}
              </a>
            ) : (
              <>{content}</>
            ),
          code: ({ children: content }) => (
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">
              {content}
            </code>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </span>
  );
}
