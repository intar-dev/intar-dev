import { useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { ArrowRight, SearchX } from "lucide-react";
import { BrandMark } from "@/components/app/patterns/BrandMark";
import { InlineFeedback } from "@/components/app/patterns/InlineFeedback";
import { MetaLine } from "@/components/app/patterns/MetaLine";
import { Skeleton } from "@/components/ui/skeleton";
import { StartLabConfirm } from "@/components/app/run/StartLabConfirm";
import { formatMinutes, sentenceCase } from "@/components/app/lib/format";
import {
  requestScenarioStartWithCapacityWait,
  ScenarioStartCancelledError,
} from "@/components/app/lib/scenario-start";
import { useSessionAccess } from "@/components/app/hooks/useSession";
import { useSignOut } from "@/components/app/hooks/useSignOut";
import { ThemeToggle } from "@/components/app/theme";
import { Button } from "@/components/ui/button";
import { startGithubSignIn } from "@/lib/auth-client";
import { playPagePath, type PlayEntryResponse } from "@/lib/play";

class PlayNotFoundError extends Error {}

async function fetchPlayEntry(
  namespace: string,
  slug: string,
): Promise<PlayEntryResponse> {
  const response = await fetch(
    `/api/play/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}`,
    { credentials: "include" },
  );
  if (response.status === 404) throw new PlayNotFoundError();
  if (!response.ok) throw new Error("This lab could not be loaded. Try again.");
  return (await response.json()) as PlayEntryResponse;
}

/** The public Run on intar entry page for one playable scenario. */
export function Play() {
  const { namespace, slug } = useParams({ from: "/play/$namespace/$slug" });
  const { ref } = useSearch({ from: "/play/$namespace/$slug" });
  const { access, isLoading: sessionLoading } = useSessionAccess();
  const entry = useQuery({
    // The session decides whether the briefing comes back.
    queryKey: ["play", namespace, slug, access],
    queryFn: () => fetchPlayEntry(namespace, slug),
    enabled: !sessionLoading,
    retry: (count, error) => !(error instanceof PlayNotFoundError) && count < 2,
  });

  if (entry.error instanceof PlayNotFoundError) return <PlayNotFound />;
  return (
    <Frame>
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col gap-6 px-(--page-inset) py-10 sm:py-16">
        {entry.data ? (
          <PlayBody
            entry={entry.data}
            access={access}
            scenarioId={slug}
            returnPath={playPagePath(namespace, slug, ref)}
            attribution={ref}
          />
        ) : entry.error ? (
          <div className="space-y-3">
            <InlineFeedback tone="error">{entry.error.message}</InlineFeedback>
            <Button variant="outline" onClick={() => void entry.refetch()}>
              Try again
            </Button>
          </div>
        ) : (
          <div role="status" aria-label="Loading the lab" className="space-y-3">
            <Skeleton className="h-9 w-3/4" />
            <Skeleton className="h-5 w-1/2" />
            <Skeleton className="h-20 w-full" />
          </div>
        )}
      </main>
    </Frame>
  );
}

function PlayBody({
  entry,
  access,
  scenarioId,
  returnPath,
  attribution,
}: {
  entry: PlayEntryResponse;
  access: "signed-out" | "active" | "stranded";
  scenarioId: string;
  returnPath: string;
  attribution: string | undefined;
}) {
  const meta = (
    <MetaLine
      items={[
        sentenceCase(entry.difficulty),
        `~${formatMinutes(entry.minutes)}`,
        entry.credit ? `By ${entry.credit}` : null,
      ]}
    />
  );
  const paused = !entry.available ? (
    <InlineFeedback tone="pending">
      New labs are paused for a short platform update. Try again soon.
    </InlineFeedback>
  ) : null;

  if (access === "active") {
    return (
      <>
        <PlayStart
          entry={entry}
          meta={meta}
          scenarioId={scenarioId}
          attribution={attribution}
        />
        {paused}
      </>
    );
  }
  return (
    <section className="flex flex-col gap-5">
      <div className="space-y-2">
        <h1 className="text-page-title text-balance">{entry.title}</h1>
        {meta}
      </div>
      <p className="text-body text-muted-foreground">{entry.summary}</p>
      {access === "stranded" ? <StrandedSession /> : <SignInToStart returnPath={returnPath} />}
      {paused}
    </section>
  );
}

function SignInToStart({ returnPath }: { returnPath: string }) {
  const signIn = useMutation({
    mutationFn: () =>
      startGithubSignIn({
        returnPath,
        errorCallbackURL: `${window.location.origin}/`,
      }),
  });
  return (
    <div className="flex flex-col gap-2">
      <Button
        size="lg"
        className="w-full sm:w-auto sm:self-start"
        onClick={() => signIn.mutate()}
        disabled={signIn.isPending}
      >
        {signIn.isPending ? "Opening GitHub…" : "Sign in with GitHub to start"}
        {!signIn.isPending ? <ArrowRight className="size-4" /> : null}
      </Button>
      {signIn.error ? (
        <InlineFeedback tone="error">
          {signIn.error instanceof Error
            ? signIn.error.message
            : "GitHub sign-in could not be started."}
        </InlineFeedback>
      ) : null}
    </div>
  );
}

function StrandedSession() {
  const signOut = useSignOut();
  return (
    <div className="flex flex-col gap-2">
      <Button
        size="lg"
        className="w-full sm:w-auto sm:self-start"
        onClick={() => signOut.mutate()}
        disabled={signOut.isPending}
      >
        {signOut.isPending ? "Signing out…" : "Sign out"}
      </Button>
      <p className="text-caption text-muted-foreground">
        This session can no longer be used. Sign out, then sign in again.
      </p>
      {signOut.error ? (
        <InlineFeedback tone="error">{signOut.error.message}</InlineFeedback>
      ) : null}
    </div>
  );
}

function PlayStart({
  entry,
  meta,
  scenarioId,
  attribution,
}: {
  entry: PlayEntryResponse;
  meta: ReactNode;
  scenarioId: string;
  attribution: string | undefined;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const abortRef = useRef<AbortController | null>(null);
  const [pending, setPending] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const start = () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPending(true);
    setWaiting(false);
    setError(null);
    // One call is one Start click: it owns one Idempotency-Key for all its
    // retries, so a lost response can never start a second lab.
    requestScenarioStartWithCapacityWait(scenarioId, {
      signal: controller.signal,
      onCapacityWait: () => setWaiting(true),
      launchSource: "play",
      ...(attribution ? { ref: attribution } : {}),
    })
      .then(async ({ runId }) => {
        void queryClient.invalidateQueries({
          queryKey: ["scenario-runs"],
          refetchType: "none",
        });
        await navigate({ to: "/runs/$runId", params: { runId } });
      })
      .catch((reason: unknown) => {
        if (
          controller.signal.aborted ||
          reason instanceof ScenarioStartCancelledError
        ) {
          return;
        }
        setPending(false);
        setError(
          reason instanceof Error ? reason.message : "The lab could not start.",
        );
      });
  };

  return (
    <>
      <StartLabConfirm
        headingLevel="h1"
        title={entry.title}
        meta={meta}
        briefingMarkdown={entry.briefing_markdown ?? entry.summary}
        pending={pending || !entry.available}
        error={error}
        onStart={start}
      />
      {waiting && pending ? (
        <InlineFeedback tone="pending">
          A practice machine is busy. Retrying for up to 60 seconds.
        </InlineFeedback>
      ) : null}
    </>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas text-foreground pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]">
      <header className="mx-auto flex w-full max-w-(--app-max) shrink-0 items-center justify-between gap-3 px-(--page-inset) py-1">
        <BrandMark />
        <ThemeToggle />
      </header>
      {children}
    </div>
  );
}

function PlayNotFound() {
  return (
    <Frame>
      <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col items-center justify-center gap-6 px-(--page-inset) py-16 text-center">
        <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
          <SearchX className="size-6" aria-hidden="true" />
        </span>
        <div className="space-y-1">
          <h1 className="text-page-title">This lab isn't open to play</h1>
          <p className="text-body text-muted-foreground">
            The link may be wrong, or the lab is no longer published.
          </p>
        </div>
        <Button variant="outline" render={<Link to="/" />}>
          Return home
        </Button>
      </main>
    </Frame>
  );
}
