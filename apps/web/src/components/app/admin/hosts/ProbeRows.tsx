import { Badge } from "@/components/ui/badge";
import {
  formatTimestamp,
  probeStatusTone,
  summarizeProbeValue,
} from "./format";
import type { VmProbe, VmScenarioMeta } from "./types";

export function groupVmProbesByScenario(
  probes: VmProbe[],
  scenarioMeta: VmScenarioMeta | null | undefined,
) {
  if (!scenarioMeta) {
    return null;
  }

  const boot: VmProbe[] = [];
  const scenario: VmProbe[] = [];
  const other: VmProbe[] = [];

  for (const probe of probes) {
    const phase = scenarioMeta.probePhaseMap[probe.id];
    if (phase === "boot") {
      boot.push(probe);
    } else if (phase === "scenario") {
      scenario.push(probe);
    } else {
      other.push(probe);
    }
  }

  return { boot, scenario, other };
}

export function ProbeRows(props: { probes: VmProbe[] }) {
  if (!props.probes.length) {
    return (
      <div className="rounded-xl border border-dashed bg-background/70 px-4 py-6 text-center text-muted-foreground">
        No probes in this section yet.
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {props.probes.map((probe) => (
        <details
          key={probe.id}
          className="rounded-xl border bg-muted/20 p-3 [&_summary::-webkit-details-marker]:hidden"
        >
          <summary className="flex cursor-pointer list-none items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge
                  variant={probeStatusTone(probe.status)}
                  className="capitalize"
                >
                  {probe.status}
                </Badge>
                <span className="font-medium">{probe.id}</span>
                <span className="text-muted-foreground">{probe.kind}</span>
              </div>
              <p className="mt-1 truncate text-xs text-muted-foreground">
                {summarizeProbeValue(probe.value)}
              </p>
            </div>
            <span className="text-xs text-muted-foreground">Details</span>
          </summary>
          <div className="mt-3 grid gap-3 text-xs text-muted-foreground">
            <div className="grid gap-2 sm:grid-cols-2">
              <p>Every: {probe.every_seconds}s</p>
              <p>Last duration: {probe.last_duration_ms} ms</p>
              <p>Last attempt: {formatTimestamp(probe.last_attempt_at)}</p>
              <p>Last success: {formatTimestamp(probe.last_success_at)}</p>
            </div>
            {probe.error ? (
              <p className="text-destructive">{probe.error}</p>
            ) : null}
            <pre className="overflow-x-auto rounded-lg border bg-background/80 p-3 text-xs text-foreground">
              <code>{JSON.stringify(probe.value, null, 2)}</code>
            </pre>
          </div>
        </details>
      ))}
    </div>
  );
}
