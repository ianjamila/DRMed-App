import type { SortSpec } from "./table-params";

export type SortValue = string | number | boolean | null | undefined;
type SortColumn<T> = {
  type: "text" | "number";
  value: (row: T) => SortValue;
};
export type SortAccessors<T, K extends string> = Record<K, SortColumn<T>>;

export function textColumn<T>(value: (row: T) => SortValue): SortColumn<T> {
  return { type: "text", value };
}

export function numberColumn<T>(value: (row: T) => SortValue): SortColumn<T> {
  return { type: "number", value };
}

function normalizeValue(value: SortValue, type: SortColumn<unknown>["type"]): string | number | null {
  if (value == null || (typeof value === "number" && !Number.isFinite(value))) return null;
  if (type === "text") return String(value);
  // Do not turn absent amounts or booleans into zero/one.
  if (typeof value === "boolean" || (typeof value === "string" && value.trim() === "")) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compareColumn<T>(a: T, b: T, column: SortColumn<T>, dir: SortSpec["dir"]): number {
  const av = normalizeValue(column.value(a), column.type);
  const bv = normalizeValue(column.value(b), column.type);
  if (av === null || bv === null) return av === bv ? 0 : av === null ? 1 : -1;
  const cmp = typeof av === "number" && typeof bv === "number"
    ? av - bv
    : String(av).localeCompare(String(bv));
  return cmp * (dir === "asc" ? 1 : -1);
}

/** Compare typed values, with missing values last and an ascending id tie-break.
 * TEXT identifiers stay strings, including historical non-numeric identifiers.
 * The declared column type normalizes every row independently of its comparison
 * partner, so mixed runtime types cannot produce an intransitive ordering.
 * Secondary keys retain their own direction when the primary direction changes.
 */
export function compareListRows<T extends { id: string }, K extends string>(
  a: T,
  b: T,
  sort: SortSpec<K>,
  columns: SortAccessors<T, K>,
  secondary: readonly SortSpec<NoInfer<K>>[] = [],
): number {
  const primary = compareColumn(a, b, columns[sort.key], sort.dir);
  if (primary !== 0) return primary;
  for (const next of secondary) {
    if (next.key === sort.key) continue;
    const cmp = compareColumn(a, b, columns[next.key], next.dir);
    if (cmp !== 0) return cmp;
  }
  return a.id.localeCompare(b.id);
}
