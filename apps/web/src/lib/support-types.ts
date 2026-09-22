export const SUPPORT_PAGE_SIZE = 20;
export const SUPPORT_LIMITS = {
  title: 160,
  body: 20_000,
  comment: 10_000,
} as const;
export const SUPPORT_TYPES = {
  bug: "Bug",
  help: "Help",
  feedback: "Feedback",
} as const;
export type SupportTopicType = keyof typeof SUPPORT_TYPES;
export type SupportStatus = "open" | "solved";

export interface SupportAuthor {
  id: string | null;
  name: string;
}

export interface SupportTopicSummary {
  id: string;
  title: string;
  type: SupportTopicType;
  status: SupportStatus;
  author: SupportAuthor;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number;
  solvedAt: number | null;
  solvedBy: SupportAuthor | null;
  commentCount: number;
  canEdit: boolean;
  canDelete: boolean;
  canResolve: boolean;
}

export interface SupportTopic extends SupportTopicSummary {
  body: string;
}

export interface SupportComment {
  id: string;
  topicId: string;
  body: string;
  author: SupportAuthor;
  createdAt: number;
  updatedAt: number;
  canEdit: boolean;
  canDelete: boolean;
}

export interface SupportPage<T> {
  items: T[];
  page: number;
  pageSize: number;
  totalItems: number;
}

export interface SupportSearch {
  q: string;
  type: SupportTopicType | "all";
  status: SupportStatus | "all";
  mine: boolean;
  page: number;
}

export function supportPage(value: unknown): number {
  const page = Number(value);
  return Number.isSafeInteger(page) && page > 0 ? Math.min(page, 1_000_000) : 1;
}

export function validateSupportSearch(
  search: Record<string, unknown>,
): SupportSearch {
  return {
    q:
      typeof search.q === "string"
        ? search.q.trim().slice(0, SUPPORT_LIMITS.title)
        : "",
    type:
      search.type === "bug" ||
      search.type === "help" ||
      search.type === "feedback"
        ? search.type
        : "all",
    status:
      search.status === "open" || search.status === "solved"
        ? search.status
        : "all",
    mine: search.mine === true || search.mine === "true",
    page: supportPage(search.page),
  };
}
