import { Badge } from "@/components/ui/badge";
import {
  formatProbeFailurePreview,
  formatProbeValueFields,
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
        <ProbeRow key={probe.id} probe={probe} />
      ))}
    </div>
  );
}

function ProbeRow({ probe }: { probe: VmProbe }) {
  const valueFields = formatProbeValueFields(probe.kind, probe.value);
  const failurePreview =
    probe.status === "pass"
      ? null
      : formatProbeFailurePreview(probe.kind, probe.value, probe.error);

  return (
    <details className="rounded-xl border bg-muted/20 p-3 [&_summary::-webkit-details-marker]:hidden">
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
            {summarizeProbeValue(probe.kind, probe.value) ??
              "No value reported"}
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
        <dl className="grid gap-x-4 gap-y-2 rounded-lg border bg-background/80 p-3 sm:grid-cols-2">
          {valueFields.map((field, index) => (
            <div key={`${field.label}-${index}`} className="min-w-0">
              <dt className="text-muted-foreground">{field.label}</dt>
              <dd className="mt-0.5 font-mono break-all text-foreground">
                {field.value}
              </dd>
            </div>
          ))}
        </dl>
        {failurePreview ? (
          <pre className="max-h-56 overflow-auto rounded-lg border border-destructive/30 bg-background/80 p-3 font-mono text-xs text-foreground whitespace-pre-wrap">
            {failurePreview}
          </pre>
        ) : null}
      </div>
    </details>
  );
}
