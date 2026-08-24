import { Badge } from "@/components/ui/badge";
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

export function ProbeRows(props: {
  probes: VmProbe[];
  checkLabelMap?: Record<string, string>;
}) {
  if (!props.probes.length) {
    return (
      <p className="py-4 text-sm text-muted-foreground">
        No verification results yet.
      </p>
    );
  }

  return (
    <ul className="divide-y border-y">
      {props.probes.map((probe, index) => (
        <ProbeRow
          key={probe.id}
          probe={probe}
          label={
            props.checkLabelMap?.[probe.id] ??
            `Verification objective ${index + 1}`
          }
        />
      ))}
    </ul>
  );
}

function ProbeRow({ probe, label }: { probe: VmProbe; label: string }) {
  const presentation = verificationPresentation(probe);

  return (
    <li className="py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={presentation.variant}>{presentation.label}</Badge>
          <span className="font-medium">{label}</span>
        </div>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          {presentation.detail}
        </p>
      </div>
    </li>
  );
}

function verificationPresentation(probe: VmProbe) {
  if (probe.status === "pass") {
    return {
      label: "Verified",
      variant: "success" as const,
      detail: "This objective is satisfied.",
    };
  }
  if (probe.status === "error" || probe.error?.trim()) {
    return {
      label: "Retrying",
      variant: "warning" as const,
      detail:
        "Verification could not complete. The system will try again automatically.",
    };
  }
  if (probe.status === "fail") {
    return {
      label: "Needs repair",
      variant: "destructive" as const,
      detail: "This objective still needs repair.",
    };
  }
  return {
    label: "Checking",
    variant: "outline" as const,
    detail: "Waiting for the first verification result.",
  };
}
