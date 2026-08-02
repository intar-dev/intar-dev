import { cn } from "@/lib/utils";
import type { ScenarioRunVmRecord } from "./run-types";

const PHASE_DOT: Partial<Record<ScenarioRunVmRecord["phase"], string>> = {
  running: "bg-success",
  solved: "bg-success",
  failed: "bg-destructive",
  completed: "bg-muted-foreground",
};

// Segmented machine tabs, sitting flush above the terminal. The single-machine
// form still makes the selected VM and its current state explicit.
export function ScenarioVmSelector(props: {
  vms: ScenarioRunVmRecord[];
  selectedVmId: string | null;
  onSelect: (vmId: string) => void;
}) {
  return (
    <div
      className="flex w-fit flex-wrap gap-1 rounded-xl bg-muted p-1"
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
            title={`${vm.hostname} · ${vm.phaseTitle}`}
            aria-pressed={active}
            className={cn(
              "flex min-h-11 items-center gap-2 rounded-lg px-3.5 py-2 text-left text-sm font-medium transition-colors",
              active
                ? "bg-background text-foreground shadow-xs"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <span
              className={cn(
                "size-2 rounded-full",
                PHASE_DOT[vm.phase] ?? "bg-warning motion-safe:animate-pulse",
              )}
              aria-hidden="true"
            />
            <span className="min-w-0">
              <span className="block truncate">{vm.scenarioVmName}</span>
              <span className="block truncate text-xs font-normal text-muted-foreground">
                {vm.phaseTitle}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
