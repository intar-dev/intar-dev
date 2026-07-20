import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

export function BrandMark({
  className,
  compact = false,
  to = "/",
}: {
  className?: string;
  compact?: boolean;
  to?: "/" | "/courses";
}) {
  return (
    <Link
      to={to}
      aria-label="intar.dev home"
      className={cn(
        "inline-flex min-h-11 items-center gap-2.5 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
        className,
      )}
    >
      <img src="/favicon.svg" alt="" className="size-8 shrink-0" />
      {!compact ? (
        <span className="font-heading text-lg font-bold tracking-[-0.03em]">
          intar<span className="text-brand-text">.dev</span>
        </span>
      ) : null}
    </Link>
  );
}
