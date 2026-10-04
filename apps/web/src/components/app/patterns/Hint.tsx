import { useId, type ReactElement, type ReactNode } from "react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface HintProps {
  /** The words the tooltip shows. */
  label: ReactNode;
  /** The element that carries the hint, with its tag and own props. */
  render: ReactElement;
  /** What the element reads as. */
  children: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  /**
   * The hint holds something the element does not say on its own (an absolute
   * time, why an action is unavailable). The element then takes a tab stop, so
   * focus opens it too, and a screen reader hears it as the element's
   * description. Leave it off when the hint only repeats what is truncated.
   */
  essential?: boolean;
}

/**
 * Hover text for anything that is not an icon button: one shared Tooltip (a
 * 400ms pause, instant for a neighbour, focus opens it at once) in place of a
 * `title` attribute, which touch, keyboard and most screen readers never reach.
 */
export function Hint({
  label,
  render,
  children,
  side = "top",
  essential = false,
}: HintProps) {
  const id = useId();
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={render}
          tabIndex={essential ? 0 : undefined}
          aria-describedby={essential ? id : undefined}
        >
          {children}
        </TooltipTrigger>
        <TooltipContent side={side}>{label}</TooltipContent>
      </Tooltip>
      {essential ? (
        <span id={id} hidden>
          {label}
        </span>
      ) : null}
    </>
  );
}

/**
 * Says why a control is unavailable. A disabled button takes neither hover nor
 * focus, so the wrapper carries the tooltip and the tab stop. The wrapper is a
 * named group, so a screen reader announces the reason when focus lands on it.
 * The tree is the same with or without a reason: a reason that comes and goes
 * (a poll flipping a state) must not remount the control inside.
 */
export function WhyDisabled({
  reason,
  children,
}: {
  reason?: string | undefined;
  children: ReactNode;
}) {
  return (
    <Tooltip disabled={!reason}>
      <TooltipTrigger
        render={
          <span
            className="inline-flex"
            role={reason ? "group" : undefined}
            aria-label={reason}
            tabIndex={reason ? 0 : undefined}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}
