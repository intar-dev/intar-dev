import { cn } from "@/lib/utils";

/** Lucide's copy with its front sheet grouped, so it slides off its twin on hover or focus. */
export function CopyIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("size-3.5 overflow-visible", className)}
    >
      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
      <rect data-copy-front width="14" height="14" x="8" y="8" rx="2" ry="2" />
    </svg>
  );
}

CopyIcon.displayName = "CopyIcon";
