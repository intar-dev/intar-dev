import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { describeApiError } from "../../lib/api-errors";
import { Field } from "../../patterns/Field";
import { InlineFeedback } from "../../patterns/InlineFeedback";
import { RollingNumber } from "../../patterns/RollingNumber";
import { RelativeTime } from "../../patterns/RelativeTime";
import { Section } from "../../patterns/Section";
import { CardGridSkeleton } from "../../patterns/Skeletons";
import { Stat } from "../../patterns/Stat";
import { ErrorState } from "../../patterns/StateCard";
import { mutationResponse } from "../organization-detail/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  isValidSignupLimit,
  parseAdminSignupStatus,
  SIGNUP_LIMIT_MAX,
  type AdminSignupStatus,
} from "@/lib/signup-status";

const SIGNUPS_QUERY_KEY = ["admin", "signups"] as const;

export function SignupsPanel() {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: SIGNUPS_QUERY_KEY,
    queryFn: fetchSignupStatus,
    staleTime: 5_000,
  });

  const save = useMutation({
    mutationFn: async (input: { limit: number; expectedVersion: number }) => {
      const response = await fetch("/api/admin/signups", {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      });
      await mutationResponse(response, "Failed to save the sign-up limit");
      const saved = parseAdminSignupStatus(await response.json().catch(() => null));
      if (!saved) throw new Error("The server returned an unreadable sign-up status");
      return saved;
    },
    onSuccess: (saved) => {
      queryClient.setQueryData(SIGNUPS_QUERY_KEY, saved);
    },
    // A stale version means another session saved first. Reload its limit so
    // the form shows what to review.
    onError: () =>
      queryClient.invalidateQueries({ queryKey: SIGNUPS_QUERY_KEY }),
  });

  if (status.error && !status.data) {
    return (
      <ErrorState
        title="Could not load sign-ups"
        description={status.error.message || "Failed to load sign-ups"}
        onRetry={() => void status.refetch()}
      />
    );
  }
  if (!status.data) {
    return (
      <CardGridSkeleton
        cards={3}
        className="sm:grid-cols-3"
        cardClassName="h-18"
      />
    );
  }

  const current = status.data;
  // A refused limit (a stale version, a number out of range) is the field's.
  const saveFailure = describeApiError<"limit">(save.error, {
    fallback: "Couldn't save the sign-up limit. Try again.",
    defaultField: "limit",
  });
  return (
    <Section
      density="compact"
      title="Sign-ups"
      description="Everyone with access takes a spot. Revoking or deleting someone frees theirs."
      bodyClassName="space-y-4"
    >
      <div className="grid gap-3 tabular-nums sm:grid-cols-3">
        <Stat
          size="sm"
          label="Taken"
          value={<RollingNumber value={current.taken} format={formatCount} />}
        />
        <Stat
          size="sm"
          label="Limit"
          value={<RollingNumber value={current.limit} format={formatCount} />}
        />
        <Stat
          size="sm"
          label="Left"
          announce
          value={<RollingNumber value={current.remaining} format={formatCount} />}
          detail={spotsDetail(current)}
        />
      </div>

      <SignupLimitForm
        key={current.version}
        status={current}
        pending={save.isPending}
        serverError={saveFailure?.field === "limit" ? saveFailure.message : null}
        onSave={(limit) =>
          save.mutate({ limit, expectedVersion: current.version })
        }
      />

      {saveFailure && saveFailure.field === null ? (
        <InlineFeedback tone="error">{saveFailure.message}</InlineFeedback>
      ) : save.isSuccess ? (
        <InlineFeedback tone="success">Sign-up limit saved.</InlineFeedback>
      ) : null}
      {current.updatedAt !== null ? (
        <p className="text-caption">
          Last changed <RelativeTime at={current.updatedAt} />
        </p>
      ) : null}
    </Section>
  );
}

// Keyed by the settings version, so a save or a newer limit from another
// session resets the draft to the stored value.
function SignupLimitForm({
  status,
  pending,
  serverError,
  onSave,
}: {
  status: AdminSignupStatus;
  pending: boolean;
  /** The server's refusal of the last save, shown at the field. */
  serverError: string | null;
  onSave: (limit: number) => void;
}) {
  const [draft, setDraft] = useState(String(status.limit));
  // Reward early, flag late: a fix clears the error at once, a new mistake
  // waits for blur or submit.
  const [error, setError] = useState<string | null>(null);
  const limit = parseSignupLimit(draft);
  const problem = draft.trim() !== "" && limit === null ? LIMIT_PROBLEM : null;
  const saveable = limit !== null && limit !== status.limit && !pending;

  return (
    <form
      className="flex flex-wrap items-start gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (problem) setError(problem);
        else if (saveable) onSave(limit);
      }}
    >
      <Field
        label="Sign-up limit"
        hint="Set 0 to close sign-ups. Members can still sign in, and a lower limit never removes anyone."
        error={error ?? serverError}
        className="min-w-0 flex-1 basis-72"
      >
        {(control) => (
          <Input
            {...control}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={draft}
            onChange={(event) => {
              const next = event.target.value;
              setDraft(next);
              const nextLimit = parseSignupLimit(next);
              if (nextLimit !== null || next.trim() === "") setError(null);
            }}
            onBlur={() => setError(problem)}
            className="w-40 tabular-nums"
          />
        )}
      </Field>
      <Button
        type="submit"
        variant="outline"
        className="mt-[1.625rem]"
        disabled={!saveable}
      >
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}

const LIMIT_PROBLEM = `Enter a whole number from 0 to ${formatCount(SIGNUP_LIMIT_MAX)}.`;

async function fetchSignupStatus(): Promise<AdminSignupStatus> {
  const response = await fetch("/api/admin/signups", {
    credentials: "include",
    cache: "no-store",
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    const error =
      typeof body === "object" && body !== null && "error" in body
        ? body.error
        : null;
    throw new Error(
      typeof error === "string"
        ? error
        : `Failed to load sign-ups (${response.status})`,
    );
  }
  const status = parseAdminSignupStatus(body);
  if (!status) throw new Error("The server returned an unreadable sign-up status");
  return status;
}

/** A whole number in the accepted range, or null. */
function parseSignupLimit(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/u.test(trimmed)) return null;
  const limit = Number(trimmed);
  return isValidSignupLimit(limit) ? limit : null;
}

function spotsDetail(status: AdminSignupStatus): string {
  if (status.limit === 0) return "Sign-ups are closed";
  return status.open ? "Sign-ups are open" : "All spots are taken";
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}
