import { cn } from "@/lib/utils";
import type { ScenarioRunVmRecord } from "./run-types";

const PHASE_DOT: Partial<Record<ScenarioRunVmRecord["phase"], string>> = {
  running: "bg-success",
  solved: "bg-success",
  failed: "bg-destructive",
  completed: "bg-muted-foreground",
};

// A single VM is already named by the terminal. Only render a switcher when
// there is an actual choice to make.
export function ScenarioVmSelector(props: {
  vms: ScenarioRunVmRecord[];
  selectedVmId: string | null;
  onSelect: (vmId: string) => void;
}) {
  if (props.vms.length < 2) {
    return null;
  }

  return (
    <div
      className="flex min-w-0 overflow-x-auto border-b border-border"
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
              "-mb-px flex min-h-10 shrink-0 items-center gap-2 border-b-2 px-3 py-2 text-left text-sm font-medium transition-colors [@media(pointer:coarse)]:min-h-11",
              active
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:border-muted-foreground/50 hover:text-foreground",
            )}
          >
            <span
              className={cn(
                "size-2 rounded-full",
                PHASE_DOT[vm.phase] ?? "bg-warning motion-safe:animate-pulse",
              )}
              aria-hidden="true"
            />
            <span className="truncate">{vm.scenarioVmName}</span>
            <span className="truncate text-xs font-normal text-muted-foreground">
              {vm.phaseTitle}
            </span>
          </button>
        );
      })}
    </div>
  );
}
