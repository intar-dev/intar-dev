import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import type { ScenarioRunVmRecord } from "./run-types";

export function ScenarioVmSelector(props: {
  vms: ScenarioRunVmRecord[];
  selectedVmId: string | null;
  onSelect: (vmId: string) => void;
}) {
  if (props.vms.length <= 1) {
    return null;
  }

  return (
    <div className="rounded-2xl border border-border/70 bg-muted/[0.18] p-2">
      <div className="mb-2 flex items-center justify-between px-2 pt-1">
        <div>
          <p className="text-sm font-medium tracking-tight">Mission VMs</p>
          <p className="text-xs text-muted-foreground">
            Switch the terminal and probe rail between scenario machines.
          </p>
        </div>
      </div>
      <div className="grid gap-2 md:grid-cols-2">
        {props.vms.map((vm) => {
          const active = vm.id === props.selectedVmId;
          return (
            <button
              key={vm.id}
              type="button"
              onClick={() => props.onSelect(vm.id)}
              className={cn(
                "rounded-xl border px-4 py-3 text-left transition-colors",
                active
                  ? "border-foreground/20 bg-background shadow-sm"
                  : "border-transparent bg-transparent hover:border-border/80 hover:bg-background/70",
              )}
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{vm.scenarioVmName}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {vm.hostname}
                  </p>
                </div>
                <Badge variant={vm.phase === "solved" ? "default" : "secondary"}>
                  {vm.phaseTitle}
                </Badge>
              </div>
              <p className="mt-2 line-clamp-2 text-xs text-muted-foreground">
                {vm.phaseDetail}
              </p>
            </button>
          );
        })}
      </div>
    </div>
  );
}
