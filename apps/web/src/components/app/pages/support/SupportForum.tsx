import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { MessageSquare, Plus } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import {
  SUPPORT_TYPES,
  validateSupportSearch,
  type SupportPage,
  type SupportSearch,
  type SupportTopicSummary,
} from "@/lib/support-types";
import { PageShell } from "../../patterns/PageShell";
import { CollectionPagination } from "../../patterns/CollectionPagination";
import { EmptyState, ErrorState } from "../../patterns/StateCard";
import { usePageChrome } from "../../shell/page-chrome";
import { retryHttpResponseError } from "../../lib/http-response-error";
import { PostTime, supportRequest, TopicStatus } from "./support-ui";

export function SupportForum() {
  const search = validateSupportSearch(useSearch({ strict: false }));
  const navigate = useNavigate();
  const topics = useQuery<SupportPage<SupportTopicSummary>, Error>({
    queryKey: ["support", "topics", search],
    queryFn: () =>
      supportRequest<SupportPage<SupportTopicSummary>>(
        `?${new URLSearchParams({ q: search.q, type: search.type, status: search.status, mine: String(search.mine), page: String(search.page) })}`,
      ),
    retry: retryHttpResponseError,
  });
  const setSearch = (changes: Partial<SupportSearch>) =>
    void navigate({
      to: "/support",
      search: { ...search, page: 1, ...changes },
    });
  usePageChrome({
    title: "Forum",
    action: useMemo(
      () => (
        <Link to="/support/new" className={buttonVariants({ size: "sm" })}>
          <Plus />
          New topic
        </Link>
      ),
      [],
    ),
  });
  const data = topics.data;
  return (
    <PageShell>
      <p className="max-w-prose text-body text-muted-foreground">
        Report a bug, ask for help, or share feedback with the Intar community.
      </p>
      <div className="flex flex-wrap items-end gap-4">
        <form
          className="flex min-w-0 grow basis-64 items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setSearch({
              q: String(
                new FormData(event.currentTarget).get("q") ?? "",
              ).trim(),
            });
          }}
        >
          <div className="min-w-0 flex-1 space-y-2">
            <label htmlFor="topic-search" className="text-sm font-medium">
              Search topics
            </label>
            <Input
              key={search.q}
              id="topic-search"
              name="q"
              defaultValue={search.q}
              maxLength={160}
              placeholder="Search titles and descriptions"
            />
          </div>
          <Button type="submit" variant="outline">
            Search
          </Button>
        </form>
        <div className="flex flex-col gap-2">
          <label htmlFor="topic-type" className="text-sm font-medium">
            Type
          </label>
          <NativeSelect
            id="topic-type"
            value={search.type}
            onChange={(event) =>
              setSearch({ type: event.target.value as SupportSearch["type"] })
            }
          >
            <option value="all">All types</option>
            {Object.entries(SUPPORT_TYPES).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="flex flex-col gap-2">
          <label htmlFor="topic-status" className="text-sm font-medium">
            Status
          </label>
          <NativeSelect
            id="topic-status"
            value={search.status}
            onChange={(event) =>
              setSearch({
                status: event.target.value as SupportSearch["status"],
              })
            }
          >
            <option value="all">All statuses</option>
            <option value="open">Open</option>
            <option value="solved">Solved</option>
          </NativeSelect>
        </div>
        <label className="flex min-h-10 items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={search.mine}
            onChange={(event) => setSearch({ mine: event.target.checked })}
          />
          My topics
        </label>
      </div>
      {topics.isPending ? (
        <p role="status" className="text-muted-foreground">
          Loading topics…
        </p>
      ) : topics.error ? (
        <ErrorState
          title="Could not load topics"
          description={topics.error.message}
          onRetry={() => void topics.refetch()}
        />
      ) : data?.items.length ? (
        <>
          <ul className="divide-y rounded-lg border bg-card">
            {data.items.map((topic) => (
              <li key={topic.id} className="px-4 py-4 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <Link
                    to="/support/$topicId"
                    params={{ topicId: topic.id }}
                    className="min-w-0 text-card-title wrap-anywhere underline-offset-4 hover:underline focus-visible:underline"
                  >
                    {topic.title}
                  </Link>
                  <TopicStatus status={topic.status} />
                </div>
                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                  <span>{SUPPORT_TYPES[topic.type]}</span>
                  <span className="wrap-anywhere">{topic.author.name}</span>
                  <span className="inline-flex items-center gap-1.5">
                    <MessageSquare className="size-3.5" aria-hidden="true" />
                    {topic.commentCount}{" "}
                    {topic.commentCount === 1 ? "comment" : "comments"}
                  </span>
                  <span>
                    Active <PostTime at={topic.lastActivityAt} />
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <CollectionPagination
            page={data.page}
            pageSize={data.pageSize}
            totalItems={data.totalItems}
            itemLabel="topics"
            onPageChange={(page) => setSearch({ page })}
          />
        </>
      ) : (
        <EmptyState
          title={
            search.q ||
            search.type !== "all" ||
            search.status !== "all" ||
            search.mine
              ? "No topics match these filters"
              : "Start a conversation"
          }
          description="Share a bug report, a question, or an idea."
          action={
            <Link to="/support/new" className={buttonVariants()}>
              New topic
            </Link>
          }
        />
      )}
    </PageShell>
  );
}
