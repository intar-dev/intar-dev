import { useEffect, useMemo, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { MessageSquare, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  SUPPORT_TYPES,
  validateSupportSearch,
  type SupportPage,
  type SupportSearch,
  type SupportTopicSummary,
  type SupportTopicType,
} from "@/lib/support-types";
import { PageShell } from "../../patterns/PageShell";
import { CollectionPagination } from "../../patterns/CollectionPagination";
import {
  FilterBar,
  FilterChip,
  FilterChipGroup,
} from "../../patterns/FilterBar";
import { MetaLine } from "../../patterns/MetaLine";
import { ListSkeleton } from "../../patterns/Skeletons";
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
    // A filter or page change keeps the rows and the pager in place, marked
    // busy, until the next ones arrive; bones show on the first load only.
    placeholderData: keepPreviousData,
    retry: retryHttpResponseError,
  });
  const setSearch = (
    changes: Partial<SupportSearch>,
    options: { replace?: boolean } = {},
  ) =>
    void navigate({
      to: "/support",
      search: { ...search, page: 1, ...changes },
      resetScroll: false,
      ...options,
    });
  // Typing writes the URL after a pause, replacing the entry so keystrokes
  // don't fill the history. The draft follows the URL only when something
  // other than this field changed it (back, forward, Clear filters).
  const [draft, setDraft] = useState(search.q);
  const [seenQ, setSeenQ] = useState(search.q);
  const [written, setWritten] = useState(search.q);
  if (seenQ !== search.q) {
    setSeenQ(search.q);
    if (search.q !== written) setDraft(search.q);
  }
  const write = useRef(setSearch);
  write.current = setSearch;
  useEffect(() => {
    const next = draft.trim().slice(0, 160);
    if (next === search.q) return;
    const timer = window.setTimeout(() => {
      setWritten(next);
      write.current({ q: next }, { replace: true });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [draft, search.q]);
  usePageChrome({
    title: "Forum",
    action: useMemo(
      () => (
        <Button size="sm" render={<Link to="/support/new" />}>
          <Plus />
          New topic
        </Button>
      ),
      [],
    ),
  });
  const data = topics.data;
  const filtered =
    search.q !== "" ||
    search.type !== "all" ||
    search.status !== "all" ||
    search.mine;
  const clearFilters = () => {
    setWritten("");
    setDraft("");
    setSearch({ q: "", type: "all", status: "all", mine: false });
  };
  return (
    <PageShell>
      <p className="max-w-prose text-body text-muted-foreground">
        Report a bug, ask for help, or share feedback with the Intar community.
      </p>
      <FilterBar
        search={draft}
        onSearchChange={setDraft}
        searchLabel="Search forum topics"
        searchPlaceholder="Search titles and descriptions…"
        filtersActive={filtered}
        onClear={clearFilters}
        {...(data
          ? { shown: data.items.length, total: data.totalItems, noun: "topics" }
          : null)}
      >
        <FilterChipGroup label="Filter topics by type">
          {(Object.entries(SUPPORT_TYPES) as [SupportTopicType, string][]).map(
            ([value, label]) => (
              <FilterChip
                key={value}
                active={search.type === value}
                onClick={() =>
                  setSearch({ type: search.type === value ? "all" : value })
                }
              >
                {label}
              </FilterChip>
            ),
          )}
        </FilterChipGroup>
        <FilterChipGroup label="Filter topics by status">
          {(
            [
              ["open", "Open"],
              ["solved", "Solved"],
            ] as const
          ).map(([value, label]) => (
            <FilterChip
              key={value}
              active={search.status === value}
              onClick={() =>
                setSearch({ status: search.status === value ? "all" : value })
              }
            >
              {label}
            </FilterChip>
          ))}
        </FilterChipGroup>
        <FilterChip
          active={search.mine}
          onClick={() => setSearch({ mine: !search.mine })}
        >
          My topics
        </FilterChip>
      </FilterBar>
      {topics.isPending ? (
        <ListSkeleton rows={3} action={false} label="Loading topics…" />
      ) : topics.error ? (
        <ErrorState
          title="Could not load topics"
          description={topics.error.message}
          onRetry={() => void topics.refetch()}
        />
      ) : data?.items.length ? (
        <>
          <ul
            className="divide-y rounded-lg border bg-card transition-opacity duration-(--duration-fast) ease-standard aria-busy:opacity-60"
            aria-busy={topics.isPlaceholderData || undefined}
          >
            {data.items.map((topic) => (
              <li key={topic.id} className="px-4 py-4 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                  <Link
                    to="/support/$topicId"
                    params={{ topicId: topic.id }}
                    className="inline-flex min-w-0 items-center text-card-title wrap-anywhere underline-offset-4 hover:underline focus-visible:underline pointer-coarse:min-h-11"
                  >
                    {topic.title}
                  </Link>
                  <TopicStatus status={topic.status} />
                </div>
                <MetaLine
                  className="mt-2"
                  items={[
                    SUPPORT_TYPES[topic.type],
                    topic.author.name,
                    <span key="comments" className="inline-flex items-center gap-1.5">
                      <MessageSquare className="size-3.5" aria-hidden="true" />
                      {topic.commentCount}{" "}
                      {topic.commentCount === 1 ? "comment" : "comments"}
                    </span>,
                    <span key="active">
                      Active <PostTime at={topic.lastActivityAt} />
                    </span>,
                  ]}
                />
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
          icon={<MessageSquare />}
          title={filtered ? "No topics match these filters" : "No topics yet"}
          description={
            filtered
              ? "Try a different search term or clear the filters."
              : "Share a bug report, a question, or an idea."
          }
          action={
            filtered ? (
              <Button variant="outline" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            ) : (
              <Button render={<Link to="/support/new" />}>New topic</Button>
            )
          }
        />
      )}
    </PageShell>
  );
}
