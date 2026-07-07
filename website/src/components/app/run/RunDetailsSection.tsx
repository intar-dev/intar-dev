import { useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { formatBytes } from "../lib/format";
import type { RunVmProvisioningSpec } from "@/lib/run-state";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { ObjectiveTimeline } from "./ObjectiveTimeline";

// Machine facts + probe timeline behind one collapsed disclosure — debugging
// info, not workspace furniture. The timeline only mounts (and fetches) when
// the section is opened, keeping it off the run poll's hot path.
export function RunDetailsSection({
  runId,
  vmName,
  hostname,
  provisioning,
  terminalTarget,
}: {
  runId: string;
  vmName: string | null;
  hostname: string | null;
  provisioning: RunVmProvisioningSpec | null;
  terminalTarget: {
    host: string | null;
    port: number;
    username: string;
  } | null;
}) {
  const [open, setOpen] = useState(false);
  const resources = provisioning?.resources;

  return (
    <Card size="sm">
      <CardHeader>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 text-left"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
        >
          <CardTitle className="font-heading text-base">Details</CardTitle>
          <ChevronDown
            className={cn(
              "size-4 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
            aria-hidden="true"
          />
        </button>
      </CardHeader>
      {open ? (
        <CardContent className="space-y-6">
          {vmName ? (
            <div className="space-y-2">
              <p className="text-eyebrow">Machine</p>
              <dl className="space-y-2 text-xs">
                <DetailRow label="Name">{vmName}</DetailRow>
                {hostname ? (
                  <DetailRow label="Hostname">
                    <code>{hostname}</code>
                  </DetailRow>
                ) : null}
                {provisioning?.image ? (
                  <DetailRow label="Image">
                    <code className="break-all">{provisioning.image}</code>
                  </DetailRow>
                ) : null}
                {provisioning?.imageSha256 ? (
                  <DetailRow label="SHA-256">
                    <code title={provisioning.imageSha256}>
                      {provisioning.imageSha256.slice(0, 16)}…
                    </code>
                  </DetailRow>
                ) : null}
                {resources ? (
                  <DetailRow label="Resources">
                    {resources.vcpus} vCPU ·{" "}
                    {formatBytes(resources.memoryMib * 1024 * 1024)} RAM ·{" "}
                    {formatBytes(resources.diskMib * 1024 * 1024)} disk
                  </DetailRow>
                ) : null}
                {typeof provisioning?.leaseDurationSeconds === "number" &&
                provisioning.leaseDurationSeconds > 0 ? (
                  <DetailRow label="Lease">
                    {Math.round(provisioning.leaseDurationSeconds / 60)} min
                  </DetailRow>
                ) : null}
                {terminalTarget?.host ? (
                  <DetailRow label="SSH target">
                    <code>
                      {terminalTarget.username}@{terminalTarget.host}:
                      {terminalTarget.port}
                    </code>
                  </DetailRow>
                ) : null}
              </dl>
            </div>
          ) : null}
          <div className="space-y-2">
            <p className="text-eyebrow">Timeline</p>
            <ObjectiveTimeline runId={runId} />
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium">{children}</dd>
    </div>
  );
}
