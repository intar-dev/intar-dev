import { CheckCircle2, CircleAlert, LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export type FeedbackTone = "pending" | "success" | "error";

export function InlineFeedback({
  tone,
  children,
  className,
  announce = true,
  id,
}: {
  tone: FeedbackTone;
  children: React.ReactNode;
  className?: string;
  /** False when a live region that is always mounted already announces it. */
  announce?: boolean;
  /** For aria-describedby when the message refuses a single field's value. */
  id?: string;
}) {
  const Icon =
    tone === "pending"
      ? LoaderCircle
      : tone === "success"
        ? CheckCircle2
        : CircleAlert;

  return (
    <p
      id={id}
      // A swapped tone or text remounts the line, so the new message rolls in
      // again; a message that is already there never plays on load.
      key={`${tone}:${typeof children === "string" ? children : ""}`}
      role={announce ? (tone === "error" ? "alert" : "status") : undefined}
      aria-live={announce ? (tone === "error" ? "assertive" : "polite") : undefined}
      className={cn(
        "roll-in flex min-h-6 items-start gap-2 py-0.5 text-support leading-5",
        tone === "pending" && "text-muted-foreground",
        tone === "success" && "text-success",
        tone === "error" && "text-destructive",
        className,
      )}
    >
      <Icon
        className={cn(
          "mt-0.5 size-4 shrink-0",
          tone === "pending" && "motion-safe:animate-spin",
        )}
        aria-hidden="true"
      />
      <span>{children}</span>
    </p>
  );
}
