import type { ScenarioDifficulty } from "@/generated/catalog";

export interface CatalogSearch {
  q?: string;
  difficulty?: ScenarioDifficulty;
  category?: string;
  tags?: string[];
}

export interface NormalizedCatalogSearch {
  q: string;
  difficulty: ScenarioDifficulty | undefined;
  category: string | undefined;
  tags: string[];
}

export function validateSearch(search: Record<string, unknown>): CatalogSearch {
  const normalized = normalizeCatalogSearch(search);
  return compactCatalogSearch(normalized);
}

export function normalizeCatalogSearch(
  search: Record<string, unknown> | CatalogSearch,
): NormalizedCatalogSearch {
  const difficulty =
    typeof search.difficulty === "string"
      ? parseCatalogDifficulty(search.difficulty)
      : undefined;
  return {
    q: typeof search.q === "string" ? search.q.trim() : "",
    difficulty,
    category:
      typeof search.category === "string" && search.category.trim()
        ? search.category.trim()
        : undefined,
    tags: normalizeTags(search.tags),
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
  return compact;
}

function normalizeTags(value: unknown): string[] {
  const rawTags = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? [value]
      : [];
  return [...new Set(rawTags.flatMap((tag) => normalizeTag(tag)))].sort();
}

function parseCatalogDifficulty(value: string): ScenarioDifficulty | undefined {
  return value === "easy" || value === "medium" || value === "hard"
    ? value
    : undefined;
}

function normalizeTag(value: unknown): string[] {
  if (typeof value !== "string") return [];
  const tag = value.trim();
  return tag ? [tag] : [];
}
