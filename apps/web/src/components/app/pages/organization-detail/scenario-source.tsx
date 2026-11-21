import { useId, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRightLeft, GitBranch, Hammer, Library, Pause, Play, Trash2, Unplug } from "lucide-react";
import { apiErrorMessage, describeApiError } from "../../lib/api-errors";
import { CodeBlock } from "../../patterns/CodeBlock";
import { ConfirmDialog } from "../../patterns/ConfirmDialog";
import { Field } from "../../patterns/Field";
import { InlineFeedback } from "../../patterns/InlineFeedback";
import { Section } from "../../patterns/Section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type {
  ScenarioSourceCard as Card,
  ScenarioSourceView,
} from "@/lib/scenario-sources";
import { fetchJson, mutationResponse } from "./types";

/** A binding always shows; otherwise only once this scope may bind one. */
export function scenarioSourceCardVisible(card: Card): boolean {
  return card.source !== null || (card.configured ?? card.enabled);
}

/**
 * The binding of one scope to a GitHub repository. `scope` is the
 * organization's slug, or `public`: the namespace of its labs' ids.
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
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [purgeConfirm, setPurgeConfirm] = useState("");
  // A platform setting whose switch ends work in flight asks first.
  const [confirming, setConfirming] = useState<SettingConfirm | null>(null);
  const change = useMutation({
    mutationFn: async (body: Record<string, string | boolean>) => {
      // A purge deletes a bounded share per request; it is done once the
      // binding is gone. ponytail: 100 rounds, then the button resumes it.
      for (let round = 0; round < 100; round += 1) {
        const response = await fetch(endpoint, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        await mutationResponse(response, "The scenario source could not be changed");
        if (body.action !== "purge") return;
        const { source } = (await response.json()) as { source: ScenarioSourceView | null };
        if (source?.disconnectReason !== "purging") return;
      }
    },
    onSuccess: async () => {
      setDisconnectOpen(false);
      setPurgeOpen(false);
      setConfirming(null);
      await queryClient.invalidateQueries({ queryKey });
    },
  });
  const failure = describeApiError<"repository">(change.error, {
    fallback: "Couldn't change the scenario source. Try again.",
    fields: { repository: /repositor|github|install/i },
  });
  if (!card.data || !scenarioSourceCardVisible(card.data)) return null;
  const { enabled, appSlug, workflowRef, pipelineWorkflowRef } = card.data;
  const source = card.data.source?.disconnectedAt === null ? card.data.source : null;
  const disconnected = card.data.source?.disconnectedAt != null ? card.data.source : null;
  const branch = source?.defaultBranch ?? "main";
  // The builds page lists what builder hosts build: a source whose own
  // pipeline builds its images has nothing there.
  const builderBuilds = card.data.source?.imageProducer === "builder";
  // What the scope's scenarios are filed under: the platform's own name, or
  // the organization's slug.
  const namespace = scope === "public" ? "intar" : scope;
  // A pipeline that builds images needs the workflow's second version and
  // a runner with KVM; the builder's sources call the first.
  const pipelineBuilds = source?.imageProducer === "pipeline";
  const ref = pipelineBuilds ? pipelineWorkflowRef : workflowRef;
  const workflow = `name: Intar\non:\n  push: { branches: [${branch}] }\n  pull_request:\n  workflow_dispatch:\npermissions: { contents: read, id-token: write }\njobs:\n  intar:\n    uses: intar-dev/intar-dev/.github/workflows/scenario-publish.yml@${ref}${
    pipelineBuilds ? "\n    with:\n      runner: your-kvm-runner" : ""
  }`;
  // Connecting a repository can refuse it; the field says why.
  const repositoryError =
    !source && failure?.field === "repository" ? failure.message : null;

  return (
    <Section
      density="compact"
      title="Scenario source"
      description="Merging to the repository's default branch releases its courses here."
      actions={
        <>
          {/* The page of what the repository published: its revisions, and where a lab is verified, promoted and
              rolled back. The platform's card is on that page already. */}
          {scope !== "public" && card.data.source ? (
            <Button size="sm" variant="outline" render={<a href="/admin/scenarios" />}>
              <Library className="size-4" />
              Scenarios
            </Button>
          ) : null}
          {/* The one builds page; it shows organization admins only their builds. */}
          {builderBuilds ? (
            <Button size="sm" variant="outline" render={<a href="/admin/builds" />}>
              <Hammer className="size-4" />
              Builds
            </Button>
          ) : null}
        </>
      }
    >
      <div className="space-y-4 text-sm">
        {source ? (
          <ConnectedSource
            source={source}
            enabled={enabled}
            pending={change.isPending}
            switching={change.isPending && change.variables?.action === "mode"}
            onChange={(body) => change.mutate(body)}
            onDisconnect={() => {
              change.reset();
              setDisconnectOpen(true);
            }}
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
              <li>
                Connect the repository here. Then add the workflow file from “Repository setup” below and push it:
                that push is the first publish.
              </li>
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
        {source && card.data.settings ? (
          <SourceSettings
            source={source}
            enabled={enabled}
            pipelineImages={card.data.pipelineImages}
            settings={card.data.settings}
            pending={change.isPending}
            onChange={(body) => change.mutate(body)}
            onConfirm={(confirm) => {
              change.reset();
              setConfirming(confirm);
            }}
          />
        ) : null}
        {disconnected ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-4">
            <p className="text-muted-foreground">
              {disconnected.disconnectReason === "purging"
                ? `Deleting what ${disconnected.repository} published didn't finish.`
                : `The courses and scenarios ${disconnected.repository} published stay live.`}
            </p>
            <Button
              variant="danger"
              size="sm"
              disabled={change.isPending}
              onClick={() => {
                change.reset();
                setPurgeConfirm("");
                setPurgeOpen(true);
              }}
            >
              <Trash2 className="size-4" />
              {disconnected.disconnectReason === "purging"
                ? "Finish deleting"
                : "Delete courses and scenarios"}
            </Button>
          </div>
        ) : null}
        {failure && !repositoryError ? (
          <InlineFeedback tone="error">{failure.message}</InlineFeedback>
        ) : null}
        <details>
          <summary className="cursor-pointer font-medium">
            Repository setup
          </summary>
          <p className="mt-2 text-muted-foreground">
            <code>intar.hcl</code> at the repository root:
          </p>
          <Snippet language="hcl">{"repository {}"}</Snippet>
          <p className="mt-2 text-muted-foreground">
            Each lab is a file <code>scenarios/&lt;name&gt;/scenario.hcl</code>, and an image several labs build on is{" "}
            <code>images/&lt;name&gt;.hcl</code>. A lab's id here is <code>{namespace}/&lt;name&gt;</code>: the
            repository does not choose the part before the slash.
          </p>
          <p className="mt-2 text-muted-foreground">
            {source?.mode === "pull" ? (
              <>
                <code>.github/workflows/intar.yml</code>. While Intar fetches the repository itself, keep only{" "}
                <code>pull_request</code>, to validate pull requests.
              </>
            ) : (
              <>
                <code>.github/workflows/intar.yml</code>: a push to the default branch publishes, and a pull request is
                validated.
              </>
            )}
          </p>
          {ref === null ? (
            <p className="mt-2 text-muted-foreground">
              This repository's pipeline builds its images, which needs the workflow's second version. It has no
              released tag yet: call it at the commit Intar's operators name, with <code>runner</code> set to a Linux
              amd64 runner with KVM and Docker, where the job may run as root.
            </p>
          ) : (
            <Snippet>{workflow}</Snippet>
          )}
          {pipelineBuilds && ref !== null ? (
            <p className="mt-2 text-muted-foreground">
              The image builds need a Linux amd64 runner with KVM and Docker, where the job may run as root: put its
              label in <code>runner</code>.
              {source?.allowSelfHostedRunners
                ? " This source accepts a self-hosted runner."
                : " This source accepts GitHub-hosted runners only; a self-hosted one publishes once this source's runner setting allows it."}
            </p>
          ) : null}
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
      <ConfirmDialog
        open={confirming !== null}
        onClose={() => {
          setConfirming(null);
          change.reset();
        }}
        title={confirming?.title ?? ""}
        description={confirming?.description ?? ""}
        error={apiErrorMessage(change.error, "Couldn't change the setting. Try again.")}
        pending={change.isPending}
        confirmLabel={confirming?.label ?? ""}
        pendingLabel="Switching…"
        onConfirm={() => {
          if (confirming) change.mutate(confirming.body);
        }}
      />
      <ConfirmDialog
        open={purgeOpen}
        onClose={() => {
          setPurgeOpen(false);
          change.reset();
        }}
        title="Delete courses and scenarios?"
        description={`This permanently deletes the courses, scenarios, images and builds ${disconnected?.repository ?? "the repository"} published, every run of those scenarios and the learners' progress. Type the repository name to confirm.`}
        error={apiErrorMessage(
          change.error,
          "Couldn't delete the courses and scenarios. Try again.",
        )}
        pending={change.isPending}
        confirmLabel="Delete everything"
        pendingLabel="Deleting…"
        confirmDisabled={purgeConfirm !== disconnected?.repository}
        onConfirm={() => change.mutate({ action: "purge" })}
      >
        <Input
          value={purgeConfirm}
          onChange={(event) => setPurgeConfirm(event.target.value)}
          aria-label="Repository name confirmation"
          className="text-code"
          autoComplete="off"
          spellCheck={false}
        />
      </ConfirmDialog>
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
  switching,
  onChange,
  onDisconnect,
}: {
  source: ScenarioSourceView;
  enabled: boolean;
  pending: boolean;
  /** The change of mode is the one being saved. */
  switching: boolean;
  onChange: (body: Record<string, string | boolean>) => void;
  onDisconnect: () => void;
}) {
  const commit = source.commit;
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
      {source.mode === "pull" ? (
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-muted-foreground">
            Intar fetches this repository and compiles it on its builder. To publish from the repository's own
            workflow, switch to push first, then commit the workflow file from “Repository setup” below: that commit
            is the first publish.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={!enabled || pending}
            onClick={() => onChange({ action: "mode", mode: "push" })}
          >
            <ArrowRightLeft className="size-4" />
            {switching ? "Switching…" : "Switch to push"}
          </Button>
        </div>
      ) : null}
      <dl className="grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-label">Images</dt>
          <dd className="mt-1">
            {source.imageProducer === "pipeline" ? "Built by this repository's pipeline" : "Built by Intar's builder"}
          </dd>
        </div>
        <div>
          <dt className="text-label">Going live</dt>
          <dd className="mt-1">
            {source.promotion === "automatic"
              ? "Each lab goes live once it passed its check"
              : "An administrator promotes each lab"}
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
            ) : source.mode === "push" ? (
              "Waiting for the first workflow run"
            ) : (
              "None yet"
            )}
          </dd>
        </div>
      </dl>
      {commit?.detail ? <p className="text-muted-foreground">{commit.detail}</p> : null}
      {commit?.diagnostics.length ? (
        <ul className="space-y-1 font-mono text-xs">
          {commit?.diagnostics.map((entry, index) => (
            <li key={`diagnostic-${index}`} className="break-words">
              {entry.path ? `${entry.path}${entry.line ? `:${entry.line}` : ""}: ` : ""}
              {entry.message}
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

/** A switch of a platform setting that is asked about first. */
interface SettingConfirm {
  title: string;
  description: string;
  /** The row's own action, which is also the dialog's confirm. */
  label: string;
  body: Record<string, string | boolean>;
}

/**
 * What an administrator of the source's scope changes on it: who builds its
 * images, which runners may publish, who puts its labs live, and the way
 * back to pull mode. Each row says what is and offers the other; a switch
 * that would be refused says why instead.
 */
function SourceSettings({
  source,
  enabled,
  pipelineImages,
  settings,
  pending,
  onChange,
  onConfirm,
}: {
  source: ScenarioSourceView;
  /** The scope's flag for connecting and widening a source. */
  enabled: boolean;
  pipelineImages: boolean;
  settings: NonNullable<Card["settings"]>;
  pending: boolean;
  onChange: (body: Record<string, string | boolean>) => void;
  onConfirm: (confirm: SettingConfirm) => void;
}) {
  const reasonId = useId();
  const { platform, automaticPromotion, publicPlay } = settings;
  // The platform's card is its operators'; an organization's is its own
  // administrators', who have no builder to choose and no pull mode.
  const here = platform ? "this scope" : "this organization";
  const pipeline = source.imageProducer === "pipeline";
  const automatic = source.promotion === "automatic";
  const rows: Array<{ label: string; state: string; action: string | null; blocked: string | null; onClick: () => void }> = [
    {
      label: "Images",
      state: pipeline ? "This repository's pipeline builds them" : "Intar's builder builds them",
      // An organization is not offered the way back to the builder (#472): the
      // platform steps it back. The server would take it, as it builds for any
      // organization that has no pipeline.
      action: pipeline ? (platform ? "Use Intar's builder" : null) : "Use the repository's pipeline",
      blocked: pipeline
        ? null
        : source.mode !== "push"
          ? "A pipeline builds only for a source in push mode."
          : pipelineImages ? null : `Pipeline images are not switched on for ${here}.`,
      onClick: () => onChange({ action: "image_producer", producer: pipeline ? "builder" : "pipeline" }),
    },
    {
      label: "Runners",
      state: source.allowSelfHostedRunners ? "Self-hosted runners may publish" : "Only GitHub-hosted runners may publish",
      action: source.allowSelfHostedRunners ? "Allow GitHub-hosted runners only" : "Allow self-hosted runners",
      blocked: source.allowSelfHostedRunners || enabled ? null : `Scenario sources are not switched on for ${here}.`,
      onClick: () => onChange({ action: "runner_policy", allow_self_hosted: !source.allowSelfHostedRunners }),
    },
    {
      label: "Going live",
      state: automatic ? "Each lab goes live once it passed its check" : "An administrator promotes each lab",
      action: automatic ? "Promote by hand" : "Go live automatically",
      blocked: automatic
        ? null
        : publicPlay
          ? "This organization's play labs are open to everyone, so its labs are promoted by hand."
          : automaticPromotion ? null : `Automatic promotion is not switched on for ${here}.`,
      onClick: () => onConfirm(automatic
        ? {
            title: "Promote by hand again?",
            description: "Checks of the latest commit that are running stop, and its labs that are not live yet wait for an administrator to verify and promote them, or for its workflow to be run again after switching back. What is live stays live.",
            label: "Promote by hand",
            body: { action: "promotion", promotion: "manual" },
          }
        : {
            title: "Let labs go live by themselves?",
            description: "From the next commit on, each lab that passes its check on a platform host goes live without an administrator, and the commit's course catalog and removed labs follow. The commit that is the head now stays as it is, unless its workflow is run again. Whoever can push to the default branch then publishes to learners.",
            label: "Go live automatically",
            body: { action: "promotion", promotion: "automatic" },
          }),
    },
    ...(platform && source.mode === "push"
      ? [{
          label: "Delivery",
          state: "The repository's workflow pushes each commit",
          action: "Switch to pull",
          blocked: pipeline
            ? "Set the images back to Intar's builder first."
            : enabled ? null : `Scenario sources are not switched on for ${here}.`,
          onClick: () => onConfirm({
            title: "Switch to pull?",
            description: "Intar fetches the repository itself again and compiles it on its builder. The repository's publish workflow is refused from then on and fails until the source is switched back to push.",
            label: "Switch to pull",
            body: { action: "mode", mode: "pull" },
          }),
        }]
      : []),
  ];
  return (
    <div className="space-y-3 border-t pt-4">
      <h3 className="font-medium">{platform ? "Platform settings" : "Source settings"}</h3>
      <ul className="space-y-3">
        {rows.map((row) => (
          <li key={row.label} className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-label">{row.label}</p>
              <p>{row.state}</p>
              {row.blocked ? (
                <p id={`${reasonId}-${row.label}`} className="text-muted-foreground">
                  {row.blocked}
                </p>
              ) : null}
            </div>
            {row.action === null ? null : (
              <Button
                size="sm"
                variant="outline"
                disabled={pending || row.blocked !== null}
                aria-describedby={row.blocked ? `${reasonId}-${row.label}` : undefined}
                onClick={row.onClick}
              >
                {row.action}
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Snippet({ children, language = "yaml" }: { children: string; language?: string }) {
  return (
    <CodeBlock language={language} copyName="Copy the snippet" className="mt-2">
      {children}
    </CodeBlock>
  );
}
