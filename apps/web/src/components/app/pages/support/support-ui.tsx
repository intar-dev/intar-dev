import { useId, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, CircleDot } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";
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
  const id = useId();
  const [title, setTitle] = useState(initial?.title ?? "");
  const [type, setType] = useState<SupportTopicType>(initial?.type ?? "bug");
  const [body, setBody] = useState(initial?.body ?? "");
  const save = useMutation({
    mutationFn: () => onSave({ title: title.trim(), type, body: body.trim() }),
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!save.isPending) save.mutate();
      }}
    >
      <fieldset disabled={save.isPending} className="min-w-0 space-y-4">
        <div className="space-y-2">
          <label htmlFor={`${id}-title`} className="block text-sm font-medium">
            Title
          </label>
          <Input
            id={`${id}-title`}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
            maxLength={SUPPORT_LIMITS.title}
            placeholder="Describe the topic in one sentence"
          />
        </div>
        <div className="flex flex-col items-start gap-2">
          <label htmlFor={`${id}-type`} className="block text-sm font-medium">
            Type
          </label>
          <NativeSelect
            id={`${id}-type`}
            value={type}
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
        </div>
        <div className="space-y-2">
          <label htmlFor={`${id}-body`} className="block text-sm font-medium">
            Description
          </label>
          <Textarea
            id={`${id}-body`}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            rows={9}
            required
            maxLength={SUPPORT_LIMITS.body}
            aria-describedby={`${id}-help`}
            placeholder="What happened? What did you expect? Include the steps or details that can help others."
          />
          <p id={`${id}-help`} className="text-sm text-muted-foreground">
            Use Markdown for links and code blocks. All Intar users with active
            access can read this topic.
          </p>
        </div>
        <PostError error={save.error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!title.trim() || !body.trim()}>
            {save.isPending
              ? "Saving…"
              : initial
                ? "Save changes"
                : "Create topic"}
          </Button>
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </fieldset>
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
  const id = useId();
  const [body, setBody] = useState(initial ?? "");
  const save = useMutation({
    mutationFn: () => onSave(body.trim()),
    onSuccess: () => setBody(""),
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!save.isPending) save.mutate();
      }}
    >
      <fieldset disabled={save.isPending} className="min-w-0 space-y-4">
        <div className="space-y-2">
          <label htmlFor={id} className="block text-sm font-medium">
            {initial === undefined ? "Add a comment" : "Edit comment"}
          </label>
          <Textarea
            id={id}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            required
            maxLength={SUPPORT_LIMITS.comment}
            rows={4}
            aria-describedby={`${id}-help`}
          />
          <p id={`${id}-help`} className="text-sm text-muted-foreground">
            Markdown, links, and code blocks are supported.
          </p>
        </div>
        <PostError error={save.error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!body.trim()}>
            {save.isPending
              ? "Saving…"
              : initial === undefined
                ? "Post comment"
                : "Save comment"}
          </Button>
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      </fieldset>
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
        Delete {kind}
      </DialogTrigger>
      <DialogContent showCloseButton={!remove.isPending}>
        <DialogHeader>
          <DialogTitle>Delete this {kind}?</DialogTitle>
          <DialogDescription>
            {kind === "topic"
              ? "This permanently deletes the topic and all its comments, including comments from other users."
              : "This permanently deletes your selected comment."}{" "}
            This action cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <PostError error={remove.error} />
        <DialogFooter>
          <Button
            variant="outline"
            disabled={remove.isPending}
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? "Deleting…" : `Delete ${kind}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
