import { useRef } from "react";
import { cn } from "@/lib/utils";
import { useEdgeFade } from "./use-edge-fade";
import type { ScenarioRunVmRecord } from "./run-types";

// Running is primary, solved is success, failed is destructive and ended is
// faint. Becoming is warning and still: the header token holds the page's one
// pulse, and the phase word beside the dot carries the state.
const PHASE_DOT: Partial<Record<ScenarioRunVmRecord["phase"], string>> = {
  running: "bg-primary",
  solved: "bg-success",
  failed: "bg-destructive",
  completed: "bg-faint-foreground",
};

// A single VM is already named by the terminal. Only render a switcher when
// there is an actual choice to make.
export function ScenarioVmSelector(props: {
  vms: ScenarioRunVmRecord[];
  selectedVmId: string | null;
  onSelect: (vmId: string) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  useEdgeFade(strip, [props.vms.length]);

  if (props.vms.length < 2) {
    return null;
  }

  return (
    <div
      ref={strip}
      className="scroll-fade no-scrollbar flex min-w-0 overflow-x-auto border-b border-border"
      role="group"
      aria-label="Machines"
    >
      {props.vms.map((vm) => {
        const active = vm.id === props.selectedVmId;
        return (
          <button
            key={vm.id}
              type="button"
              onClick={() => props.onSelect(vm.id)}
              aria-pressed={active}
            className={cn(
              // The strip scrolls, so the focus ring sits inside the tab.
              "-mb-px flex min-h-10 shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-left text-support font-medium transition-colors duration-(--duration-fast) ease-standard focus-visible:-outline-offset-2 [@media(pointer:coarse)]:min-h-11",
              active
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
            )}
          >
            <span
              className={cn(
                "size-2 rounded-full",
                PHASE_DOT[vm.phase] ?? "bg-warning",
              )}
              aria-hidden="true"
            />
            <span className="truncate">{vm.scenarioVmName}</span>
            <span className="truncate text-caption font-normal text-muted-foreground">
              {vm.phaseTitle}
            </span>
          </button>
        );
      })}
    </div>
  );
}
