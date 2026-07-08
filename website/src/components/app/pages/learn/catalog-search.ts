import type {
  ScenarioCatalogWireEntry,
  ScenarioProgress,
} from "@/lib/scenario-runs";
import type { ScenarioDifficulty } from "@/components/app/patterns/MetaChip";
import { parseScenarioDifficulty } from "@/lib/scenario-model";

export type CatalogSort =
  | "recommended"
  | "newest"
  | "difficulty"
  | "time"
  | "title";

export interface CatalogSearch {
  q?: string;
  difficulty?: ScenarioDifficulty;
  category?: string;
  tags?: string[];
  sort?: CatalogSort;
}

export interface NormalizedCatalogSearch {
  q: string;
  difficulty: ScenarioDifficulty | undefined;
  category: string | undefined;
  tags: string[];
  sort: CatalogSort;
}

export const CATALOG_SORT_OPTIONS: Array<{
  value: CatalogSort;
  label: string;
}> = [
  { value: "recommended", label: "Recommended" },
  { value: "newest", label: "Newest" },
  { value: "difficulty", label: "Difficulty" },
  { value: "time", label: "Time" },
  { value: "title", label: "Title" },
];

const SORTS = new Set<CatalogSort>(
  CATALOG_SORT_OPTIONS.map((option) => option.value),
);

const DIFFICULTY_RANK: Record<ScenarioDifficulty, number> = {
  easy: 0,
  medium: 1,
  hard: 2,
};

const PROGRESS_RANK: Record<ScenarioProgress["status"], number> = {
  in_progress: 0,
  new: 1,
  attempted: 2,
  completed: 3,
};

export function validateSearch(search: Record<string, unknown>): CatalogSearch {
  const normalized = normalizeCatalogSearch(search);
  return compactCatalogSearch(normalized);
}

export function normalizeCatalogSearch(
  search: Record<string, unknown> | CatalogSearch,
): NormalizedCatalogSearch {
  const difficulty =
    typeof search.difficulty === "string"
      ? (parseScenarioDifficulty(search.difficulty) ?? undefined)
      : undefined;
  const sort =
    typeof search.sort === "string" && SORTS.has(search.sort as CatalogSort)
      ? (search.sort as CatalogSort)
      : "recommended";

  return {
    q: typeof search.q === "string" ? search.q.trim() : "",
    difficulty,
    category:
      typeof search.category === "string" && search.category.trim()
        ? search.category.trim()
        : undefined,
    tags: normalizeTags(search.tags),
    sort,
  };
}

export function compactCatalogSearch(
  search: NormalizedCatalogSearch,
): CatalogSearch {
  const compact: CatalogSearch = {};
  if (search.q) compact.q = search.q;
  if (search.difficulty) compact.difficulty = search.difficulty;
  if (search.category) compact.category = search.category;
  if (search.tags.length) compact.tags = search.tags;
  if (search.sort !== "recommended") compact.sort = search.sort;
  return compact;
}

export const CATALOG_SORT_COMPARATORS: Record<
  CatalogSort,
  (left: ScenarioCatalogWireEntry, right: ScenarioCatalogWireEntry) => number
> = {
  recommended: (left, right) => {
    const leftRank = PROGRESS_RANK[left.progress.status];
    const rightRank = PROGRESS_RANK[right.progress.status];
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (left.progress.status === "new" && right.progress.status === "new") {
      return right.enabledAt - left.enabledAt;
    }
    return 0;
  },
  newest: (left, right) => right.enabledAt - left.enabledAt,
  difficulty: (left, right) =>
    DIFFICULTY_RANK[left.difficulty] - DIFFICULTY_RANK[right.difficulty] ||
    left.title.localeCompare(right.title),
  time: (left, right) =>
    left.estimatedMinutes - right.estimatedMinutes ||
    left.title.localeCompare(right.title),
  title: (left, right) => left.title.localeCompare(right.title),
};

function normalizeTags(value: unknown): string[] {
  const rawTags = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  return [...new Set(rawTags.flatMap((tag) => normalizeTag(tag)))].sort();
}

function normalizeTag(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const tag = value.trim();
  return tag ? [tag] : [];
}
