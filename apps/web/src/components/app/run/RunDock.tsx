import type { ReactNode } from "react";
import { BookOpen, Lightbulb, ListChecks } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  RUN_QUERY,
  useMediaQuery,
  useRunFrame,
  useRunSheet,
  type RunSheetSection,
} from "./run-viewport";

/**
 * The phone's way into checks, lecture and hints while the keyboard is down:
 * three buttons under the terminal that open the one run sheet. It carries the
 * bottom safe area itself. The panel is docked from 48rem, and in landscape
 * the same entries move into the run bar as icon buttons.
 */
export function RunDock({
  checksLabel,
  checksAccessibleLabel,
}: {
  /** "Checks 1/3", with the count free to roll. */
  checksLabel: ReactNode;
  checksAccessibleLabel: string;
}) {
  const sheet = useRunSheet();
  const { keyboardUp } = useRunFrame();
  const short = useMediaQuery(RUN_QUERY.short);
  // The keyboard takes the dock's place; in landscape the run bar carries
  // these entries as icon buttons.
  if (!sheet || keyboardUp || short) return null;

  const entry = (
    section: RunSheetSection,
    icon: typeof ListChecks,
    label: ReactNode,
    extra: { accessibleLabel?: string; trigger?: boolean } = {},
  ) => {
    const Icon = icon;
    const expanded = sheet.open && sheet.section === section;
    return (
      <button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={expanded}
        aria-label={extra.accessibleLabel}
        data-run-learning-panel-trigger={extra.trigger ? true : undefined}
        className={cn(
          "grid min-h-11 justify-items-center gap-0.5 rounded-lg px-1 py-1.5 text-[0.6875rem] font-medium text-muted-foreground transition-colors duration-(--duration-fast) ease-standard active:bg-muted aria-expanded:text-brand-text",
        )}
        onClick={(event) =>
          sheet.openSheet(section, { opener: event.currentTarget })
        }
      >
        <Icon className="size-5" aria-hidden="true" />
        {label}
      </button>
    );
  };

  return (
    <nav
      aria-label="Run panel"
      data-run-dock
      className="hidden shrink-0 grid-cols-3 border-t bg-background px-2 pt-1 pb-[max(0.25rem,env(safe-area-inset-bottom))] phone:grid"
    >
      {entry("checks", ListChecks, checksLabel, {
        accessibleLabel: checksAccessibleLabel,
        trigger: true,
      })}
      {entry("lecture", BookOpen, "Lecture")}
      {entry("hints", Lightbulb, "Hints")}
    </nav>
  );
}
