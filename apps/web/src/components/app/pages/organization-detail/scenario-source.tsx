import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { GitBranch, Hammer, Pause, Play, Unplug } from "lucide-react";
import { apiErrorMessage, describeApiError } from "../../lib/api-errors";
import { CodeBlock } from "../../patterns/CodeBlock";
import { ConfirmDialog } from "../../patterns/ConfirmDialog";
import { Field } from "../../patterns/Field";
import { InlineFeedback } from "../../patterns/InlineFeedback";
import { Section } from "../../patterns/Section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import type {
  ScenarioSourceCard as Card,
  ScenarioSourceView,
} from "@/lib/scenario-sources";
import { fetchJson, mutationResponse } from "./types";

const MODE_NOTE =
  "Pull mode copies the whole repository archive to Intar for each deployed commit. Push mode sends only the compiled course bundle.";

/** A binding always shows; otherwise only once this scope may bind one. */
export function scenarioSourceCardVisible(card: Card): boolean {
  return card.source !== null || (card.configured ?? card.enabled);
}

/**
 * The binding of one scope to a GitHub repository. `scope` is the value its
 * intar.yaml must name: the organization slug, or `public`.
 */
export function ScenarioSourceSection({
  endpoint,
  scope,
}: {
  endpoint: string;
  scope: string;
}) {
  const queryClient = useQueryClient();
  const queryKey = ["scenario-source", endpoint];
  const card = useQuery({ queryKey, queryFn: () => fetchJson<Card>(endpoint) });
  const [repository, setRepository] = useState("");
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const change = useMutation({
    mutationFn: async (body: Record<string, string>) => {
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      await mutationResponse(response, "The scenario source could not be changed");
    },
    onSuccess: async () => {
      setDisconnectOpen(false);
      await queryClient.invalidateQueries({ queryKey });
    },
  });
  const failure = describeApiError<"repository">(change.error, {
    fallback: "Couldn't change the scenario source. Try again.",
    fields: { repository: /repositor|github|install/i },
  });
  if (!card.data || !scenarioSourceCardVisible(card.data)) return null;
  const { enabled, appSlug } = card.data;
  const source = card.data.source?.disconnectedAt === null ? card.data.source : null;
  const branch = source?.defaultBranch ?? "main";
  // Connecting a repository can refuse it; the field says why.
  const repositoryError =
    !source && failure?.field === "repository" ? failure.message : null;

  return (
    <Section
      density="compact"
      title="Scenario source"
      description="Merging to the repository's default branch releases its courses here."
      actions={
        // The one builds page; it shows organization admins only their builds.
        <Button size="sm" variant="outline" render={<a href="/admin/builds" />}>
          <Hammer className="size-4" />
          Builds
        </Button>
      }
    >
      <div className="space-y-4 text-sm">
        {source ? (
          <ConnectedSource
            source={source}
            enabled={enabled}
            pending={change.isPending}
            pendingMode={change.isPending ? change.variables?.mode : undefined}
            onChange={(body) => change.mutate(body)}
            onDisconnect={() => setDisconnectOpen(true)}
          />
        ) : (
          <>
            <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>
                Connect your GitHub account in your{" "}
                <a className="text-brand-text underline" href="/profile">
                  profile
                </a>
                . You must be an admin of the repository.
              </li>
              <li>
                Install the{" "}
                {appSlug ? (
                  <a
                    className="text-brand-text underline"
                    href={`https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`}
                  >
                    Intar GitHub App
                  </a>
                ) : (
                  "Intar GitHub App"
                )}{" "}
                on the repository with “Only select repositories”.
              </li>
              <li>Push at least one commit to the repository's default branch.</li>
            </ol>
            <form
              className="space-y-3"
              onSubmit={(event) => {
                event.preventDefault();
                if (!change.isPending) {
                  change.mutate({ action: "connect", repository });
                }
              }}
            >
              <Field label="GitHub repository" error={repositoryError}>
                {(control) => (
                  <Input
                    {...control}
                    value={repository}
                    onChange={(event) => {
                      setRepository(event.target.value);
                      if (repositoryError) change.reset();
                    }}
                    placeholder="owner/repository"
                    className="text-code"
                    autoComplete="off"
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                  />
                )}
              </Field>
              <Button
                type="submit"
                disabled={!enabled || !repository.trim() || change.isPending}
              >
                <GitBranch className="size-4" />
                {change.isPending ? "Connecting…" : "Connect repository"}
              </Button>
            </form>
          </>
        )}
        {failure && !repositoryError ? (
          <InlineFeedback tone="error">{failure.message}</InlineFeedback>
        ) : null}
        <p className="text-muted-foreground">{MODE_NOTE}</p>
        <details>
          <summary className="cursor-pointer font-medium">
            Repository setup
          </summary>
          <p className="mt-2 text-muted-foreground">
            <code>intar.yaml</code> at the repository root:
          </p>
          <Snippet>{`version: 1\nscope: ${scope}\ncourses_root: courses`}</Snippet>
          {scope === "public" ? null : (
            <p className="mt-2 text-muted-foreground">
              Scenario ids must start with <code>{scope}-</code>.
            </p>
          )}
          <p className="mt-2 text-muted-foreground">
            <code>.github/workflows/intar.yml</code>, required in push mode.
            In pull mode keep only <code>pull_request</code> to validate pull
            requests.
          </p>
          <Snippet>
            {`name: Intar\non:\n  push: { branches: [${branch}] }\n  pull_request:\n  workflow_dispatch:\npermissions: { contents: read, id-token: write }\njobs:\n  intar:\n    uses: intar-dev/intar-dev/.github/workflows/scenario-publish.yml@scenario-publish-v1`}
          </Snippet>
        </details>
      </div>
      <ConfirmDialog
        open={disconnectOpen}
        onClose={() => {
          setDisconnectOpen(false);
          change.reset();
        }}
        title="Disconnect the repository?"
        description="Updates stop and the live courses stay. Connecting a repository again keeps them live until its first deploy."
        error={apiErrorMessage(
          change.error,
          "Couldn't disconnect the repository. Try again.",
        )}
        pending={change.isPending}
        confirmLabel="Disconnect"
        pendingLabel="Disconnecting…"
        onConfirm={() => change.mutate({ action: "disconnect" })}
      />
    </Section>
  );
}

const PAUSE_LABELS = {
  admin: "Paused",
  binder_lost_admin: "Reconnect required",
  suspended: "App suspended",
} as const;

function ConnectedSource({
  source,
  enabled,
  pending,
  pendingMode,
  onChange,
  onDisconnect,
}: {
  source: ScenarioSourceView;
  enabled: boolean;
  pending: boolean;
  /** The mode being saved, so the select holds it instead of snapping back. */
  pendingMode: string | undefined;
  onChange: (body: Record<string, string>) => void;
  onDisconnect: () => void;
}) {
  const commit = source.commit;
  const modeId = useId();
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">
          Connected{" "}
          <code className="text-code">
            {source.repository} @ {source.defaultBranch}
          </code>
        </span>
        <Badge variant={source.pauseReason ? "warning" : "success"}>
          {source.pauseReason ? PAUSE_LABELS[source.pauseReason] : "Active"}
        </Badge>
      </div>
      <dl className="grid gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-label">
            <label htmlFor={modeId}>Delivery mode</label>
          </dt>
          <dd className="mt-1">
            <NativeSelect
              id={modeId}
              value={pendingMode ?? source.mode}
              disabled={!enabled}
              aria-disabled={pending || undefined}
              onChange={(event) => {
                if (pending) return;
                onChange({ action: "mode", mode: event.target.value });
              }}
            >
              <option value="pull">Pull</option>
              <option value="push">Push</option>
            </NativeSelect>
          </dd>
        </div>
        <div>
          <dt className="text-label">Live commit</dt>
          <dd className="mt-1">
            {source.liveSha ? (
              <code className="text-code">{source.liveSha.slice(0, 12)}</code>
            ) : (
              "None yet"
            )}
          </dd>
        </div>
        <div>
          <dt className="text-label">Latest commit</dt>
          <dd className="mt-1">
            {commit ? (
              <>
                <code className="text-code">{commit.sha.slice(0, 12)}</code>{" "}
                {commit.state.replace("_", " ")}
              </>
            ) : (
              "None yet"
            )}
          </dd>
        </div>
      </dl>
      {commit?.detail ? <p className="text-muted-foreground">{commit.detail}</p> : null}
      {commit?.diagnostics.length || source.builds.length ? (
        <ul className="space-y-1 font-mono text-xs">
          {commit?.diagnostics.map((entry, index) => (
            <li key={`diagnostic-${index}`} className="break-words">
              {entry.path ? `${entry.path}${entry.line ? `:${entry.line}` : ""}: ` : ""}
              {entry.message}
            </li>
          ))}
          {source.builds.map((build) => (
            <li key={`${build.scenarioId}-${build.arch}`} className="break-words">
              {build.scenarioId} ({build.arch}): {build.status}, {build.phase}
              {build.error ? ` — ${build.error}` : ""}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {/* An admin pause replaces a suspension, so a later unsuspend does not resume. */}
        {source.pausedAt === null || source.pauseReason === "suspended" ? (
          <Button variant="outline" disabled={pending} onClick={() => onChange({ action: "pause" })}>
            <Pause className="size-4" />
            Pause
          </Button>
        ) : null}
        {source.pausedAt === null ? null : (
          <Button
            variant="outline"
            disabled={!enabled || pending}
            onClick={() => onChange({ action: "resume" })}
          >
            <Play className="size-4" />
            Resume
          </Button>
        )}
        <Button variant="ghost" disabled={pending} onClick={onDisconnect}>
          <Unplug className="size-4" />
          Disconnect
        </Button>
      </div>
    </>
  );
}

function Snippet({ children }: { children: string }) {
  return (
    <CodeBlock language="yaml" copyName="Copy the snippet" className="mt-2">
      {children}
    </CodeBlock>
  );
}
