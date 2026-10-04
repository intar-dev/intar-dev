import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, CircleDot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
import { AsyncLabel } from "../../patterns/AsyncLabel";
import { Field } from "../../patterns/Field";
import { InlineConfirm } from "../../patterns/InlineConfirm";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  SUPPORT_LIMITS,
  SUPPORT_TYPES,
  type SupportStatus,
  type SupportTopicType,
} from "@/lib/support-types";
import { HttpResponseError } from "../../lib/http-response-error";
import { formatRelativeTime, formatTimestamp } from "../../lib/format";

export async function supportRequest<T>(
  path: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  const response = await fetch(`/api/support/topics${path}`, {
    method,
    credentials: "same-origin",
    ...(body !== undefined
      ? {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }
      : {}),
  });
  if (response.status === 204) return undefined as T;
  const data = await response.json();
  if (!response.ok)
    throw new HttpResponseError(
      response.status,
      data &&
        typeof data === "object" &&
        "error" in data &&
        typeof data.error === "string"
        ? data.error
        : "The request failed. Try again.",
    );
  return data as T;
}

export function PostError({ error }: { error: Error | null }) {
  return error ? (
    <p role="alert" className="text-sm text-destructive">
      {error.message}
    </p>
  ) : null;
}

export function TopicStatus({ status }: { status: SupportStatus }) {
  const Icon = status === "solved" ? CheckCircle2 : CircleDot;
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-sm font-medium ${status === "solved" ? "text-success" : "text-muted-foreground"}`}
    >
      <Icon className="size-4" aria-hidden="true" />
      {status === "solved" ? "Solved" : "Open"}
    </span>
  );
}

export function PostTime({ at }: { at: number }) {
  return (
    <time dateTime={new Date(at).toISOString()} title={formatTimestamp(at)}>
      {formatRelativeTime(at)}
    </time>
  );
}

export interface TopicInput {
  title: string;
  type: SupportTopicType;
  body: string;
}

export function TopicForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: TopicInput;
  onSave: (input: TopicInput) => Promise<void>;
  onCancel?: () => void;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [type, setType] = useState<SupportTopicType>(initial?.type ?? "bug");
  const [body, setBody] = useState(initial?.body ?? "");
  const save = useMutation({
    mutationFn: () => onSave({ title: title.trim(), type, body: body.trim() }),
  });
  const pending = save.isPending;
  return (
    <form
      aria-busy={pending || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) save.mutate();
      }}
    >
      {/* Fields stay focusable and keep their size while saving: readOnly, not
          disabled, so focus is still in the field when a refusal comes back. */}
      <div className="min-w-0 space-y-4">
        <Field
          label="Title"
          hint="Describe the topic in one sentence."
          className="max-w-field"
        >
          {(control) => (
            <Input
              {...control}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              required
              readOnly={pending}
              // Editing opens onto the field; a new topic does not steal focus.
              autoFocus={initial !== undefined}
              maxLength={SUPPORT_LIMITS.title}
            />
          )}
        </Field>
        <Field label="Type">
          {(control) => (
            <NativeSelect
              {...control}
              value={type}
              disabled={pending}
              onChange={(event) =>
                setType(event.target.value as SupportTopicType)
              }
            >
              {Object.entries(SUPPORT_TYPES).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field
          label="Description"
          hint="Use Markdown for links and code blocks. All Intar users with active access can read this topic."
        >
          {(control) => (
            <Textarea
              {...control}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={9}
              required
              readOnly={pending}
              maxLength={SUPPORT_LIMITS.body}
              placeholder="What happened? What did you expect? Include the steps or details that can help others."
            />
          )}
        </Field>
        <PostError error={save.error} />
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            aria-busy={pending || undefined}
            focusableWhenDisabled
            disabled={pending || !title.trim() || !body.trim()}
          >
            <AsyncLabel
              state={pending ? "pending" : "idle"}
              idle={initial ? "Save changes" : "Create topic"}
              pending="Saving…"
            />
          </Button>
          {onCancel && (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onCancel}
            >
              Cancel
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}

export function CommentForm({
  initial,
  onSave,
  onCancel,
}: {
  initial?: string;
  onSave: (body: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const [body, setBody] = useState(initial ?? "");
  const save = useMutation({
    mutationFn: () => onSave(body.trim()),
    onSuccess: () => setBody(""),
  });
  const pending = save.isPending;
  return (
    <form
      aria-busy={pending || undefined}
      onSubmit={(event) => {
        event.preventDefault();
        if (!pending) save.mutate();
      }}
    >
      <div className="min-w-0 space-y-4">
        <Field
          label={initial === undefined ? "Add a comment" : "Edit comment"}
          hint="Markdown, links, and code blocks are supported."
        >
          {(control) => (
            <Textarea
              {...control}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              required
              readOnly={pending}
              // Editing opens onto the field; a new comment does not steal focus.
              autoFocus={initial !== undefined}
              maxLength={SUPPORT_LIMITS.comment}
              rows={4}
            />
          )}
        </Field>
        <PostError error={save.error} />
        <div className="flex flex-wrap gap-2">
          <Button
            type="submit"
            aria-busy={pending || undefined}
            focusableWhenDisabled
            disabled={pending || !body.trim()}
          >
            <AsyncLabel
              state={pending ? "pending" : "idle"}
              idle={initial === undefined ? "Post comment" : "Save comment"}
              pending="Saving…"
            />
          </Button>
          {onCancel && (
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onCancel}
            >
              Cancel
            </Button>
          )}
        </div>
      </div>
    </form>
  );
}

export function DeletePost({
  kind,
  onDelete,
}: {
  kind: "topic" | "comment";
  onDelete: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const remove = useMutation({
    mutationFn: onDelete,
    onSuccess: () => setOpen(false),
  });
  // A comment is yours alone and the button's words carry the consequence, so
  // it asks again in place; a topic also deletes other people's comments and
  // keeps the dialog.
  if (kind === "comment")
    return (
      <div className="flex flex-col items-start gap-1">
        <InlineConfirm
          label="Delete"
          name="Delete comment"
          question="Delete this comment?"
          confirmLabel="Delete comment"
          pendingLabel="Deleting…"
          doneLabel="Deleted"
          pending={remove.isPending}
          done={remove.isSuccess}
          onConfirm={() => remove.mutate()}
          onCancel={() => remove.reset()}
        />
        <PostError error={remove.error} />
      </div>
    );
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!remove.isPending) {
          setOpen(next);
          remove.reset();
        }
      }}
    >
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>
        Delete topic
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete this topic?</DialogTitle>
          <DialogDescription>
            This permanently deletes the topic and all its comments, including
            comments from other users. This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <PostError error={remove.error} />
        <DialogFooter>
          <Button
            variant="outline"
            disabled={remove.isPending}
            onClick={() => setOpen(false)}
          >
            Keep topic
          </Button>
          <Button
            variant="destructive"
            aria-busy={remove.isPending || undefined}
            focusableWhenDisabled
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            <AsyncLabel
              state={remove.isPending ? "pending" : "idle"}
              idle="Delete topic"
              pending="Deleting…"
            />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
