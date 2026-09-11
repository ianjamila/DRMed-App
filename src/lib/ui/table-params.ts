/**
 * Shared parsing for the list-page URL contract: `?sort=&dir=&page=&size=`.
 *
 * SECURITY: `sort` ends up in a PostgREST `.order()`, which interpolates the
 * column name into the request. A raw search param must therefore NEVER reach
 * it — every page declares the columns it allows and `parseSort` returns its
 * own fallback for anything else. That is why `allowed` is a required argument
 * and not an optional convenience.
 *
 * Pure string→value functions: no DB, no `server-only`, unit-testable.
 */

export type SortDir = "asc" | "desc";

export interface SortSpec<K extends string = string> {
  key: K;
  dir: SortDir;
}

/** The page sizes offered by the picker. */
export const PAGE_SIZES = [5, 10, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export const DEFAULT_PAGE_SIZE: PageSize = 25;

/**
 * Resolve `?sort=&dir=` against the columns this page actually allows.
 * Anything unrecognised — junk, a dropped column, a probe — falls back.
 */
export function parseSort<K extends string>(
  rawSort: string | undefined,
  rawDir: string | undefined,
  allowed: readonly K[],
  fallback: SortSpec<K>,
): SortSpec<K> {
  const key = allowed.find((k) => k === rawSort);
  if (!key) return fallback;
  return { key, dir: rawDir === "asc" ? "asc" : "desc" };
}

/** Resolve `?size=`, falling back to the page's default. */
export function parsePageSize(
  raw: string | undefined,
  fallback: PageSize = DEFAULT_PAGE_SIZE,
): PageSize {
  const n = Number(raw);
  return (PAGE_SIZES as readonly number[]).includes(n) ? (n as PageSize) : fallback;
}

/** Resolve `?page=` to a 1-based page number. */
export function parsePage(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 1;
}

/** Zero-based [from, to] for a PostgREST `.range()`. */
export function rangeFor(page: number, size: number): [number, number] {
  const from = (page - 1) * size;
  return [from, from + size - 1];
}

/** Total pages for a row count — always at least 1 so "Page 1 of 1" reads right. */
export function pageCount(total: number, size: number): number {
  return Math.max(1, Math.ceil(total / size));
}

/**
 * The next sort state for clicking a column header.
 *
 * First click on a new column sorts it descending (the useful default for
 * dates and money, which is what these tables mostly hold); clicking the
 * active column flips direction.
 */
export function nextSort<K extends string>(current: SortSpec<K>, key: K): SortSpec<K> {
  if (current.key !== key) return { key, dir: "desc" };
  return { key, dir: current.dir === "desc" ? "asc" : "desc" };
}

/** What a column header should report to assistive tech. */
export function ariaSortFor<K extends string>(
  current: SortSpec<K>,
  key: K,
): "ascending" | "descending" | "none" {
  if (current.key !== key) return "none";
  return current.dir === "asc" ? "ascending" : "descending";
}

/**
 * Build a list-page href, dropping params that are at their default so the
 * URL stays readable and page 1 is just `/staff/patients`.
 *
 * `overrides` set to `null` remove a param. Any change to filters or sort
 * should pass `page: null` — leaving someone on page 7 of a result set that
 * just changed shape is how you get a blank screen with no explanation.
 */
export function buildListHref(
  basePath: string,
  params: Record<string, string | null | undefined>,
  overrides: Record<string, string | null> = {},
): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...params, ...overrides })) {
    if (v) sp.set(k, v);
  }
  const qs = sp.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}
