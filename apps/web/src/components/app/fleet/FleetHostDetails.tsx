// The facts of the selected host. The map holds the geography, this panel holds
// the detail, and the selection persists until the reader clears it or picks
// another host.

import { X } from "lucide-react";
import {
  StatusToken,
  type StatusTone,
} from "@/components/app/patterns/StatusToken";
import { Section } from "@/components/app/patterns/Section";
import { Button } from "@/components/ui/button";
import type { HostHealth } from "@/lib/host-health";
import {
  formatCpuMillis,
  formatHostState,
  formatLocation,
  formatMemoryMib,
} from "./format";
import { providerMark } from "./providers";
import type { FleetMapHost } from "./types";

// The amber tone is the system's "needs attention" dot. An overdue report needs
// attention, so it takes that tone instead of a status word of its own.
const STATE_TONES: Record<HostHealth, StatusTone> = {
  healthy: "success",
  degraded: "pending",
  unknown: "muted",
};

export function FleetHostDetails({
  host,
  onClear,
}: {
  host: FleetMapHost | null;
  onClear: () => void;
}) {
  return (
    <Section
      density="compact"
      title="Selected host"
      bodyClassName="space-y-3"
      actions={
        host ? (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Clear selected host"
            onClick={onClear}
          >
            <X />
          </Button>
        ) : undefined
      }
    >
      {host ? (
        <FleetHostFacts host={host} />
      ) : (
        <p className="text-metadata">
          Choose a pin on the map, or a row in the list, to read that host here.
        </p>
      )}
    </Section>
  );
}

function FleetHostFacts({ host }: { host: FleetMapHost }) {
  const mark = providerMark(host.provider);
  return (
    <>
      <div className="space-y-1">
        <p className="text-card-title">
          {formatLocation(host.city, host.country)}
        </p>
        <StatusToken
          tone={STATE_TONES[host.state]}
          word={formatHostState(host.state)}
        />
      </div>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-support">
        <dt className="text-caption">CPU</dt>
        <dd className="text-right tabular-nums">
          {formatCpuMillis(host.cpuMillis)}
        </dd>
        <dt className="text-caption">Memory</dt>
        <dd className="text-right tabular-nums">
          {formatMemoryMib(host.memoryMib)}
        </dd>
      </dl>
      {mark ? (
        <div className="flex items-center gap-2 border-t pt-3">
          <span className="text-caption">Infrastructure by</span>
          <img
            src={mark.src}
            width={mark.width}
            height={mark.height}
            alt={mark.label}
            className={mark.className}
          />
        </div>
      ) : null}
    </>
  );
}
