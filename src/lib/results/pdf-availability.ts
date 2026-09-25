import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";
import { allLinksReleased } from "./release-eligibility";

// PostgREST caps an `in (…)` list only by URL length; 200 uuids stay well
// inside it, the same chunk the claim-remarks reader uses.
const CHUNK = 200;

type LinkRow = {
  test_request_id: string;
  result_id: string;
  created_at: string;
  results: { storage_path: string | null } | { storage_path: string | null }[] | null;
};

type SiblingRow = {
  result_id: string;
  test_requests: { status: string } | { status: string }[] | null;
};

export type PdfState = {
  // The file the route streams for this test (its newest link). Tests that
  // share one consolidated PDF share this id; a visit's chemistry panel can
  // also end up split over several files (legacy per-test results, or a test
  // finalised after the first report) — see reportCardKey.
  resultId: string;
  // Every test linked to this PDF is released. A consolidated chemistry
  // report is ONE file shared by the whole panel and release is per line, so
  // this is what decides whether reception may print it (canViewResultPdf's
  // `reportReleased`). A single-test result has one link, so it reduces to
  // "this line is released".
  reportReleased: boolean;
};

/**
 * For each of these test_requests that has a result PDF the staff PDF route
 * (`/staff/results/[id]/pdf`) would stream, whether that file is fully
 * released. Tests with no file are absent from the map — so a page draws
 * "Print result" / "View PDF" only where the link answers with a file.
 *
 * Mirrors the route's own choices exactly:
 *  - a test can carry more than one result link over its life (amendments),
 *    and the route streams the NEWEST one, so the newest link must have a
 *    `storage_path`; an older link with a file does not count;
 *  - "fully released" is `allLinksReleased` over every test linked to that
 *    result — the check the route (and the portal) runs before serving it.
 *
 * Call with the signed-in staff client: `results`, `result_test_requests` and
 * `test_requests` are readable by every staff role (0151 "authenticated
 * read"; test_requests is role-gated, not section-gated), so a sibling in a
 * section this role cannot open still counts. This answers only "is there a
 * file, and is all of it released" — never what is in it.
 */
export async function resultPdfStates(
  supabase: SupabaseClient<Database>,
  testRequestIds: readonly string[],
): Promise<Map<string, PdfState>> {
  const ids = Array.from(new Set(testRequestIds));
  const links: LinkRow[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data } = await supabase
      .from("result_test_requests")
      .select("test_request_id, result_id, created_at, results!inner ( storage_path )")
      .in("test_request_id", ids.slice(i, i + CHUNK));
    if (data) links.push(...(data as LinkRow[]));
  }

  const newest = newestLinkWithPdf(links);
  const resultIds = Array.from(new Set(newest.values()));
  const siblings: SiblingRow[] = [];
  for (let i = 0; i < resultIds.length; i += CHUNK) {
    const { data } = await supabase
      .from("result_test_requests")
      .select("result_id, test_requests!inner ( status )")
      .in("result_id", resultIds.slice(i, i + CHUNK));
    if (data) siblings.push(...(data as SiblingRow[]));
  }
  return pdfStates(newest, siblings);
}

/**
 * Pure: test id → result id of its NEWEST link, kept only when that link's
 * result has a stored file. Exported for the unit test.
 */
export function newestLinkWithPdf(rows: readonly LinkRow[]): Map<string, string> {
  const newest = new Map<string, LinkRow>();
  for (const row of rows) {
    const seen = newest.get(row.test_request_id);
    if (!seen || row.created_at > seen.created_at) {
      newest.set(row.test_request_id, row);
    }
  }
  const withPdf = new Map<string, string>();
  for (const [id, row] of newest) {
    const r = Array.isArray(row.results) ? row.results[0] : row.results;
    if (r?.storage_path) withPdf.set(id, row.result_id);
  }
  return withPdf;
}

/** Pure: fold the sibling statuses per result onto each test. Exported for the unit test. */
export function pdfStates(
  newest: ReadonlyMap<string, string>,
  siblings: readonly SiblingRow[],
): Map<string, PdfState> {
  const statusesByResult = new Map<string, string[]>();
  for (const row of siblings) {
    const tr = Array.isArray(row.test_requests) ? row.test_requests[0] : row.test_requests;
    const list = statusesByResult.get(row.result_id) ?? [];
    list.push(tr?.status ?? "");
    statusesByResult.set(row.result_id, list);
  }
  const out = new Map<string, PdfState>();
  for (const [testId, resultId] of newest) {
    // No sibling rows read back → allLinksReleased([]) is false: fail closed.
    out.set(testId, {
      resultId,
      reportReleased: allLinksReleased(statusesByResult.get(resultId) ?? []),
    });
  }
  return out;
}

/**
 * The lab queue folds a visit's report-group tests (the chemistry panel) into
 * one card. On the Released today tab, where the card carries Print result /
 * View PDF, that fold must not cross FILES: a panel split over two PDFs
 * would list every test while its one button printed only the first file —
 * an incomplete handout. So there the key also carries the file, and each
 * PDF gets its own card with its own whole-report release check. Tests with
 * no file share one card, as before.
 */
export function reportCardKey(
  visitId: string,
  reportGroupId: string,
  resultId: string | undefined,
  splitByFile: boolean,
): string {
  const base = `${visitId}|${reportGroupId}`;
  return splitByFile ? `${base}|${resultId ?? "no-file"}` : base;
}
