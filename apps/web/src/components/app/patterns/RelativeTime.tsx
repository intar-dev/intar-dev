import { formatRelativeTime, formatTimestamp } from "../lib/format";
import { Hint } from "./Hint";

// Relative wording with the absolute moment in a tooltip (hover or focus) — the
// inverse affordance (absolute text, relative title) belongs to timeline entries.
export function RelativeTime({
  at,
  className,
}: {
  at: number;
  className?: string;
}) {
  return (
    <Hint
      essential
      label={formatTimestamp(at)}
      render={<time dateTime={new Date(at).toISOString()} className={className} />}
    >
      {formatRelativeTime(at)}
    </Hint>
  );
}
