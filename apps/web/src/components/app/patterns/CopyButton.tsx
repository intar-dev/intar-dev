import { useEffect, useRef, useState } from "react";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { AsyncLabel } from "./AsyncLabel";

const COPIED_MS = 1600;

/**
 * Copies `text` and confirms in place: "Copy" swaps to a drawn check and
 * "Copied" for duration-flash, and the accessible name follows. A failure
 * calls `onError` so the caller can show it beside the control.
 */
export function CopyButton({
  text,
  label = "Copy",
  copiedLabel = "Copied",
  name,
  onError,
  variant = "outline",
  size = "sm",
  className,
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
  /** Accessible name when the visible label is too short, e.g. "Copy the command". */
  name?: string;
  onError?: (error: unknown) => void;
  variant?: "outline" | "ghost" | "secondary";
  size?: "sm" | "xs" | "default";
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      className={className}
      aria-label={copied ? copiedLabel : name}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          if (timer.current) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
        } catch (error) {
          onError?.(error);
        }
      }}
    >
      <AsyncLabel
        state={copied ? "done" : "idle"}
        idle={
          <>
            <Copy className="size-3.5" aria-hidden="true" />
            {label}
          </>
        }
        pending={null}
        done={copiedLabel}
      />
    </Button>
  );
}
