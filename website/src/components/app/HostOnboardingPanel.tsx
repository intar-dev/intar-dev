import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Hammer, Server } from "lucide-react";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

export type HostRole = "agent" | "builder";

export interface AgentOnboardingResponse {
  host: {
    id: string;
    name: string;
    role: HostRole;
    disabled: boolean;
    scenarioEnabled: boolean;
    createdAt: number;
  };
  bootstrapTokenExpiresAt: string | null;
  bridgeConfigToml: string;
}

interface HostOnboardingPanelProps {
  eyebrow?: string;
  title?: string;
  endpoint?: string;
  allowedRoles?: readonly HostRole[];
  defaultHostName?: string;
  onGenerated?: (result: AgentOnboardingResponse) => void;
}

export function HostOnboardingPanel({
  eyebrow = "Host onboarding",
  title = "Bridge config",
  endpoint = "/api/agent/hosts",
  allowedRoles = ["agent", "builder"],
  defaultHostName = "dedicated-host",
  onGenerated,
}: HostOnboardingPanelProps) {
  const [hostName, setHostName] = useState(defaultHostName);
  const [hostRole, setHostRole] = useState<HostRole>(
    allowedRoles[0] ?? "agent",
  );
  const [generated, setGenerated] = useState<AgentOnboardingResponse | null>(
    null,
  );
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  const onboard = useMutation({
    mutationFn: async () => {
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: hostName.trim() || undefined,
          role: hostRole,
        }),
      });

      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Onboarding failed (${response.status})`,
        );
      }

      return (await response.json()) as AgentOnboardingResponse;
    },
    onSuccess: (result) => {
      setGenerated(result);
      setCopyFeedback(null);
      onGenerated?.(result);
    },
  });

  const copyGeneratedConfig = async () => {
    if (!generated?.bridgeConfigToml) return;
    if (typeof navigator === "undefined" || !navigator.clipboard) {
      setCopyFeedback("Clipboard unavailable");
      return;
    }

    try {
      await navigator.clipboard.writeText(generated.bridgeConfigToml);
      setCopyFeedback("Configuration copied.");
    } catch {
      setCopyFeedback("Configuration could not be copied.");
    }
  };

  return (
    <section className="grid gap-6 xl:grid-cols-[minmax(0,0.88fr)_minmax(0,1.12fr)]">
      <div className="space-y-4 rounded-2xl border bg-card p-6 shadow-xs">
        <div className="space-y-2">
          <p className="text-eyebrow">{eyebrow}</p>
          <h2 className="text-section-title">{title}</h2>
        </div>

        {allowedRoles.length > 1 ? (
          <div
            role="group"
            aria-label="Host role"
            className="grid gap-2 sm:grid-cols-2"
          >
            {allowedRoles.includes("agent") ? (
              <Button
                type="button"
                aria-pressed={hostRole === "agent"}
                variant={hostRole === "agent" ? "default" : "outline"}
                onClick={() => setHostRole("agent")}
                disabled={onboard.isPending}
                className="justify-start"
              >
                <Server className="size-4" />
                Agent
              </Button>
            ) : null}
            {allowedRoles.includes("builder") ? (
              <Button
                type="button"
                aria-pressed={hostRole === "builder"}
                variant={hostRole === "builder" ? "default" : "outline"}
                onClick={() => setHostRole("builder")}
                disabled={onboard.isPending}
                className="justify-start"
              >
                <Hammer className="size-4" />
                Builder
              </Button>
            ) : null}
          </div>
        ) : null}

        <form
          className="flex flex-col gap-3 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            onboard.mutate();
          }}
        >
          <label htmlFor="host-onboarding-name" className="sr-only">
            Host name
          </label>
          <Input
            id="host-onboarding-name"
            name="hostName"
            placeholder="Host name"
            value={hostName}
            onChange={(event) => setHostName(event.currentTarget.value)}
            disabled={onboard.isPending}
            className="flex-1"
          />
          <Button type="submit" disabled={onboard.isPending}>
            {onboard.isPending ? "Generating..." : "Generate"}
          </Button>
        </form>

        {onboard.error ? (
          <Alert variant="destructive">
            <AlertTitle>Onboarding failed</AlertTitle>
            <AlertDescription>
              {onboard.error instanceof Error
                ? onboard.error.message
                : "Onboarding failed"}
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-4">
          <div className="rounded-xl bg-muted/40 px-4 py-3">
            Host name
            <div className="mt-1 font-medium text-foreground">
              {hostName.trim() || defaultHostName}
            </div>
          </div>
          <div className="rounded-xl bg-muted/40 px-4 py-3">
            Role
            <div className="mt-1 font-medium capitalize text-foreground">
              {hostRole}
            </div>
          </div>
          <div className="rounded-xl bg-muted/40 px-4 py-3">
            Output
            <div className="mt-1 font-medium text-foreground">
              <code>config.toml</code>
            </div>
          </div>
          <div className="rounded-xl bg-muted/40 px-4 py-3">
            Install
            <div className="mt-1 font-medium text-foreground">
              <code>
                {hostRole === "builder" ? "intar-builder" : "intar-agent"}
              </code>
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border bg-card p-6 shadow-xs">
        {generated ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                <div>
                  <dt className="text-eyebrow">Host ID</dt>
                  <dd className="mt-1 font-mono text-xs break-all">
                    {generated.host.id}
                  </dd>
                </div>
                <div>
                  <dt className="text-eyebrow">Role</dt>
                  <dd className="mt-1 font-medium capitalize">
                    {generated.host.role}
                  </dd>
                </div>
                <div>
                  <dt className="text-eyebrow">Bootstrap access</dt>
                  <dd className="mt-1 font-medium">
                    {generated.bootstrapTokenExpiresAt
                      ? `Until ${new Date(generated.bootstrapTokenExpiresAt).toLocaleString()}`
                      : "Until rotated or revoked"}
                  </dd>
                </div>
              </dl>
              <Button
                type="button"
                variant="outline"
                onClick={copyGeneratedConfig}
              >
                Copy config
              </Button>
            </div>

            {copyFeedback ? (
              <InlineFeedback
                tone={
                  copyFeedback === "Configuration copied." ? "success" : "error"
                }
              >
                {copyFeedback}
              </InlineFeedback>
            ) : null}

            <ScrollArea className="h-[24rem] rounded-xl border bg-muted/30">
              <pre className="p-4 text-xs leading-6 text-foreground">
                <code>{generated.bridgeConfigToml}</code>
              </pre>
            </ScrollArea>

            <ol className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-3">
              <li className="rounded-xl bg-muted/40 px-4 py-3">
                Replace <code>[bridge]</code> in{" "}
                <code>
                  {generated.host.role === "builder"
                    ? "/etc/intar-builder/config.toml"
                    : "/etc/intar-agent/config.toml"}
                </code>
              </li>
              <li className="rounded-xl bg-muted/40 px-4 py-3">
                Restart with{" "}
                <code>
                  {generated.host.role === "builder"
                    ? "sudo systemctl restart intar-builder"
                    : "sudo systemctl restart intar-agent"}
                </code>
              </li>
              <li className="rounded-xl bg-muted/40 px-4 py-3">
                Confirm the heartbeat in the runner list.
              </li>
            </ol>
          </div>
        ) : (
          <div className="flex min-h-[24rem] items-center justify-center rounded-xl bg-muted/40 px-6 text-center text-sm text-muted-foreground">
            Generate a host config to reveal the bridge block and install steps.
          </div>
        )}
      </div>
    </section>
  );
}
