import { Link } from "@tanstack/react-router";
import { cn } from "@/lib/utils";

export function BrandMark({
  className,
  compact = false,
  to = "/",
  native = false,
}: {
  className?: string;
  compact?: boolean;
  to?: "/" | "/courses";
  native?: boolean;
}) {
  const content = (
    <>
      <img src="/favicon.svg" alt="" className="size-8 shrink-0" />
      {!compact ? (
        <span className="text-card-title">
          intar<span className="text-brand-text">.dev</span>
        </span>
      ) : null}
    </>
  );
  const linkClassName = cn(
    "inline-flex min-h-11 items-center gap-2.5 rounded-lg focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
    className,
  );

  return native ? (
    <a href={to} aria-label="intar.dev home" className={linkClassName}>
      {content}
    </a>
  ) : (
    <Link to={to} aria-label="intar.dev home" className={linkClassName}>
      {content}
    </Link>
  );
}
