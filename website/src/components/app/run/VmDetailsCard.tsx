import { formatBytes } from "../lib/format";
import type { RunVmProvisioningSpec } from "@/lib/run-state";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Compact per-VM facts: what the sandbox runs on and how to reach it.
export function VmDetailsCard({
  vmName,
  hostname,
  provisioning,
  terminalTarget,
}: {
  vmName: string;
  hostname: string;
  provisioning: RunVmProvisioningSpec;
  terminalTarget: {
    host: string | null;
    port: number;
    username: string;
  };
}) {
  const resources = provisioning.resources;
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base">Machine</CardTitle>
        <CardDescription>{vmName}</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="space-y-2 text-xs">
          <DetailRow label="Hostname">
            <code>{hostname}</code>
          </DetailRow>
          {provisioning.image ? (
            <DetailRow label="Image">
              <code className="break-all">{provisioning.image}</code>
            </DetailRow>
          ) : null}
          {provisioning.imageSha256 ? (
            <DetailRow label="SHA-256">
              <code title={provisioning.imageSha256}>
                {provisioning.imageSha256.slice(0, 16)}…
              </code>
            </DetailRow>
          ) : null}
          {resources ? (
            <DetailRow label="Resources">
              {resources.vcpus} vCPU · {formatBytes(resources.memoryMib * 1024 * 1024)}{" "}
              RAM · {formatBytes(resources.diskMib * 1024 * 1024)} disk
            </DetailRow>
          ) : null}
          {typeof provisioning.leaseDurationSeconds === "number" &&
          provisioning.leaseDurationSeconds > 0 ? (
            <DetailRow label="Lease">
              {Math.round(provisioning.leaseDurationSeconds / 60)} min
            </DetailRow>
          ) : null}
          {terminalTarget.host ? (
            <DetailRow label="SSH target">
              <code>
                {terminalTarget.username}@{terminalTarget.host}:
                {terminalTarget.port}
              </code>
            </DetailRow>
          ) : null}
        </dl>
      </CardContent>
    </Card>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap justify-between gap-x-3 gap-y-0.5">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium">{children}</dd>
    </div>
  );
}
