import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  SUPPORT_PAGE_SIZE,
  SUPPORT_TYPES,
  supportPage,
  type SupportComment,
  type SupportPage,
  type SupportTopic as Topic,
} from "@/lib/support-types";
import { Markdown } from "../../Markdown";
import { PageShell } from "../../patterns/PageShell";
import { CollectionPagination } from "../../patterns/CollectionPagination";
import { EmptyState, ErrorState } from "../../patterns/StateCard";
import { usePageChrome } from "../../shell/page-chrome";
import {
  HttpResponseError,
  retryHttpResponseError,
} from "../../lib/http-response-error";
import { formatTimestamp } from "../../lib/format";
import {
  CommentForm,
  DeletePost,
  PostError,
  PostTime,
  supportRequest,
  TopicForm,
  TopicStatus,
} from "./support-ui";

export function SupportTopic() {
  const { topicId } = useParams({ from: "/app/support/$topicId" });
  // Reset local drafts and edit state when navigation changes the topic.
  return <TopicDetail key={topicId} topicId={topicId} />;
}

function TopicDetail({ topicId }: { topicId: string }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ strict: false });
  const page = supportPage("page" in search ? search.page : 1);
  const [editing, setEditing] = useState(false);
  const detail = useQuery<{ topic: Topic }, Error>({
    queryKey: ["support", "topic", topicId],
    queryFn: () => supportRequest<{ topic: Topic }>(`/${topicId}`),
    retry: retryHttpResponseError,
  });
  const topic = detail.data?.topic;
  const comments = useQuery<SupportPage<SupportComment>, Error>({
    queryKey: ["support", "comments", topicId, page],
    queryFn: () =>
      supportRequest<SupportPage<SupportComment>>(
        `/${topicId}/comments?page=${page}`,
      ),
    enabled: Boolean(topic),
    retry: retryHttpResponseError,
  });
  const refresh = () => client.invalidateQueries({ queryKey: ["support"] });
  const resolve = useMutation({
    mutationFn: () =>
      supportRequest(`/${topicId}`, "PATCH", {
        status: topic?.status === "open" ? "solved" : "open",
      }),
    onSuccess: refresh,
  });
  const setPage = (next: number) =>
    void navigate({
      to: "/support/$topicId",
      params: { topicId },
      search: { page: next },
    });
  usePageChrome({ title: "Topic" });
  if (detail.isPending)
    return (
      <PageShell>
        <p role="status">Loading topic…</p>
      </PageShell>
    );
  if (detail.error || !topic)
    return (
      <PageShell>
        {detail.error instanceof HttpResponseError &&
        detail.error.status === 404 ? (
          <EmptyState
            title="Topic not found"
            description="This topic may have been deleted."
            action={
              <Link to="/support" className={buttonVariants()}>
                Back to forum
              </Link>
            }
          />
        ) : (
          <ErrorState
            title="Could not load topic"
            description={detail.error?.message ?? "Try again."}
            onRetry={() => void detail.refetch()}
          />
        )}
      </PageShell>
    );
  return (
    <PageShell>
      <div className="w-full max-w-3xl space-y-8">
        <article className="min-w-0 space-y-5" aria-label="Topic">
          <h2 className="text-feature-title text-balance wrap-anywhere">
            {topic.title}
          </h2>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted-foreground">
            <TopicStatus status={topic.status} />
            <span>{SUPPORT_TYPES[topic.type]}</span>
            <span className="wrap-anywhere">{topic.author.name}</span>
            <PostTime at={topic.createdAt} />
            {topic.updatedAt > topic.createdAt && (
              <span>
                Edited <PostTime at={topic.updatedAt} />
              </span>
            )}
          </div>
          {topic.status === "solved" && topic.solvedAt !== null && (
            <p
              role="status"
              className="rounded-lg border bg-muted px-4 py-3 text-sm"
            >
              Marked as solved by {topic.solvedBy?.name ?? "Deleted user"} on{" "}
              {formatTimestamp(topic.solvedAt)}.
            </p>
          )}
          {editing ? (
            <TopicForm
              initial={topic}
              onCancel={() => setEditing(false)}
              onSave={async (input) => {
                await supportRequest(`/${topicId}`, "PATCH", input);
                await refresh();
                setEditing(false);
              }}
            />
          ) : (
            <Markdown
              pageContent
              textOnly
              className="min-w-0 text-body wrap-anywhere"
            >
              {topic.body}
            </Markdown>
          )}
          {!editing && (
            <div className="flex flex-wrap items-center gap-2">
              {topic.canResolve && (
                <Button
                  variant={topic.status === "open" ? "default" : "outline"}
                  disabled={resolve.isPending}
                  onClick={() => resolve.mutate()}
                >
                  {resolve.isPending
                    ? "Saving…"
                    : topic.status === "open"
                      ? "Mark as solved"
                      : "Reopen"}
                </Button>
              )}
              {topic.canEdit && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setEditing(true)}
                >
                  Edit topic
                </Button>
              )}
              {topic.canDelete && (
                <DeletePost
                  kind="topic"
                  onDelete={async () => {
                    await supportRequest(`/${topicId}`, "DELETE");
                    client.removeQueries({
                      queryKey: ["support", "topic", topicId],
                    });
                    client.removeQueries({
                      queryKey: ["support", "comments", topicId],
                    });
                    await navigate({ to: "/support" });
                    await refresh();
                  }}
                />
              )}
            </div>
          )}
          <PostError error={resolve.error} />
        </article>
        <section
          className="space-y-5 border-t pt-6"
          aria-labelledby="comments-heading"
        >
          <h2 id="comments-heading" className="text-section-title">
            Comments{" "}
            <span className="text-muted-foreground">
              ({topic.commentCount})
            </span>
          </h2>
          {comments.isPending ? (
            <p role="status">Loading comments…</p>
          ) : comments.error ? (
            <ErrorState
              headingLevel={3}
              title="Could not load comments"
              description={comments.error.message}
              onRetry={() => void comments.refetch()}
            />
          ) : comments.data?.items.length ? (
            <>
              <ol className="divide-y">
                {comments.data.items.map((comment) => (
                  <CommentItem
                    key={comment.id}
                    comment={comment}
                    refresh={refresh}
                  />
                ))}
              </ol>
              <CollectionPagination
                page={comments.data.page}
                pageSize={comments.data.pageSize}
                totalItems={comments.data.totalItems}
                itemLabel="comments"
                onPageChange={setPage}
              />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No comments yet. Add the first reply.
            </p>
          )}
          <CommentForm
            onSave={async (body) => {
              await supportRequest(`/${topicId}/comments`, "POST", { body });
              setPage(Math.ceil((topic.commentCount + 1) / SUPPORT_PAGE_SIZE));
              await refresh();
            }}
          />
        </section>
      </div>
    </PageShell>
  );
}

function CommentItem({
  comment,
  refresh,
}: {
  comment: SupportComment;
  refresh: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const path = `/${comment.topicId}/comments/${comment.id}`;
  return (
    <li className="min-w-0 space-y-3 py-5 first:pt-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span className="font-medium wrap-anywhere">{comment.author.name}</span>
        <span className="text-muted-foreground">
          <PostTime at={comment.createdAt} />
        </span>
        {comment.updatedAt > comment.createdAt && (
          <span className="text-muted-foreground">
            Edited <PostTime at={comment.updatedAt} />
          </span>
        )}
      </div>
      {editing ? (
        <CommentForm
          initial={comment.body}
          onCancel={() => setEditing(false)}
          onSave={async (body) => {
            await supportRequest(path, "PATCH", { body });
            await refresh();
            setEditing(false);
          }}
        />
      ) : (
        <>
          <Markdown
            pageContent
            textOnly
            className="min-w-0 text-body wrap-anywhere"
          >
            {comment.body}
          </Markdown>
          {(comment.canEdit || comment.canDelete) && (
            <div className="flex flex-wrap gap-2">
              {comment.canEdit && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setEditing(true)}
                >
                  Edit comment
                </Button>
              )}
              {comment.canDelete && (
                <DeletePost
                  kind="comment"
                  onDelete={async () => {
                    await supportRequest(path, "DELETE");
                    await refresh();
                  }}
                />
              )}
            </div>
          )}
        </>
      )}
    </li>
  );
}
