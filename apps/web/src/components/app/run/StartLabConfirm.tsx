import type { ReactNode } from "react";
import { ArrowRight } from "lucide-react";
import { Markdown } from "@/components/app/Markdown";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { Button } from "@/components/ui/button";

/**
 * The explicit Start lab step shared by /play and /runs/start: a run starts
 * only from this button, never from a page load.
 */
export function StartLabConfirm({
  title,
  meta,
  briefingMarkdown,
  pending,
  error,
  onStart,
  headingLevel = "h2",
}: {
  title: string;
  meta?: ReactNode;
  briefingMarkdown?: string | null;
  pending: boolean;
  error: string | null;
  onStart: () => void;
  headingLevel?: "h1" | "h2";
}) {
  const Heading = headingLevel;
  return (
    <section
      aria-labelledby="start-lab-heading"
      className="mx-auto flex w-full max-w-2xl flex-col gap-5"
    >
      <div className="space-y-2">
        <Heading id="start-lab-heading" className="text-page-title text-balance">
          {title}
        </Heading>
        {meta}
      </div>
      {briefingMarkdown ? (
        <Markdown headingOffset={1}>{briefingMarkdown}</Markdown>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <Button
          size="lg"
          className="w-full sm:w-auto"
          onClick={onStart}
          disabled={pending}
        >
          {pending ? "Starting…" : "Start lab"}
          {!pending ? <ArrowRight className="size-4" /> : null}
        </Button>
        <p className="text-caption text-muted-foreground">
          Starts a practice machine for up to an hour.
        </p>
      </div>
      {error ? <InlineFeedback tone="error">{error}</InlineFeedback> : null}
    </section>
  );
}
