import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { InlineFeedback } from "../../patterns/InlineFeedback";
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
const LIMIT_HINT_ID = "signup-limit-hint";
const LIMIT_ERROR_ID = "signup-limit-error";

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

  if (status.error) {
    return (
      <ErrorState
        title="Could not load sign-ups"
        description={status.error.message || "Failed to load sign-ups"}
        onRetry={() => void status.refetch()}
      />
    );
  }
  if (status.isPending) {
    return (
      <CardGridSkeleton
        cards={3}
        className="sm:grid-cols-3"
        cardClassName="h-18"
      />
    );
  }

  const current = status.data;
  return (
    <Section
      density="compact"
      title="Sign-ups"
      description="Everyone with access takes a spot. Revoking or deleting someone frees theirs."
      bodyClassName="space-y-4"
    >
      <div className="grid gap-3 tabular-nums sm:grid-cols-3">
        <Stat size="sm" label="Taken" value={formatCount(current.taken)} />
        <Stat size="sm" label="Limit" value={formatCount(current.limit)} />
        <Stat
          size="sm"
          label="Left"
          value={formatCount(current.remaining)}
          detail={spotsDetail(current)}
        />
      </div>

      <SignupLimitForm
        key={current.version}
        status={current}
        pending={save.isPending}
        onSave={(limit) =>
          save.mutate({ limit, expectedVersion: current.version })
        }
      />

      {save.error ? (
        <InlineFeedback tone="error">{save.error.message}</InlineFeedback>
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
  onSave,
}: {
  status: AdminSignupStatus;
  pending: boolean;
  onSave: (limit: number) => void;
}) {
  const [draft, setDraft] = useState(String(status.limit));
  const limit = parseSignupLimit(draft);
  const invalid = draft.trim() !== "" && limit === null;
  const saveable = limit !== null && limit !== status.limit && !pending;

  return (
    <div className="space-y-2">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (saveable) onSave(limit);
        }}
      >
        <Field label="Sign-up limit">
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            max={SIGNUP_LIMIT_MAX}
            step={1}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="w-40 tabular-nums"
            aria-describedby={LIMIT_HINT_ID}
            aria-invalid={invalid || undefined}
            aria-errormessage={invalid ? LIMIT_ERROR_ID : undefined}
          />
        </Field>
        <Button
          type="submit"
          variant="outline"
          className="min-h-11 sm:min-h-9"
          disabled={!saveable}
        >
          {pending ? "Saving…" : "Save"}
        </Button>
      </form>
      <p id={LIMIT_HINT_ID} className="text-caption">
        Set 0 to close sign-ups. Members can still sign in, and a lower limit
        never removes anyone.
      </p>
      {invalid ? (
        <p
          id={LIMIT_ERROR_ID}
          aria-live="polite"
          className="text-sm text-destructive"
        >
          Enter a whole number from 0 to {formatCount(SIGNUP_LIMIT_MAX)}.
        </p>
      ) : null}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-2 text-sm font-medium">
      <span>{label}</span>
      {children}
    </label>
  );
}

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
