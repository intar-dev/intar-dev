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
      <img src="/favicon.svg" alt="" className="size-7 shrink-0" />
      {!compact ? (
        <span className="text-[0.9375rem] leading-none font-semibold tracking-[-0.015em]">
          intar<span className="text-brand-text">.dev</span>
        </span>
      ) : null}
    </>
  );
  const linkClassName = cn(
    "inline-flex min-h-11 items-center gap-2.5 rounded-lg",
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
