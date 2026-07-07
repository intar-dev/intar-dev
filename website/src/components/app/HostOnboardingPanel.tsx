import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Hammer, Server } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

type HostRole = "agent" | "builder";

export interface AgentOnboardingResponse {
  host: {
    id: string;
    name: string;
    role: HostRole;
    disabled: boolean;
    scenarioEnabled: boolean;
    createdAt: number;
  };
  bootstrapTokenExpiresAt: string;
  bridgeConfigToml: string;
}

interface HostOnboardingPanelProps {
  eyebrow?: string;
  title?: string;
  onGenerated?: (result: AgentOnboardingResponse) => void;
}

export function HostOnboardingPanel({
  eyebrow = "Host onboarding",
  title = "Bridge config",
  onGenerated,
}: HostOnboardingPanelProps) {
  const [hostName, setHostName] = useState("dedicated-host");
  const [hostRole, setHostRole] = useState<HostRole>("agent");
  const [generated, setGenerated] = useState<AgentOnboardingResponse | null>(
    null,
  );
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  const onboard = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/agent/hosts", {
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
      setCopyFeedback("Copied");
    } catch {
      setCopyFeedback("Copy failed");
    }
  };

  return (
    <section className="grid gap-6 xl:grid-cols-[minmax(0,0.88fr)_minmax(0,1.12fr)]">
      <div className="space-y-4 rounded-2xl border bg-card p-6 shadow-xs">
        <div className="space-y-2">
          <p className="text-eyebrow">
            {eyebrow}
          </p>
          <h2 className="text-section-title">{title}</h2>
        </div>

        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            type="button"
            variant={hostRole === "agent" ? "default" : "outline"}
            onClick={() => setHostRole("agent")}
            disabled={onboard.isPending}
            className="justify-start"
          >
            <Server className="size-4" />
            Agent
          </Button>
          <Button
            type="button"
            variant={hostRole === "builder" ? "default" : "outline"}
            onClick={() => setHostRole("builder")}
            disabled={onboard.isPending}
            className="justify-start"
          >
            <Hammer className="size-4" />
            Builder
          </Button>
        </div>

        <form
          className="flex flex-col gap-3 sm:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            onboard.mutate();
          }}
        >
          <Input
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
              {hostName.trim() || "dedicated-host"}
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
            <div className="mt-1 font-medium text-foreground">`config.toml`</div>
          </div>
          <div className="rounded-xl bg-muted/40 px-4 py-3">
            Install
            <div className="mt-1 font-medium text-foreground">
              `{hostRole === "builder" ? "intar-builder" : "intar-agent"}`
            </div>
          </div>
        </div>
      </div>

      <div className="rounded-2xl border bg-card p-6 shadow-xs">
        {generated ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="flex flex-wrap gap-2">
                <Badge variant="secondary">{generated.host.id}</Badge>
                <Badge variant="outline" className="capitalize">
                  {generated.host.role}
                </Badge>
                <Badge variant="outline">
                  Expires{" "}
                  {new Date(generated.bootstrapTokenExpiresAt).toLocaleString()}
                </Badge>
                {copyFeedback ? (
                  <Badge variant="outline">{copyFeedback}</Badge>
                ) : null}
              </div>
              <Button type="button" variant="outline" onClick={copyGeneratedConfig}>
                Copy config
              </Button>
            </div>

            <ScrollArea className="h-[24rem] rounded-xl border bg-muted/30">
              <pre className="p-4 text-xs leading-6 text-foreground">
                <code>{generated.bridgeConfigToml}</code>
              </pre>
            </ScrollArea>

            <ol className="grid gap-3 text-sm text-muted-foreground sm:grid-cols-3">
              <li className="rounded-xl bg-muted/40 px-4 py-3">
                Replace `[bridge]` in{" "}
                {generated.host.role === "builder"
                  ? "`/etc/intar-builder/config.toml`"
                  : "`/etc/intar-agent/config.toml`"}
              </li>
              <li className="rounded-xl bg-muted/40 px-4 py-3">
                Restart with{" "}
                {generated.host.role === "builder"
                  ? "`sudo systemctl restart intar-builder`"
                  : "`sudo systemctl restart intar-agent`"}
              </li>
              <li className="rounded-xl bg-muted/40 px-4 py-3">
                Confirm the heartbeat in the Hosts tab.
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
