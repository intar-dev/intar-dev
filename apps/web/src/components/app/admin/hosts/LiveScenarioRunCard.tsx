import { lazy, Suspense, useRef, useState } from "react";
import { CircleHelpIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatTimestamp } from "./format";
import { groupVmProbesByScenario, ProbeRows } from "./ProbeRows";
import { Stat } from "@/components/app/patterns/Stat";
import type { AgentHostApi, VmProbeSummary, VmStatus } from "./types";

const LazyNativeSshDialog = lazy(async () => {
  const { NativeSshDialog } = await import(
    "@/components/remote-access/NativeSshDialogButton"
  );
  return { default: NativeSshDialog };
});

export function LiveScenarioRunCard(props: {
  host: AgentHostApi;
  vmItem: VmStatus;
  isExpanded: boolean;
  onToggle: () => void;
  onOpenWebSsh: () => void;
  onDelete: () => void;
  isDeleting: boolean;
}) {
  const [nativeSshOpen, setNativeSshOpen] = useState(false);
  const nativeSshTriggerRef = useRef<HTMLButtonElement>(null);
  const probeState = props.vmItem.probe_state ?? null;
  const summary = probeState?.summary ?? null;
  const binarySummary = summary ? binaryProbeSummary(summary) : null;
  const scenarioMeta = props.vmItem.scenario_meta ?? null;
  const groupedProbes = props.isExpanded && probeState
    ? groupVmProbesByScenario(probeState.probes, scenarioMeta)
    : null;
  const terminalTarget = props.vmItem.terminal_target ?? {
    state: "pending" as const,
    reason:
      props.vmItem.state.trim().toLowerCase() === "running"
        ? "Waiting for the terminal target to become reachable."
        : "The terminal target is only prepared when the VM is running.",
    host: null,
    port: 22,
    username: "ubuntu",
  };

  return (
    <article className="overflow-hidden rounded-xl border bg-card shadow-xs">
      <div className="flex flex-col gap-4 px-4 py-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0 flex-1 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant={
                props.vmItem.state.trim().toLowerCase() === "running"
                  ? "success"
                  : "warning"
              }
            >
              {props.vmItem.state}
            </Badge>
            <span className="text-xs font-semibold text-foreground">
              {scenarioMeta?.scenarioName ?? "Legacy run"}
            </span>
            <span aria-hidden="true" className="text-muted-foreground">
              ·
            </span>
            <span className="font-mono text-xs text-muted-foreground">
              {props.host.name}
            </span>
            {binarySummary ? (
              <span
                data-numeric
                className="ml-1 inline-flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground"
                aria-label={`${binarySummary.verified} verified, ${binarySummary.needsRepair} need repair`}
              >
                <span>
                  <strong className="text-success">
                    {binarySummary.verified}
                  </strong>{" "}
                  Verified
                </span>
                <span>
                  <strong className="text-destructive">
                    {binarySummary.needsRepair}
                  </strong>{" "}
                  Needs repair
                </span>
              </span>
            ) : null}
          </div>

          <div>
            <h3 className="text-lg font-semibold tracking-tight">
              {props.vmItem.name}
            </h3>
            <p className="text-sm text-muted-foreground">
              {scenarioMeta?.scenarioVmName ?? "Legacy VM"} • Run{" "}
              {props.vmItem.run_id ?? "—"}
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <Stat size="sm"
              label="Guest IP"
              value={props.vmItem.details?.guest_ip ?? "—"}
            />
            <Stat size="sm"
              label="Updated"
              value={formatTimestamp(props.vmItem.updated_at)}
            />
            <Stat size="sm"
              label="Probe update"
              value={formatTimestamp(probeState?.updated_at)}
            />
            <Stat size="sm"
              label="Target"
              value={
                terminalTarget.host
                  ? `${terminalTarget.host}:${terminalTarget.port}`
                  : "Pending"
              }
              detail={terminalTarget.state === "ready" ? "Ready" : "Bootstrap pending"}
            />
            <Stat size="sm" label="Host" value={props.host.name} detail={props.host.id} />
          </div>

          {props.vmItem.error ? (
            <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              {props.vmItem.error}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={props.isExpanded}
            onClick={props.onToggle}
          >
            {props.isExpanded ? "Hide details" : "Details"}
          </Button>
          <div
            className="inline-flex"
            title={
              terminalTarget.state === "ready"
                ? undefined
                : (terminalTarget.reason ?? undefined)
            }
          >
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => {
                if (!terminalTarget.host) return;
                props.onOpenWebSsh();
              }}
              disabled={
                !props.vmItem.run_id ||
                terminalTarget.state !== "ready" ||
                !terminalTarget.host
              }
            >
              Open Web SSH
              {terminalTarget.state !== "ready" || !terminalTarget.host ? (
                <CircleHelpIcon size={12} />
              ) : null}
            </Button>
          </div>
          <Button
            ref={nativeSshTriggerRef}
            type="button"
            size="sm"
            variant="outline"
            aria-haspopup="dialog"
            aria-expanded={nativeSshOpen}
            onClick={() => setNativeSshOpen(true)}
            disabled={
              !props.vmItem.run_id ||
              terminalTarget.state !== "ready" ||
              !terminalTarget.host
            }
          >
            Native SSH
          </Button>
          <Button
            type="button"
            size="sm"
            variant="destructive"
            onClick={props.onDelete}
            disabled={!props.vmItem.run_id || props.isDeleting}
          >
            {props.isDeleting ? "Ending…" : "End run"}
          </Button>
        </div>
      </div>

      {props.isExpanded ? (
        <div className="space-y-4 border-t px-4 py-4">
          {probeState ? (
            <VerificationCollectionStatus
              state={probeState.collection_state}
              generatedAt={probeState.generated_at}
              error={probeState.collection_error}
            />
          ) : null}
          <div className="space-y-4">
            {probeState?.probes.length ? (
              scenarioMeta && groupedProbes ? (
                <>
                  <div className="rounded-xl bg-muted/40 p-4">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <p className="text-sm font-medium">Boot checks</p>
                      <Badge variant="outline">{groupedProbes.boot.length}</Badge>
                    </div>
                    <ProbeRows
                      probes={groupedProbes.boot}
                      checkLabelMap={scenarioMeta.checkLabelMap}
                    />
                  </div>
                  <div className="rounded-xl bg-muted/40 p-4">
                    <div className="mb-3 flex items-center justify-between gap-2">
                      <p className="text-sm font-medium">Repair checks</p>
                      <Badge variant="outline">
                        {groupedProbes.scenario.length}
                      </Badge>
                    </div>
                    <ProbeRows
                      probes={groupedProbes.scenario}
                      checkLabelMap={scenarioMeta.checkLabelMap}
                    />
                  </div>
                  {groupedProbes.other.length ? (
                    <div className="rounded-xl bg-muted/40 p-4">
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <p className="text-sm font-medium">Other checks</p>
                        <Badge variant="outline">
                          {groupedProbes.other.length}
                        </Badge>
                      </div>
                      <ProbeRows
                        probes={groupedProbes.other}
                        checkLabelMap={scenarioMeta.checkLabelMap}
                      />
                    </div>
                  ) : null}
                </>
              ) : (
                <ProbeRows probes={probeState.probes} />
              )
            ) : (
              <div className="rounded-xl bg-muted/40 px-4 py-8 text-center text-sm text-muted-foreground">
                No verification results yet for this VM.
              </div>
            )}
          </div>
        </div>
      ) : null}

      {nativeSshOpen ? (
        <Suspense fallback={null}>
          <LazyNativeSshDialog
            vmName={props.vmItem.name}
            sessionRequest={{
              url: `/api/scenarios/runs/${encodeURIComponent(props.vmItem.run_id ?? "")}/ssh`,
              body: { vmId: props.vmItem.id },
            }}
            open={nativeSshOpen}
            onOpenChange={(open) => {
              setNativeSshOpen(open);
              if (!open && typeof window !== "undefined") {
                window.requestAnimationFrame(() => {
                  nativeSshTriggerRef.current?.focus();
                });
              }
            }}
          />
        </Suspense>
      ) : null}
    </article>
  );
}

export function binaryProbeSummary(summary: VmProbeSummary) {
  return {
    verified: summary.pass,
    needsRepair: summary.fail + summary.unknown,
  };
}

export function VerificationCollectionStatus(props: {
  state: string;
  generatedAt: string | null;
  error: string | null;
}) {
  const unavailable = Boolean(props.error?.trim()) || props.state === "error";
  if (!unavailable) return null;
  return (
    <div
      role="status"
      className="rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-destructive"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">Verification unavailable</p>
        <p className="text-xs">
          Updated {formatTimestamp(props.generatedAt)}
        </p>
      </div>
      <p className="mt-2 text-xs">
        We cannot confirm verification progress right now.
      </p>
    </div>
  );
}
