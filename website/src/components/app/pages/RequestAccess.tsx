import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AtSign, CheckCircle2, SquareTerminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
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
    <main className="flex min-h-screen flex-col items-center justify-center px-6 py-16">
      <Link
        to="/"
        className="mb-8 flex items-center gap-2.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex size-8 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <SquareTerminal className="size-5" aria-hidden="true" />
        </span>
        <span className="font-heading text-lg font-bold tracking-tight">
          intar
        </span>
      </Link>

      {submitted ? (
        <div className="w-full max-w-md rounded-2xl border bg-card p-6 shadow-xs">
          <div className="flex flex-col items-center gap-4 py-4 text-center">
            <CheckCircle2 className="size-10 text-success" />
            <div className="space-y-2">
              <h1 className="text-page-title">Request received</h1>
              <p className="text-sm leading-6 text-muted-foreground">
                Thanks — we'll review{" "}
                <span className="font-medium text-foreground">{username}</span>{" "}
                and email you once access is granted. You'll then sign in with
                GitHub.
              </p>
            </div>
            <Button variant="outline" render={<Link to="/" />}>
              Done
            </Button>
          </div>
        </div>
      ) : (
        <div className="w-full max-w-md rounded-2xl border bg-card p-6 shadow-xs">
          <div className="space-y-2">
            <h1 className="text-page-title">Request access</h1>
            <p className="text-sm leading-6 text-muted-foreground">
              Tell us your GitHub handle — we'll open the door. intar is
              invite-only while we scale the sandbox fleet.
            </p>
          </div>
          <form
            className="mt-6 space-y-4"
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
        </div>
      )}
    </main>
  );
}
