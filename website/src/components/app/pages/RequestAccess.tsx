import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, AtSign, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { isValidGithubUsername } from "@/lib/github-username";

export function RequestAccess() {
  const [username, setUsername] = useState("");
  const [note, setNote] = useState("");

  const submit = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/access-requests", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          username: username.trim(),
          note: note.trim() || null,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(
          body?.error ?? `Failed to submit request (${response.status})`,
        );
      }
    },
  });

  const submitted = submit.isSuccess;
  const canSubmit = isValidGithubUsername(username) && !submit.isPending;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-lg flex-col justify-center px-4 py-16">
      <Link
        to="/"
        className="mb-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Back to home
      </Link>

      {submitted ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
            <CheckCircle2 className="size-10 text-success" />
            <div className="space-y-2">
              <h1 className="text-2xl font-semibold tracking-tight">
                Request received
              </h1>
              <p className="text-sm leading-6 text-muted-foreground">
                Thanks — we'll review <span className="font-medium">{username}</span>{" "}
                and email you once access is granted. You'll then sign in with GitHub.
              </p>
            </div>
            <Button variant="outline" render={<Link to="/" />}>
              Done
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-2xl">Request access</CardTitle>
            <p className="text-sm leading-6 text-muted-foreground">
              intar is invite-only while we scale the sandbox fleet. Tell us your
              GitHub username and we'll get you in.
            </p>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (canSubmit) submit.mutate();
              }}
            >
              <div className="space-y-1.5">
                <label htmlFor="gh-username" className="text-sm font-medium">
                  GitHub username
                </label>
                <div className="relative">
                  <AtSign className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    id="gh-username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="octocat"
                    autoComplete="off"
                    className="pl-8"
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="gh-note" className="text-sm font-medium">
                  Anything we should know?{" "}
                  <span className="text-muted-foreground">(optional)</span>
                </label>
                <Textarea
                  id="gh-note"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="How you plan to use intar…"
                  rows={3}
                />
              </div>
              {submit.error ? (
                <p className="text-sm text-destructive">
                  {submit.error instanceof Error
                    ? submit.error.message
                    : "Failed to submit request"}
                </p>
              ) : null}
              <Button type="submit" className="w-full" disabled={!canSubmit}>
                {submit.isPending ? "Submitting…" : "Request access"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}
    </main>
  );
}
