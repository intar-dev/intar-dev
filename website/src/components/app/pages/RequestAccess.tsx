import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { AtSign, CheckCircle2 } from "lucide-react";
import { AuthShell } from "../patterns/AuthShell";
import { InlineFeedback } from "../patterns/InlineFeedback";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { isValidGithubUsername } from "@/lib/github-username";

export function RequestAccess() {
  const [username, setUsername] = useState("");
  const [note, setNote] = useState("");
  const successRef = useRef<HTMLDivElement | null>(null);

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

  const canSubmit = isValidGithubUsername(username) && !submit.isPending;

  useEffect(() => {
    if (!submit.isSuccess) return;
    successRef.current?.focus();
  }, [submit.isSuccess]);

  return (
    <AuthShell
      eyebrow="Access request"
      title={submit.isSuccess ? "Request received" : "Request workshop access"}
      description={
        submit.isSuccess
          ? "Your GitHub username is now queued for review."
          : "intar.dev is invite-only while the sandbox fleet grows. Tell us which GitHub identity you will use."
      }
    >
      {submit.isSuccess ? (
        <div ref={successRef} tabIndex={-1} className="space-y-8 rounded-lg">
          <div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            className="flex items-start gap-3 rounded-lg border border-success-border bg-success-subtle p-4 text-success"
          >
            <CheckCircle2
              className="mt-0.5 size-5 shrink-0"
              aria-hidden="true"
            />
            <div className="space-y-1">
              <p className="font-semibold">Review can begin</p>
              <p className="text-sm leading-6">
                After access is granted for{" "}
                <span className="font-medium">{username.trim()}</span>, return
                here and sign in with GitHub.
              </p>
            </div>
          </div>
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
            <Button variant="outline" render={<Link to="/" />}>
              Back to intar.dev
            </Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-6"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) submit.mutate();
          }}
        >
          <div className="space-y-2">
            <label htmlFor="gh-username" className="text-sm font-semibold">
              GitHub username
            </label>
            <div className="relative">
              <AtSign className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                id="gh-username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                placeholder="octocat"
                autoComplete="username"
                spellCheck={false}
                className="pl-9"
                aria-describedby="gh-username-help"
              />
            </div>
            <p id="gh-username-help" className="text-caption">
              Use the exact username you will use to sign in.
            </p>
          </div>

          <div className="space-y-2">
            <label htmlFor="gh-note" className="text-sm font-semibold">
              How will you use the workshop?{" "}
              <span className="font-normal text-muted-foreground">
                Optional
              </span>
            </label>
            <Textarea
              id="gh-note"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="Practising incident response with colleagues…"
              rows={4}
            />
          </div>

          {submit.error ? (
            <InlineFeedback tone="error">
              {submit.error instanceof Error
                ? submit.error.message
                : "The request could not be submitted. Try again."}
            </InlineFeedback>
          ) : submit.isPending ? (
            <InlineFeedback tone="pending">
              Sending your access request…
            </InlineFeedback>
          ) : null}

          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Button variant="ghost" render={<Link to="/" />}>
              Back
            </Button>
            <Button type="submit" disabled={!canSubmit}>
              {submit.isPending ? "Sending request…" : "Request access"}
            </Button>
          </div>
        </form>
      )}
    </AuthShell>
  );
}
