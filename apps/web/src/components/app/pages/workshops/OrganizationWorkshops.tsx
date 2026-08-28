import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import {
  ArrowRight,
  CalendarPlus,
  CheckCircle2,
  CircleAlert,
  Cloud,
  Clock3,
  HardDriveDownload,
  Presentation,
  Server,
  Users,
} from "lucide-react";
import { MetaLine } from "@/components/app/patterns/MetaLine";
import { PageShell } from "@/components/app/patterns/PageShell";
import { ErrorState, EmptyState } from "@/components/app/patterns/StateCard";
import { usePageChrome } from "@/components/app/shell/page-chrome";
import {
  acknowledgeWorkshopProviderManualCleanup,
  connectWorkshopProvider,
  createWorkshopSession,
  disconnectWorkshopProvider,
  getOrganizationWorkshops,
  inspectWorkshopProviderConnection,
  mutateWorkshopSession,
  overrideWorkshopCostCeiling,
  refreshWorkshopCostForecast,
  rotateWorkshopProviderCredential,
  updateWorkshopProviderGuardrails,
} from "@/components/app/workshops/api";
import type {
  OrganizationWorkshopTemplate,
  OrganizationWorkshopsResponse,
  WorkshopCostScenario,
  WorkshopMemberRole,
  WorkshopSessionSummary,
} from "@/components/app/workshops/types";
import { workshopSessionStateLabel } from "@/components/app/workshops/types";
import { WorkshopPublisherTokens } from "@/components/app/workshops/WorkshopPublisherTokens";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

type RosterRole = WorkshopMemberRole | "excluded";

type RosterChoice = {
  role: RosterRole;
  workspaceEnabled: boolean;
};

function makeRosterChoice(
  role: RosterRole,
  workspaceEnabled = role === "participant",
): RosterChoice {
  return {
    role,
    workspaceEnabled: role === "participant" || workspaceEnabled,
  };
}

export function OrganizationWorkshops() {
  const { orgId } = useParams({ from: "/app/organizations/$orgId/workshops" });
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const workshops = useQuery({
    queryKey: ["organizations", orgId, "workshops"],
    queryFn: () => getOrganizationWorkshops(orgId),
    retry: 1,
    staleTime: 5_000,
    refetchInterval: (query) =>
      query.state.data?.sessions.some(
        (session) => session.state === "live" || session.state === "lobby",
      )
        ? 2_000
        : false,
  });
  const data = workshops.data;

  const chromeAction = useMemo(
    () =>
      data?.organization.role !== "member" ? (
        <Button size="sm" onClick={() => setScheduleOpen(true)}>
          <CalendarPlus />
          <span className="hidden sm:inline">Schedule</span>
        </Button>
      ) : undefined,
    [data?.organization.role],
  );
  usePageChrome({
    title: data
      ? `${data.organization.name} workshops`
      : "Organization workshops",
    action: chromeAction,
  });

  if (workshops.error) {
    return (
      <PageShell width="content">
        <ErrorState
          title="Could not load organization workshops"
          description={
            workshops.error instanceof Error
              ? workshops.error.message
              : "The workshop control plane is unavailable."
          }
          onRetry={() => void workshops.refetch()}
        />
      </PageShell>
    );
  }
  if (!data) return <OrganizationWorkshopsLoading />;

  return (
    <PageShell width="workspace" density="compact">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <p className="text-page-title">
            {data.organization.name}
          </p>
          <p className="max-w-[68ch] text-sm text-muted-foreground">
            Private templates, fixed rosters, runner capacity, and live session
            controls.
          </p>
        </div>
        <Button
          size="sm"
          variant="outline"
          render={<Link to="/organizations/$orgId" params={{ orgId }} />}
        >
          Organization overview
        </Button>
      </header>

      {data.organization.role === "owner" ? (
        <WorkshopPublisherTokens organizationId={data.organization.id} />
      ) : null}
      <CapacityLedger data={data} />
      {data.organization.role !== "member" ? (
        <ProviderConnectionLedger
          organizationId={data.organization.id}
          role={data.organization.role}
          connections={data.providerConnections}
          onChanged={() =>
            queryClient.invalidateQueries({
              queryKey: ["organizations", orgId, "workshops"],
            })
          }
        />
      ) : null}

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(22rem,0.72fr)]">
        <TemplateLedger templates={data.templates} />
        <SessionLedger
          organizationId={data.organization.id}
          organizationRole={data.organization.role}
          sessions={data.sessions}
          members={data.members}
          viewerUserId={data.viewer.userId}
          onRosterUpdated={() =>
            queryClient.invalidateQueries({
              queryKey: ["organizations", orgId, "workshops"],
            })
          }
        />
      </div>

      <ScheduleWorkshopDialog
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        data={data}
        onCreated={async (sessionId) => {
          await Promise.all([
            queryClient.invalidateQueries({
              queryKey: ["organizations", orgId, "workshops"],
            }),
            queryClient.invalidateQueries({ queryKey: ["workshops", "list"] }),
          ]);
          void navigate({
            to: "/workshops/$sessionId",
            params: { sessionId },
          });
        }}
      />
    </PageShell>
  );
}

function ProviderConnectionLedger({
  organizationId,
  role,
  connections,
  onChanged,
}: {
  organizationId: string;
  role: "owner" | "admin";
  connections: OrganizationWorkshopsResponse["providerConnections"];
  onChanged: () => Promise<unknown>;
}) {
  const providers = ["hetzner_cloud", "gcp_compute"] as const;
  return (
    <section aria-labelledby="workshop-provider-heading" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2
            id="workshop-provider-heading"
            className="text-section-title"
          >
            Learner cloud projects
          </h2>
        </div>
        <p className="text-xs text-muted-foreground">
          {role === "owner" ? "Owner-managed" : "Read-only for admins"}
        </p>
      </div>
      {connections.length ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {connections.map((connection) => (
            <ProviderConnectionCard
              key={connection.id}
              organizationId={organizationId}
              role={role}
              connection={connection}
              onChanged={onChanged}
            />
          ))}
        </div>
      ) : role !== "owner" ? (
        <div className="rounded-xl border bg-card p-4 text-sm text-muted-foreground">
          No cloud project is connected. An organization owner must connect a
          dedicated, initially empty Hetzner or GCP project before admins can
          schedule a direct-cloud runtime.
        </div>
      ) : null}
      {role === "owner" ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {providers.map((providerKind) =>
            connections.some(
              (connection) =>
                connection.providerKind === providerKind &&
                connection.state !== "disconnected",
            ) ? null : (
              <ConnectProviderProjectCard
                key={providerKind}
                organizationId={organizationId}
                providerKind={providerKind}
                onChanged={onChanged}
              />
            ),
          )}
        </div>
      ) : null}
    </section>
  );
}

type ProviderConnection =
  OrganizationWorkshopsResponse["providerConnections"][number];

function ConnectProviderProjectCard({
  organizationId,
  providerKind,
  onChanged,
}: {
  organizationId: string;
  providerKind: "hetzner_cloud" | "gcp_compute";
  onChanged: () => Promise<unknown>;
}) {
  const gcp = providerKind === "gcp_compute";
  const [credential, setCredential] = useState("");
  const [displayName, setDisplayName] = useState(
    gcp ? "GCP Compute" : "Hetzner Cloud",
  );
  const [locations, setLocations] = useState(
    gcp
      ? "europe-west3-a, europe-west3-b, europe-west3-c"
      : "nbg1, fsn1, hel1",
  );
  const [maxAllocations, setMaxAllocations] = useState("5");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="rounded-xl border bg-card p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        const submittedCredential = credential;
        setCredential("");
        setBusy(true);
        setError(null);
        try {
          await connectWorkshopProvider(organizationId, {
            providerKind,
            credential: submittedCredential,
            displayName: displayName.trim(),
            approvedLocations: parseLocationList(locations),
            maxConcurrentAllocations: Number(maxAllocations),
          });
          await onChanged();
        } catch (connectionError) {
          setError(providerActionError(connectionError));
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <Cloud className="size-4" />
        </span>
        <div>
          <p className="text-sm font-semibold">
            Connect {gcp ? "GCP Compute" : "Hetzner Cloud"}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            Intar validates an initially empty, dedicated project before the
            provider Worker encrypts the credential. Billing stays with your
            cloud account.
          </p>
        </div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="space-y-1.5 text-xs font-medium">
          Display name
          <Input
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
            maxLength={80}
            required
          />
        </label>
        <label className="space-y-1.5 text-xs font-medium">
          {gcp ? "Service-account JSON key" : "Read/write API token"}
          {gcp ? (
            <Textarea
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              rows={4}
              required
            />
          ) : (
            <Input
              type="password"
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              required
            />
          )}
        </label>
        <label className="space-y-1.5 text-xs font-medium">
          Location order
          <Input
            value={locations}
            onChange={(event) => setLocations(event.target.value)}
            required
          />
        </label>
        <label className="space-y-1.5 text-xs font-medium">
          Maximum learner VMs
          <Input
            type="number"
            min={1}
            max={100}
            value={maxAllocations}
            onChange={(event) => setMaxAllocations(event.target.value)}
            required
          />
        </label>
      </div>
      {error ? (
        <p className="mt-3 text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-4 flex justify-end">
        <Button size="sm" type="submit" disabled={busy}>
          {busy ? "Validating project…" : "Connect project"}
        </Button>
      </div>
    </form>
  );
}

function ProviderConnectionCard({
  organizationId,
  role,
  connection,
  onChanged,
}: {
  organizationId: string;
  role: "owner" | "admin";
  connection: ProviderConnection;
  onChanged: () => Promise<unknown>;
}) {
  const [locations, setLocations] = useState(
    connection.guardrails.locations.join(", "),
  );
  const [maxAllocations, setMaxAllocations] = useState(
    String(connection.guardrails.maxConcurrentAllocations),
  );
  const [costCeiling, setCostCeiling] = useState(
    formatNanosInput(connection.guardrails.maxSessionCostNanos),
  );
  const [credential, setCredential] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLocations(connection.guardrails.locations.join(", "));
    setMaxAllocations(String(connection.guardrails.maxConcurrentAllocations));
    setCostCeiling(formatNanosInput(connection.guardrails.maxSessionCostNanos));
  }, [connection]);

  async function mutate(label: string, operation: () => Promise<unknown>) {
    setBusy(label);
    setError(null);
    try {
      await operation();
      await onChanged();
    } catch (actionError) {
      setError(providerActionError(actionError));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="rounded-xl border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2">
          <Cloud className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm font-semibold">
            {connection.displayName}
          </span>
        </span>
        <Badge variant={connection.state === "active" ? "success" : "warning"}>
          {connection.state.replaceAll("_", " ")}
        </Badge>
      </div>
      <MetaLine
        className="mt-2"
        items={[
          providerLabel(connection.providerKind),
          connection.providerDetails.nativeCurrency,
          `${connection.guardrails.maxConcurrentAllocations} learner VMs max`,
          connection.guardrails.locations.join(" → "),
          connection.lastValidatedAt === null
            ? "not yet checked"
            : `checked ${formatSessionDate(connection.lastValidatedAt)}`,
        ]}
      />
      <p className="mt-2 text-xs text-muted-foreground">
        {connection.guardrails.maxSessionCostNanos === null
          ? "No session cost ceiling"
          : `Session cost ceiling ${formatNativeCost(
              connection.guardrails.maxSessionCostNanos,
              connection.providerDetails.nativeCurrency,
            )}`}
        {connection.credential
          ? ` · credential v${connection.credential.version} ${connection.credential.fingerprint}`
          : " · no active credential"}
      </p>

      {connection.state === "cleanup_pending" ? (
        <div className="mt-3 rounded-lg border border-warning-border bg-warning-subtle p-3">
          <p className="text-xs font-semibold">Manual cleanup required</p>
          <p className="mt-1 text-caption">
            Provider resources are still accumulating cost or could not be
            confirmed deleted. Inspect the dedicated project before recording
            a manual acknowledgement.
          </p>
          {connection.cleanupAcknowledgement ? (
            <p className="mt-2 text-caption">
              Owner recorded an unverified manual-cleanup acknowledgement at{" "}
              {formatSessionDate(
                connection.cleanupAcknowledgement.acknowledgedAt,
              )}
              .
            </p>
          ) : null}
        </div>
      ) : null}

      {role === "owner" ? (
        <div className="mt-4 space-y-3 border-t pt-3">
          {connection.state === "active" ? (
            <details className="text-xs">
              <summary className="w-fit cursor-pointer font-medium">
                Edit guardrails
              </summary>
              <form
                className="mt-3 grid gap-3 sm:grid-cols-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void mutate("guardrails", () =>
                    updateWorkshopProviderGuardrails(
                      organizationId,
                      connection.id,
                      {
                        approvedLocations: parseLocationList(locations),
                        maxConcurrentAllocations: Number(maxAllocations),
                        maxSessionCostNanos: parseNativeNanos(costCeiling),
                      },
                    ),
                  );
                }}
              >
                <label className="space-y-1 font-medium">
                  Location order
                  <Input
                    value={locations}
                    onChange={(event) => setLocations(event.target.value)}
                    required
                  />
                </label>
                <label className="space-y-1 font-medium">
                  Maximum VMs
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    value={maxAllocations}
                    onChange={(event) => setMaxAllocations(event.target.value)}
                    required
                  />
                </label>
                <label className="space-y-1 font-medium">
                  Cost ceiling ({connection.providerDetails.nativeCurrency})
                  <Input
                    inputMode="decimal"
                    placeholder="No ceiling"
                    value={costCeiling}
                    onChange={(event) => setCostCeiling(event.target.value)}
                  />
                </label>
                <div className="sm:col-span-3">
                  <Button
                    size="sm"
                    variant="outline"
                    type="submit"
                    disabled={busy !== null}
                  >
                    {busy === "guardrails" ? "Saving…" : "Save guardrails"}
                  </Button>
                </div>
              </form>
            </details>
          ) : null}

          <details className="text-xs">
            <summary className="w-fit cursor-pointer font-medium">
              {connection.state === "disconnected"
                ? "Reconnect provider"
                : "Rotate credential"}
            </summary>
            <form
              className="mt-3 flex flex-wrap items-end gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                const submittedCredential = credential;
                setCredential("");
                void mutate("credential", () =>
                  rotateWorkshopProviderCredential(
                    organizationId,
                    connection.id,
                    submittedCredential,
                  ),
                );
              }}
            >
              <label className="min-w-64 flex-1 space-y-1 font-medium">
                {connection.providerKind === "gcp_compute"
                  ? "New service-account JSON key"
                  : "New read/write API token"}
                {connection.providerKind === "gcp_compute" ? (
                  <Textarea
                    value={credential}
                    onChange={(event) => setCredential(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    rows={4}
                    required
                  />
                ) : (
                  <Input
                    type="password"
                    value={credential}
                    onChange={(event) => setCredential(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                )}
              </label>
              <Button
                size="sm"
                variant="outline"
                type="submit"
                disabled={busy !== null}
              >
                {busy === "credential"
                  ? "Validating…"
                  : connection.state === "disconnected"
                    ? "Reconnect"
                    : "Submit credential"}
              </Button>
            </form>
          </details>

          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null || connection.state === "disconnected"}
              onClick={() =>
                void mutate("inspect", () =>
                  inspectWorkshopProviderConnection(
                    organizationId,
                    connection.id,
                  ),
                )
              }
            >
              {busy === "inspect" ? "Inspecting…" : "Inspect project"}
            </Button>
            {connection.state === "cleanup_pending" &&
            !connection.cleanupAcknowledgement ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy !== null}
                onClick={() => {
                  if (
                    !window.confirm(
                      `Confirm only after you manually deleted every Intar-owned ${providerLabel(connection.providerKind)} resource. This acknowledgement remains explicitly unverified.`,
                    )
                  ) {
                    return;
                  }
                  void mutate("cleanup", () =>
                    acknowledgeWorkshopProviderManualCleanup(
                      organizationId,
                      connection.id,
                    ),
                  );
                }}
              >
                {busy === "cleanup"
                  ? "Recording…"
                  : "Acknowledge manual cleanup"}
              </Button>
            ) : null}
            {connection.state !== "disconnected" ? (
              <Button
                size="sm"
                variant="destructive"
                disabled={busy !== null}
                onClick={() => {
                  if (
                    !window.confirm(
                      "Disconnect this project? Intar refuses while any learner resource still needs confirmed deletion.",
                    )
                  ) {
                    return;
                  }
                  void mutate("disconnect", () =>
                    disconnectWorkshopProvider(
                      organizationId,
                      connection.id,
                    ),
                  );
                }}
              >
                {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
              </Button>
            ) : null}
          </div>
          {error ? (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function parseLocationList(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
}

function formatNanosInput(value: number | null): string {
  if (value === null) return "";
  const whole = Math.floor(value / 1_000_000_000);
  const fraction = String(value % 1_000_000_000)
    .padStart(9, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

function parseNativeNanos(value: string): number | null {
  const normalized = value.trim();
  if (!normalized) return null;
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,9}))?$/.exec(normalized);
  if (!match) throw new Error("Cost ceiling must use at most nine decimals.");
  const nanos =
    BigInt(match[1]!) * 1_000_000_000n +
    BigInt(((match[2] ?? "") + "000000000").slice(0, 9));
  if (nanos > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Cost ceiling is too large.");
  }
  return Number(nanos);
}

function providerLabel(kind: "hetzner_cloud" | "gcp_compute") {
  return kind === "hetzner_cloud" ? "Hetzner Cloud" : "GCP Compute";
}

function runtimeProviderLabel(
  kind: "agent_kvm" | "hetzner_cloud" | "gcp_compute",
) {
  return kind === "agent_kvm" ? "Organization runner" : providerLabel(kind);
}

function providerActionError(error: unknown): string {
  return error instanceof Error ? error.message : "Provider operation failed";
}

function CapacityLedger({ data }: { data: OrganizationWorkshopsResponse }) {
  return (
    <section
      aria-labelledby="workshop-capacity-heading"
      className="overflow-hidden rounded-xl border bg-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-3 sm:px-4">
        <div>
          <h2
            id="workshop-capacity-heading"
            className="text-section-title"
          >
            Runner capacity
          </h2>
        </div>
        {data.capacity ? (
          <Badge
            variant={
              data.capacity.imagesReady &&
              data.capacity.seatsAvailable >= data.capacity.seatsRequired
                ? "success"
                : "warning"
            }
          >
            {data.capacity.imagesReady ? "Images ready" : "Images warming"}
          </Badge>
        ) : (
          <Badge variant="outline">No live preflight</Badge>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4">
        <CapacityMetric
          icon={<Users />}
          label="Available seats"
          value={
            data.capacity
              ? `${data.capacity.seatsAvailable}/${data.capacity.seatsTotal}`
              : "—"
          }
        />
        <CapacityMetric
          icon={<Server />}
          label="Healthy runners"
          value={data.capacity ? String(data.capacity.healthyRunners) : "—"}
        />
        <CapacityMetric
          icon={<HardDriveDownload />}
          label="Checked in"
          value={data.capacity ? String(data.capacity.checkedIn) : "—"}
        />
        <CapacityMetric
          icon={<CheckCircle2 />}
          label="Provisioned"
          value={data.capacity ? String(data.capacity.provisioned) : "—"}
        />
      </div>
      {data.capacity ? (
        <div className="space-y-3 border-t px-4 py-3 sm:px-4">
          <p className="text-xs text-muted-foreground">
            Each learner reserves {data.capacity.seatResources.cpuMillis}m CPU,{" "}
            {formatWorkshopMib(data.capacity.seatResources.memoryMib)} memory,
            and{" "}
            {formatWorkshopMib(data.capacity.seatResources.worstCaseDiskMib)}{" "}
            worst-case disk.
          </p>
          {data.capacity.runners.length ? (
            <div className="overflow-x-auto rounded-lg border">
              <table className="w-full min-w-[42rem] text-left text-xs">
                <thead className="border-b bg-muted/50 text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2 font-medium">Runner</th>
                    <th className="px-3 py-2 font-medium">Seats</th>
                    <th className="px-3 py-2 font-medium">Images</th>
                    <th className="px-3 py-2 font-medium">Free CPU</th>
                    <th className="px-3 py-2 font-medium">Free memory</th>
                    <th className="px-3 py-2 font-medium">Free disk</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {data.capacity.runners.map((runner) => (
                    <tr key={runner.hostId}>
                      <td className="px-3 py-2 font-mono">{runner.hostId}</td>
                      <td className="px-3 py-2 tabular-nums">
                        {runner.seatsAvailable}/{runner.seatsTotal}
                      </td>
                      <td className="px-3 py-2">
                        {runner.imagesReady
                          ? "Ready"
                          : `Missing ${runner.missingImageVmIds.join(", ")}`}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {runner.available.cpuMillis}m
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {formatWorkshopMib(runner.available.memoryMib)}
                      </td>
                      <td className="px-3 py-2 tabular-nums">
                        {formatWorkshopMib(runner.available.worstCaseDiskMib)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
          {data.capacity.allocationFailures.length ? (
            <div
              className="space-y-2 rounded-lg border border-warning-border bg-warning-subtle p-3"
              role="status"
            >
              <p className="flex items-center gap-2 text-xs font-semibold">
                <CircleAlert className="size-4 text-warning" />
                Allocation blockers
              </p>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {data.capacity.allocationFailures.map((failure) => (
                  <li key={`${failure.hostId}:${failure.reason}`}>
                    <span className="font-mono text-foreground">
                      {failure.hostId}
                    </span>{" "}
                    — {failure.detail}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function formatWorkshopMib(value: number): string {
  return value >= 1024 && value % 1024 === 0
    ? `${value / 1024} GiB`
    : `${value} MiB`;
}

function shortRevision(value: string): string {
  return value.length > 12 ? value.slice(0, 12) : value;
}

function TemplateLedger({
  templates,
}: {
  templates: OrganizationWorkshopTemplate[];
}) {
  return (
    <section aria-labelledby="workshop-templates-heading" className="space-y-3">
      <div>
        <h2 id="workshop-templates-heading" className="text-section-title">
          Workshop templates
        </h2>
      </div>
      {templates.length ? (
        <div className="divide-y overflow-hidden rounded-xl border bg-card">
          {templates.map((template) => (
            <div
              key={template.id}
              className="flex items-start gap-3 px-4 py-3 sm:px-4"
            >
              <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <Presentation className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-card-title">{template.title}</h3>
                  <TemplateStatusBadge status={template.status} />
                </div>
                <p className="mt-1 max-w-[68ch] text-sm text-muted-foreground">
                  {template.summary}
                </p>
                <MetaLine
                  className="mt-2"
                  items={[
                    `${template.currentRevisionId ? "revision" : "staged revision"} ${template.latestRevision}`,
                    `${template.moduleCount} modules`,
                    `${template.durationMinutes} min`,
                    template.slug,
                  ]}
                />
                <details className="mt-3 text-xs">
                  <summary className="w-fit cursor-pointer font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    Revision history ({template.revisionCount})
                  </summary>
                  <ul
                    className="mt-2 divide-y rounded-lg border"
                    aria-label={`${template.title} revisions`}
                  >
                    {template.revisions.map((revision) => (
                      <li
                        key={revision.id}
                        className="grid gap-1 px-3 py-2 sm:grid-cols-[5rem_minmax(0,1fr)_auto] sm:items-center"
                      >
                        <span className="flex items-center gap-2 font-mono font-semibold">
                          r{revision.revision}
                          {revision.current ? (
                            <Badge variant="success">Current</Badge>
                          ) : null}
                        </span>
                        <span className="truncate text-muted-foreground">
                          source {shortRevision(revision.sourceRevision)} ·
                          bundle {revision.contentHash.slice(0, 10)}
                        </span>
                        <span className="text-muted-foreground">
                          {revision.moduleCount} modules ·{" "}
                          {revision.durationMinutes} min
                        </span>
                        <span className="flex flex-wrap gap-1 pt-1 sm:col-span-3">
                          {revision.runtimeProfiles.map((profile) => (
                            <Badge
                              key={profile.id}
                              variant={profile.compatible ? "success" : "outline"}
                            >
                              {profile.profileId} ·{" "}
                              {runtimeProviderLabel(profile.providerKind)}
                              {profile.machineType
                                ? ` · ${profile.machineType}`
                                : ""}
                            </Badge>
                          ))}
                        </span>
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Presentation />}
          title="No private templates"
          description="Publish a validated bundle with intar-workshop-cli before scheduling a session."
          className="shadow-none"
        />
      )}
    </section>
  );
}

function SessionLedger({
  organizationId,
  organizationRole,
  sessions,
  members,
  viewerUserId,
  onRosterUpdated,
}: {
  organizationId: string;
  organizationRole: OrganizationWorkshopsResponse["organization"]["role"];
  sessions: WorkshopSessionSummary[];
  members: OrganizationWorkshopsResponse["members"];
  viewerUserId: string;
  onRosterUpdated: () => Promise<unknown>;
}) {
  const ordered = [...sessions].sort((a, b) => b.startsAt - a.startsAt);
  const [editing, setEditing] = useState<WorkshopSessionSummary | null>(null);
  return (
    <section
      aria-labelledby="organization-sessions-heading"
      className="space-y-3"
    >
      <div>
        <h2
          id="organization-sessions-heading"
          className="text-section-title"
        >
          Sessions
        </h2>
      </div>
      {ordered.length ? (
        <div className="divide-y overflow-hidden rounded-xl border bg-card">
          {ordered.map((session) => (
            <div
              key={session.id}
              className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/45"
            >
              <Link
                to="/workshops/$sessionId"
                params={{ sessionId: session.id }}
                className="group min-w-0 flex-1"
              >
                <span className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-semibold group-hover:underline">
                    {session.title}
                  </span>
                  <Badge
                    variant={session.state === "live" ? "default" : "outline"}
                  >
                    {workshopSessionStateLabel(session.state)}
                  </Badge>
                </span>
                <MetaLine
                  className="mt-1"
                  items={[
                    formatSessionDate(session.startsAt),
                    `${session.participantCount} learners`,
                    session.currentModuleTitle,
                  ]}
                />
                <SessionRuntimeSummary session={session} />
              </Link>
              {session.state === "draft" && session.draftRoster ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setEditing(session)}
                >
                  Edit roster
                </Button>
              ) : null}
              <SessionCostActions
                organizationId={organizationId}
                organizationRole={organizationRole}
                session={session}
                onChanged={onRosterUpdated}
              />
              <ArrowRight className="size-4 text-muted-foreground" />
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Clock3 />}
          title="No sessions scheduled"
          description="Choose a ready template and assign an explicit organization roster."
          className="shadow-none"
        />
      )}
      {editing ? (
        <EditRosterDialog
          session={editing}
          members={members}
          viewerUserId={viewerUserId}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null);
          }}
          onSaved={async () => {
            setEditing(null);
            await onRosterUpdated();
          }}
        />
      ) : null}
    </section>
  );
}

function SessionRuntimeSummary({
  session,
}: {
  session: WorkshopSessionSummary;
}) {
  const provider = session.runtimeProvider;
  if (!provider) return null;
  if (provider.kind === "agent_kvm") {
    return (
      <div className="mt-2 text-xs text-muted-foreground">
        Organization runner · {provider.profileId}
      </div>
    );
  }
  if (!provider.connection) return null;
  const forecast = session.cost?.latestForecast;
  const final = session.cost?.final;
  const live = session.cost?.live;
  const currency =
    final?.currency ??
    live?.currency ??
    forecast?.currency ??
    provider.connection.currency;
  const overCeiling =
    forecast?.exceedsBudgetCeiling === true ||
    live?.overBudgetCeiling === true;
  const overrideAt = provider.grossCeilingOverrideAt;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>
        {providerLabel(provider.kind)} {provider.machineType ?? "VM"} ·{" "}
        {provider.connection.displayName} · {provider.profileId}
      </span>
      {final ? (
        <span>
          Final estimate {formatNativeCost(final.costNanos, currency)}
        </span>
      ) : live ? (
        <span>
          Accrued {formatNativeCost(live.accruedCostNanos, currency)} · projected{" "}
          {formatNativeCost(live.scheduledEndCostNanos, currency)}
        </span>
      ) : forecast ? (
        <span>
          Expected {formatScenarioCost(forecast.expected, currency)}
        </span>
      ) : (
        <span>Cost forecast pending</span>
      )}
      {overCeiling ? (
        <span className={overrideAt === null ? "text-warning" : undefined}>
          {overrideAt === null
            ? "Cost ceiling exceeded"
            : `Owner override recorded ${formatSessionDate(overrideAt)}`}
        </span>
      ) : null}
    </div>
  );
}

function SessionCostActions({
  organizationId,
  organizationRole,
  session,
  onChanged,
}: {
  organizationId: string;
  organizationRole: OrganizationWorkshopsResponse["organization"]["role"];
  session: WorkshopSessionSummary;
  onChanged: () => Promise<unknown>;
}) {
  const [busy, setBusy] = useState<"refresh" | "override" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const provider = session.runtimeProvider;
  if (
    !provider ||
    provider.kind === "agent_kvm" ||
    !provider.connection ||
    organizationRole === "member"
  ) {
    return null;
  }
  const forecast = session.cost?.latestForecast;
  const overCeiling =
    forecast?.exceedsBudgetCeiling === true ||
    session.cost?.live?.overBudgetCeiling === true;
  const terminal = session.state === "ended" || session.state === "cancelled";
  const canOverride =
    organizationRole === "owner" &&
    !terminal &&
    overCeiling &&
    provider.maxSessionCostNanos !== null &&
    provider.grossCeilingOverrideAt === null;

  async function run(
    action: "refresh" | "override",
    operation: () => Promise<unknown>,
  ) {
    setBusy(action);
    setError(null);
    try {
      await operation();
      await onChanged();
    } catch (actionError) {
      setError(providerActionError(actionError));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      {!terminal ? (
        <div className="flex flex-wrap justify-end gap-1.5">
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null || provider.connection.state !== "active"}
            onClick={() =>
              void run("refresh", () =>
                refreshWorkshopCostForecast(organizationId, session.id),
              )
            }
          >
            {busy === "refresh" ? "Refreshing…" : "Refresh cost"}
          </Button>
          {canOverride ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() => {
                if (
                  !window.confirm(
                    "Override this session's cost ceiling? Existing learners keep running either way; this allows new provisioning and restores despite the current estimate.",
                  )
                ) {
                  return;
                }
                void run("override", () =>
                  overrideWorkshopCostCeiling(
                    organizationId,
                    session.id,
                  ),
                );
              }}
            >
              {busy === "override" ? "Overriding…" : "Override ceiling"}
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p
          className="max-w-56 text-right text-caption text-destructive"
          role="alert"
        >
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ScheduleWorkshopDialog({
  open,
  onOpenChange,
  data,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  data: OrganizationWorkshopsResponse;
  onCreated: (sessionId: string) => Promise<void>;
}) {
  const readyTemplates = data.templates.filter(
    (template) => template.revisions.some((revision) => revision.schedulable),
  );
  const revisionOptions = readyTemplates.flatMap((template) =>
    template.revisions
      .filter((revision) => revision.schedulable)
      .map((revision) => ({ template, revision })),
  );
  const [templateRevisionId, setTemplateRevisionId] = useState(
    readyTemplates[0]?.currentRevisionId ??
      revisionOptions[0]?.revision.id ??
      "",
  );
  const [title, setTitle] = useState(readyTemplates[0]?.title ?? "");
  const [startsAt, setStartsAt] = useState(defaultScheduleValue);
  const [runtimeProfileId, setRuntimeProfileId] = useState(
    revisionOptions[0]?.revision.runtimeProfiles.find(
      (profile) => profile.compatible,
    )?.profileId ?? "",
  );
  const [providerConnectionId, setProviderConnectionId] = useState("");
  const [roster, setRoster] = useState<Record<string, RosterChoice>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRoster((current) => {
      if (Object.keys(current).length) return current;
      return Object.fromEntries(
        data.members.map((member) => [
          member.userId,
          member.userId === data.viewer.userId
            ? makeRosterChoice("facilitator")
            : makeRosterChoice("excluded"),
        ]),
      );
    });
  }, [data.members, data.viewer.userId, open]);

  const selectedMembers = Object.entries(roster).flatMap(([userId, choice]) =>
    choice.role === "excluded"
      ? []
      : [
          {
            userId,
            role: choice.role,
            workspaceEnabled:
              choice.role === "participant" || choice.workspaceEnabled,
          },
        ],
  );
  const workspaceCount = selectedMembers.filter(
    (member) => member.workspaceEnabled,
  ).length;
  const selectedRevision = revisionOptions.find(
    (candidate) => candidate.revision.id === templateRevisionId,
  )?.revision;
  const selectedProfile = selectedRevision?.runtimeProfiles.find(
    (profile) => profile.profileId === runtimeProfileId,
  );
  const compatibleConnections = selectedProfile
    ? data.providerConnections.filter(
        (connection) =>
          connection.state === "active" &&
          connection.providerKind === selectedProfile.providerKind &&
          (selectedProfile.certification.connectionId === null ||
            selectedProfile.certification.connectionId === connection.id),
      )
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Schedule a workshop</DialogTitle>
          <DialogDescription>
            Pin a ready template revision and choose every person who may enter
            the room.
          </DialogDescription>
        </DialogHeader>
        {readyTemplates.length ? (
          <form
            id="schedule-workshop-form"
            className="space-y-5"
            onSubmit={async (event) => {
              event.preventDefault();
              setError(null);
              const timestamp = new Date(startsAt).getTime();
              if (!Number.isFinite(timestamp)) {
                setError("Choose a valid start time.");
                return;
              }
              if (!workspaceCount) {
                setError("Choose at least one learner workspace.");
                return;
              }
              if (!selectedProfile?.compatible) {
                setError("Choose a certified runtime profile.");
                return;
              }
              if (
                selectedProfile.providerKind !== "agent_kvm" &&
                !providerConnectionId
              ) {
                setError("Choose a compatible provider connection.");
                return;
              }
              setBusy(true);
              try {
                const response = await createWorkshopSession(
                  data.organization.id,
                  {
                    templateRevisionId,
                    title: title.trim(),
                    startsAt: timestamp,
                    members: selectedMembers,
                    runtimeProvider: {
                      profileId: selectedProfile.profileId,
                      ...(selectedProfile.providerKind === "agent_kvm"
                        ? {}
                        : { connectionId: providerConnectionId }),
                    },
                  },
                );
                onOpenChange(false);
                await onCreated(response.session.id);
              } catch (scheduleError) {
                setError(
                  scheduleError instanceof Error
                    ? scheduleError.message
                    : "Could not schedule the workshop",
                );
              } finally {
                setBusy(false);
              }
            }}
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1.5 text-sm font-medium">
                Template revision
                <NativeSelect
                  value={templateRevisionId}
                  onChange={(event) => {
                    const id = event.target.value;
                    setTemplateRevisionId(id);
                    const selected = revisionOptions.find(
                      (candidate) => candidate.revision.id === id,
                    );
                    if (selected) {
                      setTitle(selected.template.title);
                      setRuntimeProfileId(
                        selected.revision.runtimeProfiles.find(
                          (profile) => profile.compatible,
                        )?.profileId ?? "",
                      );
                      setProviderConnectionId("");
                    }
                  }}
                  className="w-full"
                >
                  {readyTemplates.map((template) => (
                    <optgroup key={template.id} label={template.title}>
                      {template.revisions
                        .filter((revision) => revision.schedulable)
                        .map((revision) => (
                          <option key={revision.id} value={revision.id}>
                            r{revision.revision}
                            {revision.current ? " · current" : ""} ·{" "}
                            {revision.moduleCount} modules ·{" "}
                            {revision.durationMinutes} min
                            {` · ${revision.runtimeProfiles.length} profile${revision.runtimeProfiles.length === 1 ? "" : "s"}`}
                          </option>
                        ))}
                    </optgroup>
                  ))}
                </NativeSelect>
              </label>
              <label className="space-y-1.5 text-sm font-medium">
                Start time
                <Input
                  type="datetime-local"
                  value={startsAt}
                  onChange={(event) => setStartsAt(event.target.value)}
                  required
                />
              </label>
            </div>
            <label className="block space-y-1.5 text-sm font-medium">
              Session title
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                required
                maxLength={120}
              />
            </label>

            <fieldset className="rounded-lg border p-3">
              <legend className="px-1 text-sm font-semibold">
                Learner runtime
              </legend>
              <label className="mt-1 block space-y-1.5 text-sm font-medium">
                Certified runtime profile
                <NativeSelect
                  value={runtimeProfileId}
                  onChange={(event) => {
                    setRuntimeProfileId(event.target.value);
                    setProviderConnectionId("");
                  }}
                  className="w-full"
                  required
                >
                  <option value="" disabled>
                    Choose a certified profile
                  </option>
                  {(selectedRevision?.runtimeProfiles ?? []).map((profile) => (
                    <option
                      key={profile.id}
                      value={profile.profileId}
                      disabled={!profile.compatible}
                    >
                      {profile.profileId} · {runtimeProviderLabel(profile.providerKind)}
                      {profile.machineType ? ` · ${profile.machineType}` : ""}
                      {!profile.compatible ? " · certification pending" : ""}
                    </option>
                  ))}
                </NativeSelect>
              </label>
              {selectedProfile && selectedProfile.providerKind !== "agent_kvm" ? (
                <label className="mt-3 block space-y-1.5 text-sm font-medium">
                  Provider connection
                  <NativeSelect
                    value={providerConnectionId}
                    onChange={(event) =>
                      setProviderConnectionId(event.target.value)
                    }
                    className="w-full"
                    required
                  >
                    <option value="" disabled>
                      Choose a compatible project
                    </option>
                    {compatibleConnections.map((connection) => (
                      <option key={connection.id} value={connection.id}>
                        {connection.displayName} ·{" "}
                        {connection.providerDetails.nativeCurrency}
                      </option>
                    ))}
                  </NativeSelect>
                </label>
              ) : null}
              <p className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
                <Cloud className="mt-0.5 size-3.5 shrink-0" />
                {selectedProfile ? (
                  <span>
                    This immutable revision pins{" "}
                    <strong className="font-medium text-foreground">
                      {selectedProfile.profileId}
                    </strong>
                    {selectedProfile.machineType
                      ? ` (${selectedProfile.machineType})`
                      : ""}
                    . Direct-cloud profiles use one persistent VM per learner
                    and forecast in the provider&apos;s native currency.
                    {selectedProfile.providerKind !== "agent_kvm" &&
                    !compatibleConnections.length
                      ? ` No active ${runtimeProviderLabel(selectedProfile.providerKind)} connection certified for this profile is available.`
                      : ""}
                  </span>
                ) : (
                  <span>
                    Choose one exact certified runtime profile. Intar never
                    substitutes another provider or machine type.
                  </span>
                )}
              </p>
            </fieldset>

            <RosterEditor
              members={data.members}
              viewerUserId={data.viewer.userId}
              roster={roster}
              workspaceCount={workspaceCount}
              onChange={setRoster}
            />
            {error ? (
              <p
                role="alert"
                className="flex items-start gap-2 text-sm text-destructive"
              >
                <CircleAlert className="mt-0.5 size-4 shrink-0" /> {error}
              </p>
            ) : null}
          </form>
        ) : (
          <div className="rounded-lg border border-dashed px-4 py-8 text-center">
            <p className="text-sm font-semibold">No template is ready</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Wait for the checkpoint build and runtime-profile certification
              to finish before scheduling.
            </p>
          </div>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          {readyTemplates.length ? (
            <Button
              type="submit"
              form="schedule-workshop-form"
              disabled={
                busy ||
                !title.trim() ||
                !templateRevisionId ||
                !selectedProfile?.compatible ||
                (selectedProfile.providerKind !== "agent_kvm" &&
                  !providerConnectionId) ||
                workspaceCount === 0
              }
            >
              {busy ? "Scheduling…" : "Schedule workshop"}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EditRosterDialog({
  session,
  members,
  viewerUserId,
  open,
  onOpenChange,
  onSaved,
}: {
  session: WorkshopSessionSummary;
  members: OrganizationWorkshopsResponse["members"];
  viewerUserId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}) {
  const [roster, setRoster] = useState<Record<string, RosterChoice>>(() => {
    const selected = new Map(
      (session.draftRoster ?? []).map((entry) => [
        entry.userId,
        makeRosterChoice(entry.role, entry.workspaceEnabled),
      ]),
    );
    if (!selected.has(viewerUserId)) {
      selected.set(viewerUserId, makeRosterChoice("facilitator"));
    }
    return Object.fromEntries(
      members.map((member) => [
        member.userId,
        selected.get(member.userId) ?? makeRosterChoice("excluded"),
      ]),
    );
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedMembers = Object.entries(roster).flatMap(([userId, choice]) =>
    choice.role === "excluded"
      ? []
      : [
          {
            userId,
            role: choice.role,
            workspaceEnabled:
              choice.role === "participant" || choice.workspaceEnabled,
          },
        ],
  );
  const workspaceCount = selectedMembers.filter(
    (member) => member.workspaceEnabled,
  ).length;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit the draft roster</DialogTitle>
          <DialogDescription>
            Changes are version-checked and lock as soon as the lobby opens or
            workspace provisioning begins.
          </DialogDescription>
        </DialogHeader>
        <form
          id="edit-workshop-roster-form"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!workspaceCount) {
              setError("Choose at least one learner workspace.");
              return;
            }
            setBusy(true);
            setError(null);
            try {
              await mutateWorkshopSession(
                session.id,
                "replace_roster",
                session.version,
                { members: selectedMembers },
              );
              await onSaved();
            } catch (updateError) {
              setError(
                updateError instanceof Error
                  ? updateError.message
                  : "Could not update the roster",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <RosterEditor
            members={members}
            viewerUserId={viewerUserId}
            roster={roster}
            workspaceCount={workspaceCount}
            onChange={setRoster}
          />
          {error ? (
            <p role="alert" className="mt-3 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </form>
        <DialogFooter>
          <Button
            variant="outline"
            type="button"
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="submit"
            form="edit-workshop-roster-form"
            disabled={busy || workspaceCount === 0}
          >
            {busy ? "Saving…" : "Save roster"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RosterEditor({
  members,
  viewerUserId,
  roster,
  workspaceCount,
  onChange,
}: {
  members: OrganizationWorkshopsResponse["members"];
  viewerUserId: string;
  roster: Record<string, RosterChoice>;
  workspaceCount: number;
  onChange: (roster: Record<string, RosterChoice>) => void;
}) {
  return (
    <fieldset>
      <legend className="text-sm font-semibold">Session roster</legend>
      <p className="mt-1 text-xs text-muted-foreground">
        {workspaceCount} learner workspace{workspaceCount === 1 ? "" : "s"} ·
        staff may facilitate and use their own workspace at the same time.
      </p>
      <div className="mt-2 divide-y overflow-hidden rounded-lg border">
        {members.map((member) => {
          const viewer = member.userId === viewerUserId;
          const choice = roster[member.userId] ?? makeRosterChoice("excluded");
          const workspaceEnabled =
            choice.role === "participant" || choice.workspaceEnabled;
          return (
            <div
              key={member.userId}
              className="grid gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_9rem_9rem] sm:items-center sm:py-2"
            >
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">
                  {member.name}
                </span>
                <span className="block truncate text-xs text-muted-foreground">
                  {member.email}
                </span>
              </span>
              <label>
                <span className="sr-only">Role for {member.name}</span>
                <NativeSelect
                  value={choice.role}
                  disabled={viewer}
                  onChange={(event) => {
                    const role = event.target.value as RosterRole;
                    onChange({
                      ...roster,
                      [member.userId]: makeRosterChoice(
                        role,
                        role === "excluded" ? false : choice.workspaceEnabled,
                      ),
                    });
                  }}
                  className="w-full"
                >
                  <option value="participant">Participant</option>
                  <option value="helper">Helper</option>
                  <option value="facilitator">Facilitator</option>
                  <option value="excluded" disabled={viewer}>
                    Not enrolled
                  </option>
                </NativeSelect>
              </label>
              <label
                className={[
                  "flex min-h-9 items-center gap-2 text-sm",
                  choice.role === "excluded"
                    ? "text-muted-foreground opacity-60"
                    : "text-foreground",
                ].join(" ")}
              >
                <input
                  type="checkbox"
                  checked={workspaceEnabled}
                  disabled={
                    choice.role === "excluded" || choice.role === "participant"
                  }
                  onChange={(event) =>
                    onChange({
                      ...roster,
                      [member.userId]: makeRosterChoice(
                        choice.role,
                        event.target.checked,
                      ),
                    })
                  }
                  className="size-4 rounded border-input accent-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40 disabled:cursor-not-allowed"
                />
                <span>Learner workspace</span>
              </label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}

function CapacityMetric({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 border-b px-3 py-3 even:border-l last:border-b-0 sm:border-b-0 sm:border-l-0 sm:border-r sm:last:border-r-0 sm:px-4">
      <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span>
        <span className="block font-mono text-base font-semibold tabular-nums">
          {value}
        </span>
        <span className="block text-xs text-muted-foreground">{label}</span>
      </span>
    </div>
  );
}

function TemplateStatusBadge({
  status,
}: {
  status: OrganizationWorkshopTemplate["status"];
}) {
  if (status === "ready") return <Badge variant="success">Ready</Badge>;
  if (status === "cleanup_pending")
    return <Badge variant="warning">Cleanup pending</Badge>;
  if (status === "failed")
    return <Badge variant="destructive">Publication failed</Badge>;
  return <Badge variant="warning">Building</Badge>;
}

function defaultScheduleValue() {
  const value = new Date();
  value.setDate(value.getDate() + 1);
  value.setHours(9, 0, 0, 0);
  const local = new Date(value.getTime() - value.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function formatSessionDate(at: number) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(at));
}

function formatScenarioCost(
  scenario: WorkshopCostScenario,
  currency: string,
): string {
  if (
    scenario.providerGrossCostNanos !== null &&
    scenario.providerNetCostNanos !== null
  ) {
    return `${formatNativeCost(scenario.providerGrossCostNanos, currency)} gross · ${formatNativeCost(scenario.providerNetCostNanos, currency)} net`;
  }
  return formatNativeCost(scenario.totalCostNanos, currency);
}

function formatNativeCost(nanos: number, currency: string): string {
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(nanos / 1_000_000_000);
}

function OrganizationWorkshopsLoading() {
  return (
    <PageShell width="workspace">
      <div role="status" className="space-y-6">
        <span className="sr-only">Loading organization workshops…</span>
        <Skeleton className="h-20 w-full max-w-2xl" />
        <Skeleton className="h-36 w-full rounded-xl" />
        <div className="grid gap-6 xl:grid-cols-2">
          <Skeleton className="h-80 w-full rounded-xl" />
          <Skeleton className="h-80 w-full rounded-xl" />
        </div>
      </div>
    </PageShell>
  );
}
