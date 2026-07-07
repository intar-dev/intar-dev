import { cn } from "@/lib/utils";
import type { ScenarioRunVmRecord } from "./run-types";

const PHASE_DOT: Partial<Record<ScenarioRunVmRecord["phase"], string>> = {
  running: "bg-success",
  solved: "bg-success",
  failed: "bg-destructive",
  completed: "bg-muted-foreground",
};

// Segmented machine tabs, sitting flush above the terminal. Only rendered
// when the scenario has more than one machine.
export function ScenarioVmSelector(props: {
  vms: ScenarioRunVmRecord[];
  selectedVmId: string | null;
  onSelect: (vmId: string) => void;
}) {
  if (props.vms.length <= 1) {
    return null;
  }

  return (
    <div className="flex w-fit flex-wrap gap-1 rounded-xl bg-muted p-1">
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
              "flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors",
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
            {vm.scenarioVmName}
          </button>
        );
      })}
    </div>
  );
}
