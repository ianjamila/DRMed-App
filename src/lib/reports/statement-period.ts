/**
 * Carrying the selected period across a section tab bar.
 *
 * M3: Operations and Financial statements both take a date range out of
 * `searchParams`, but neither tab bar passed `SectionTabs`' `query` prop — so
 * picking March on the Daily report and clicking "Cash & cards" dropped you
 * back on the default range. Holding your context while you change view is the
 * one job a views-bar has. `PaymentsTabs` was already doing it by hand; this is
 * that logic, shared and tested.
 *
 * Pure — takes a `URLSearchParams`, so it is testable without a router.
 */
import { isISODate } from "@/lib/dates/manila";

/**
 * Rebuild a query string from `params` keeping only `keys`, in the order given.
 * Absent keys are skipped, so an unselected page keeps its own default rather
 * than being pinned to a blank value.
 *
 * Values are validated as YYYY-MM-DD: almost every key this carries is a date,
 * and forwarding an unvalidated value would push junk from a hand-edited URL
 * into the next page's query. List a non-date key (the `shift` selector) in
 * `unvalidated` to carry it as-is — `URLSearchParams` still percent-encodes it,
 * so it cannot smuggle in a second parameter.
 */
export function carryParams(
  params: URLSearchParams,
  keys: readonly string[],
  { unvalidated = [] }: { unvalidated?: readonly string[] } = {},
): string {
  const next = new URLSearchParams();
  for (const key of keys) {
    const value = params.get(key);
    if (!value) continue;
    if (!unvalidated.includes(key) && !isISODate(value)) continue;
    next.set(key, value);
  }
  const qs = next.toString();
  return qs ? `?${qs}` : "";
}

/** A YYYY-MM-DD that is also a real calendar date (2026-13-45 is neither). */
function validDate(value: string | null): string | null {
  if (!isISODate(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y &&
    probe.getUTCMonth() === m - 1 &&
    probe.getUTCDate() === d
    ? value
    : null;
}

/**
 * The two query strings the Financial statements bar needs, because its tabs do
 * not take the same parameters: Income statement and Cash flow are periods
 * (`start`/`end`), while the Balance sheet is a single closing date (`as_of`).
 * A plain passthrough would send `start`/`end` to a page that reads neither,
 * so the period is mapped explicitly in both directions:
 *
 * - period → balance sheet: `as_of` = the period's END, i.e. the position as of
 *   the close of what you were just reading.
 * - balance sheet → period: 1 January of the as_of year through the as_of date,
 *   which is exactly what both range pages default to on their own.
 */
export function statementPeriodQueries(params: URLSearchParams): {
  range: string;
  asOf: string;
} {
  const start = validDate(params.get("start"));
  const end = validDate(params.get("end"));
  const asOfParam = validDate(params.get("as_of"));

  // An explicit period wins over as_of if a URL somehow carries both.
  if (start || end) {
    const range = new URLSearchParams();
    if (start) range.set("start", start);
    if (end) range.set("end", end);
    return {
      range: `?${range.toString()}`,
      // A start alone implies no closing date, so leave the balance sheet be.
      asOf: end ? `?as_of=${end}` : "",
    };
  }

  if (asOfParam) {
    return {
      range: `?start=${asOfParam.slice(0, 4)}-01-01&end=${asOfParam}`,
      asOf: `?as_of=${asOfParam}`,
    };
  }

  return { range: "", asOf: "" };
}

/**
 * The Operations bar and the Financial-statements bar name the same period with
 * different keys: Operations reads `from`/`to`, the income statement and cash
 * flow read `start`/`end`. Every cross-link between the two sections therefore
 * has to REMAP, exactly as `statementPeriodQueries` remaps period ↔ `as_of` —
 * forwarding `location.search` unchanged would hand each page a pair of
 * parameters it does not read, and it would silently land on that page's own
 * default range while the sentence that linked there said "for this range".
 *
 * Unlike `carryParams`, these take the page's ALREADY-RESOLVED dates rather
 * than raw params, and so deliberately do forward a defaulted range. The two
 * sections happen to share a year-to-date default today, but that is a
 * coincidence of two independent `?? ` fallbacks, not a contract — and both
 * callers sit on prose naming a specific range and a specific figure computed
 * over it, so the link has to pin the range it is talking about.
 *
 * An invalid date yields `""`, which leaves the target on its own default
 * rather than pushing junk from a hand-edited URL into the next page's query.
 */
export function operationsToStatementQuery(from: string, to: string): string {
  const start = validDate(from);
  const end = validDate(to);
  return start && end ? `?start=${start}&end=${end}` : "";
}

/** The same remap in the other direction: `start`/`end` → `from`/`to`. */
export function statementToOperationsQuery(start: string, end: string): string {
  const from = validDate(start);
  const to = validDate(end);
  return from && to ? `?from=${from}&to=${to}` : "";
}
