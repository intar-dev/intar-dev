import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { WorkshopSlide } from "./types";
import { cn } from "@/lib/utils";

export function WorkshopSlideFrame({
  slide,
  projector = false,
}: {
  slide: WorkshopSlide;
  projector?: boolean;
}) {
  const titleId = `workshop-slide-${slide.id}`;

  return (
    <article
      aria-labelledby={slide.title ? titleId : undefined}
      aria-label={slide.title ? undefined : `Slide ${slide.ordinal + 1}`}
      data-layout={slide.layout}
      className={cn(
        "relative isolate flex aspect-video w-full min-w-0 flex-col overflow-hidden rounded-xl border border-terminal-border bg-terminal-background text-terminal-foreground shadow-sm max-sm:aspect-auto max-sm:min-h-[min(30rem,calc(100dvh-8rem))] max-sm:max-h-none max-sm:overflow-visible [@media(max-height:40rem)]:aspect-auto [@media(max-height:40rem)]:min-h-[min(20rem,calc(100dvh-6rem))] [@media(max-height:40rem)]:max-h-none [@media(max-height:40rem)]:overflow-visible",
        projector
          ? "max-h-[calc(100dvh-13rem)] p-8 sm:p-12 lg:p-16"
          : "max-h-[calc(100dvh-10rem)] p-6 sm:p-10 lg:p-12",
      )}
    >
      <div
        aria-hidden="true"
        className="absolute top-0 right-0 h-px w-1/3 bg-terminal-brand"
      />
      <div
        className={cn(
          "relative flex h-full min-h-0 flex-col",
          slide.layout === "title" &&
            "justify-start sm:justify-end sm:pb-[8%] [@media(max-height:40rem)]:justify-start [@media(max-height:40rem)]:pb-0",
          slide.layout === "break" &&
            "justify-start sm:justify-center [@media(max-height:40rem)]:justify-start",
          slide.layout !== "title" &&
            slide.layout !== "break" &&
            "justify-start gap-6 sm:justify-between sm:gap-0 [@media(max-height:40rem)]:justify-start [@media(max-height:40rem)]:gap-6",
        )}
      >
        {slide.title ? (
          <header className="max-w-[88%]">
            <p className="mb-3 font-mono text-xs tracking-[0.16em] text-terminal-brand uppercase">
              intar workshop · {String(slide.ordinal + 1).padStart(2, "0")}
            </p>
            <h2
              id={titleId}
              className={cn(
                "font-heading font-bold text-balance",
                slide.layout === "title"
                  ? "text-3xl leading-[1.04] tracking-[-0.04em] sm:text-5xl lg:text-6xl"
                  : "text-2xl leading-tight tracking-[-0.025em] sm:text-3xl lg:text-4xl",
              )}
            >
              {slide.title}
            </h2>
          </header>
        ) : null}
        {slide.bodyMarkdown ? (
          <WorkshopSlideMarkdown
            markdown={slide.bodyMarkdown}
            compact={slide.layout === "title" || slide.layout === "break"}
            className={cn(
              slide.title && slide.layout !== "title" && "mt-6",
              slide.layout === "quote" && "max-w-4xl self-center",
            )}
          />
        ) : null}
        {slide.moduleId ? (
          <p className="mt-auto pt-6 font-mono text-xs text-terminal-muted">
            Module {slide.moduleId}
          </p>
        ) : null}
      </div>
    </article>
  );
}

export function WorkshopSlideMarkdown({
  markdown,
  compact = false,
  className,
}: {
  markdown: string;
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "min-h-0 max-w-[74ch] overflow-auto text-terminal-foreground max-sm:overflow-visible [@media(max-height:40rem)]:overflow-visible",
        compact
          ? "text-base leading-relaxed sm:text-lg lg:text-xl"
          : "text-base leading-relaxed lg:text-lg",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={workshopMarkdownUrlTransform}
        components={{
          h1: ({ children }) => (
            <h3 className="mb-4 font-heading text-2xl font-semibold">
              {children}
            </h3>
          ),
          h2: ({ children }) => (
            <h3 className="mb-3 font-heading text-xl font-semibold">
              {children}
            </h3>
          ),
          h3: ({ children }) => (
            <h3 className="mb-2 font-heading text-lg font-semibold">
              {children}
            </h3>
          ),
          p: ({ children }) => <p className="mb-3 last:mb-0">{children}</p>,
          ul: ({ children }) => (
            <ul className="mb-3 list-disc space-y-2 pl-6 marker:text-terminal-brand">
              {children}
            </ul>
          ),
          ol: ({ children }) => (
            <ol className="mb-3 list-decimal space-y-2 pl-6 marker:text-terminal-brand">
              {children}
            </ol>
          ),
          blockquote: ({ children }) => (
            <blockquote className="my-4 border-y border-terminal-border py-4 font-heading text-xl leading-snug text-terminal-brand sm:text-2xl">
              {children}
            </blockquote>
          ),
          code: ({ children }) => (
            <code className="rounded bg-terminal-surface px-1.5 py-0.5 font-mono text-[0.9em] text-terminal-brand">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="my-3 max-h-56 overflow-auto rounded-lg border border-terminal-border bg-terminal-surface p-3 font-mono text-xs leading-6">
              {children}
            </pre>
          ),
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-terminal-brand underline underline-offset-4"
            >
              {children}
            </a>
          ),
          img: ({ alt, src }) => (
            <img
              src={src}
              alt={alt ?? ""}
              className="max-h-[45vh] max-w-full rounded-lg object-contain"
            />
          ),
          table: ({ children }) => (
            <div className="my-3 overflow-auto rounded-lg border border-terminal-border">
              <table className="w-full border-collapse text-left text-sm">
                {children}
              </table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b border-terminal-border bg-terminal-surface px-3 py-2 font-semibold">
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="border-b border-terminal-border px-3 py-2">
              {children}
            </td>
          ),
        }}
      >
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

function workshopMarkdownUrlTransform(url: string): string {
  if (
    url.length <= 256_000 &&
    /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/.test(url)
  ) {
    return url;
  }
  return defaultUrlTransform(url);
}
