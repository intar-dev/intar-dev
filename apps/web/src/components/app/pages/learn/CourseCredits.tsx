import { ExternalLink } from "lucide-react";

export interface CourseCredit {
  label: string;
  url: string;
}

export function CourseCredits({
  credits,
}: {
  credits?: readonly CourseCredit[] | null | undefined;
}) {
  if (!credits?.length) return null;

  return (
    <p
      data-course-credits
      className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground"
    >
      <span className="font-medium text-foreground">Credits:</span>
      {credits.map((credit, index) => (
        <span
          key={`${credit.url}\u0000${credit.label}`}
          className="inline-flex items-center"
        >
          {index ? (
            <span aria-hidden className="mr-1.5 text-border">
              ·
            </span>
          ) : null}
          <a
            href={credit.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 font-medium text-brand-text underline underline-offset-4 transition-colors hover:text-brand-text/80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            {credit.label}
            <ExternalLink className="size-3 shrink-0" aria-hidden />
            <span className="sr-only"> (opens in a new tab)</span>
          </a>
        </span>
      ))}
    </p>
  );
}
