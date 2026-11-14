import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useParams, useSearch } from "@tanstack/react-router";
import { ArrowRight, LoaderCircle, SearchX, Terminal } from "lucide-react";
import { Markdown } from "../Markdown";
import { useSessionAccess } from "../hooks/useSession";
import { apiErrorMessage } from "../lib/api-errors";
import { formatMinutes } from "../lib/format";
import { HttpResponseError } from "../lib/http-response-error";
import { AsyncLabel } from "../patterns/AsyncLabel";
import { BrandMark } from "../patterns/BrandMark";
import { InlineFeedback } from "../patterns/InlineFeedback";
import { MetaDifficulty, MetaLine, type ScenarioDifficulty } from "../patterns/MetaLine";
import { ErrorState } from "../patterns/StateCard";
import { ThemeToggle } from "../theme";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { startGithubSignIn } from "@/lib/auth-client";

interface PlayScenario {
  id: string;
  title: string;
  summary: string;
  difficulty: string;
  minutes: number;
  credit: string | null;
  tags?: string[];
  briefing?: string;
}

/** A scenario's public play page: anyone reads it, signed-in people start it. */
export function Play() {
  const { namespace, slug } = useParams({ from: "/marketing/play/$namespace/$slug" });
  const { ref } = useSearch({ from: "/marketing/play/$namespace/$slug" });
  const { access } = useSessionAccess();
  const scenario = useQuery({
    queryKey: ["play", namespace, slug, access],
    queryFn: async () => {
      const response = await fetch(
        `/api/play/${encodeURIComponent(namespace)}/${encodeURIComponent(slug)}`,
        { credentials: "include" },
      );
      if (response.status === 404) return null;
      const body = (await response.json().catch(() => null)) as { scenario?: PlayScenario } | null;
      if (!response.ok || !body?.scenario) {
        throw HttpResponseError.fromBody(response.status, body, "The scenario couldn't be loaded. Try again.");
      }
      return body.scenario;
    },
    retry: false,
  });
  const signIn = useMutation({
    mutationFn: () => {
      const here = `${window.location.origin}${window.location.pathname}${window.location.search}`;
      return startGithubSignIn({ callbackURL: here, errorCallbackURL: here });
    },
  });
  const data = scenario.data;
  const signedIn = access === "active";

  return (
    <div className="flex min-h-svh flex-col bg-canvas">
      {data ? <title>{`${data.title} · intar.dev`}</title> : null}
      <header className="mx-auto flex min-h-16 w-full max-w-7xl items-center justify-between gap-4 px-[var(--page-inset)]">
        <BrandMark />
        <ThemeToggle />
      </header>
      <main className="mx-auto flex w-full max-w-7xl flex-1 items-start justify-center px-[var(--page-inset)] py-8 sm:py-12">
        {scenario.isPending ? (
          <div role="status" className="flex items-center gap-2 py-16 text-muted-foreground">
            <LoaderCircle className="size-5 motion-safe:animate-spin" />
            <span>Loading the scenario…</span>
          </div>
        ) : scenario.error ? (
          <ErrorState
            title="The scenario didn't load"
            description={apiErrorMessage(scenario.error, "The scenario couldn't be loaded. Try again.") ?? "Try again."}
            onRetry={() => void scenario.refetch()}
          />
        ) : !data ? (
          <div className="flex max-w-xl flex-col items-center gap-6 py-16 text-center" data-play-not-found>
            <span className="flex size-12 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <SearchX className="size-6" />
            </span>
            <div className="space-y-1">
              <h1 className="text-page-title">This scenario isn't open to play</h1>
              <p className="text-body text-muted-foreground">
                Check the link, or browse the courses to choose a repair.
              </p>
            </div>
            <Button render={<Link to="/" />}>Back to Intar</Button>
          </div>
        ) : (
          <Card className="w-full max-w-3xl overflow-hidden rounded-2xl pt-0" data-play-scenario>
            <CardHeader className="gap-4 border-b pt-(--card-spacing)">
              <span className="flex size-10 items-center justify-center rounded-[0.625rem] bg-brand-subtle text-brand-text ring-1 ring-brand-border/60">
                <Terminal className="size-5" />
              </span>
              <div className="space-y-2">
                <p className="text-label">Repair scenario</p>
                <h1 className="text-content-title text-balance">{data.title}</h1>
                <p className="text-lede text-muted-foreground text-pretty">{data.summary}</p>
                <MetaLine
                  items={[
                    <MetaDifficulty key="difficulty" difficulty={data.difficulty as ScenarioDifficulty} />,
                    data.minutes ? `~${formatMinutes(data.minutes)}` : null,
                    ...(data.tags ?? []),
                  ]}
                />
                {data.credit ? <p className="text-caption text-muted-foreground">{data.credit}</p> : null}
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              {signedIn ? (
                <>
                  {data.briefing ? <Markdown headingOffset={1}>{data.briefing}</Markdown> : null}
                  <Button
                    size="lg"
                    className="w-full sm:w-auto"
                    render={
                      <Link
                        to="/runs/start/$"
                        params={{ _splat: data.id }}
                        search={{
                          scope: undefined,
                          organizationId: undefined,
                          courseId: undefined,
                          lectureId: undefined,
                          source: "play",
                          ref,
                        }}
                      />
                    }
                  >
                    Start scenario
                    <ArrowRight className="size-4" />
                  </Button>
                </>
              ) : (
                <>
                  <p className="text-body text-muted-foreground">
                    Sign in to read the briefing and start the lab. It runs on its own machines, and you repair it in the
                    browser.
                  </p>
                  <Button
                    size="lg"
                    className="w-full sm:w-auto"
                    aria-busy={signIn.isPending || undefined}
                    disabled={signIn.isPending}
                    focusableWhenDisabled
                    onClick={() => signIn.mutate()}
                  >
                    <AsyncLabel
                      state={signIn.isPending ? "pending" : "idle"}
                      idle={
                        <>
                          Sign in with GitHub to start
                          <ArrowRight className="size-4" />
                        </>
                      }
                      pending="Opening GitHub…"
                    />
                  </Button>
                  {signIn.error ? (
                    <InlineFeedback tone="error">
                      {apiErrorMessage(signIn.error, "Could not start sign-in. Try again.")}
                    </InlineFeedback>
                  ) : null}
                </>
              )}
            </CardContent>
          </Card>
        )}
      </main>
    </div>
  );
}
