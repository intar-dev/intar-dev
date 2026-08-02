import { formatRelativeTime, formatTimestamp } from "../lib/format";

// Relative wording with the absolute moment on hover — the inverse affordance
// (absolute text, relative title) belongs to timeline entries.
export function RelativeTime({
  at,
  className,
}: {
  at: number;
  className?: string;
}) {
  return (
    <time
      dateTime={new Date(at).toISOString()}
      title={formatTimestamp(at)}
      className={className}
    >
      {formatRelativeTime(at)}
    </time>
  );
}
