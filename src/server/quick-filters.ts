import { cacheKey, type LocalStore } from "./store.ts";

export type QuickFilter = {
  id: string;
  name: string;
  query: string;
  builtin?: true;
};

/** Default filters offered to every user, in display order. */
export const BUILTIN_QUICK_FILTERS: readonly QuickFilter[] = [
  {
    id: "builtin-authored",
    name: "내가 작성",
    query: "is:open author:@me",
    builtin: true,
  },
  {
    id: "builtin-review-requested",
    name: "내 리뷰 요청",
    query: "is:open review-requested:@me",
    builtin: true,
  },
  {
    id: "builtin-reviewed-by",
    name: "내가 리뷰함",
    query: "reviewed-by:@me",
    builtin: true,
  },
  {
    id: "builtin-involves",
    name: "나와 관련",
    query: "is:open involves:@me",
    builtin: true,
  },
];

const MAX_FILTERS = 50;
const MAX_NAME_LENGTH = 60;
const MAX_QUERY_LENGTH = 256;
const ID_PATTERN = /^[a-z0-9-]{1,64}$/;
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;
const ALLOWED_KEYS = new Set(["id", "name", "query", "builtin"]);

/**
 * Fixed config key for the user's saved quick filters. Deliberately shaped
 * differently from connection keys (cacheKey({ connection: id })) so the two
 * never collide inside the shared "config" bucket.
 */
const storageKey = cacheKey({ quickFilters: "v1" });

type StoredQuickFilters = {
  kind: "quick-filters";
  version: 1;
  filters: QuickFilter[];
};

function invalid(): never {
  throw Error("invalid quick filters");
}

export function validateQuickFilters(input: unknown): QuickFilter[] {
  if (!Array.isArray(input) || input.length > MAX_FILTERS) invalid();
  const seen = new Set<string>();
  const filters: QuickFilter[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid();
    const record = raw as Record<string, unknown>;
    for (const key of Object.keys(record))
      if (!ALLOWED_KEYS.has(key)) invalid();
    const { id, name, query } = record;
    if (typeof id !== "string" || !ID_PATTERN.test(id) || id.startsWith("builtin-"))
      invalid();
    if (seen.has(id)) invalid();
    seen.add(id);
    if (typeof name !== "string" || CONTROL_CHARS.test(name)) invalid();
    const trimmedName = name.trim();
    if (trimmedName.length < 1 || trimmedName.length > MAX_NAME_LENGTH) invalid();
    if (typeof query !== "string" || CONTROL_CHARS.test(query)) invalid();
    const trimmedQuery = query.trim();
    if (trimmedQuery.length < 1 || trimmedQuery.length > MAX_QUERY_LENGTH)
      invalid();
    filters.push({ id, name: trimmedName, query: trimmedQuery });
  }
  return filters;
}

/**
 * Reads the saved custom filters. Returns [] for missing, corrupt or
 * partially-invalid data instead of throwing.
 */
export function loadQuickFilters(store: LocalStore): QuickFilter[] {
  const stored = store.get<unknown>("config", storageKey);
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return [];
  const record = stored as Record<string, unknown>;
  if (record.kind !== "quick-filters" || record.version !== 1) return [];
  try {
    return validateQuickFilters(record.filters);
  } catch {
    return [];
  }
}

export function saveQuickFilters(
  store: LocalStore,
  input: unknown,
): QuickFilter[] {
  const filters = validateQuickFilters(input);
  const value: StoredQuickFilters = {
    kind: "quick-filters",
    version: 1,
    filters,
  };
  store.put("config", storageKey, value);
  return filters;
}

export function quickFiltersView(store: LocalStore): {
  builtin: QuickFilter[];
  custom: QuickFilter[];
} {
  return {
    builtin: BUILTIN_QUICK_FILTERS.map((filter) => ({ ...filter })),
    custom: loadQuickFilters(store),
  };
}
