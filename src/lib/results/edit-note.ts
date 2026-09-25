/**
 * The visit page's per-row "Edited <date/time> — <reason>" note (0172, PR 2
 * §6.1).
 *
 * A single-test report needs no special handling — one row, one note. A
 * COMBINED report (chemistry) shares one `results` row across several
 * `test_requests`, but the visit page still renders one table row PER member
 * test (unlike the results archive, which folds a report into one row). If
 * every member printed the same "Edited … — reason" line it would read as N
 * separate edits instead of one. So only the FIRST member (in the page's own
 * render order) gets the full note; later members point at it instead.
 *
 * Order-preserving fold (CLAUDE.md): "first" is decided by the order `rows`
 * is given in, not by any re-sort here — the caller must pass rows in the
 * order they render.
 *
 * Pure — no Supabase, no `server-only` import. `manilaDateTime` is a plain
 * formatter, not I/O.
 */
import { manilaDateTime } from "@/lib/dates/manila";

export interface EditNoteTestRow {
  id: string;
  /** The service name, used for the "see <test>" pointer on a later member. */
  name: string;
  /** The result this test links to, or null when it has none. */
  resultId: string | null;
  amendedAt: string | null;
  amendmentCount: number;
}

/**
 * One note per amended test id, ready to render as-is:
 *  - the first member of an amended result: "Edited <date> — <reason>",
 *    with a " (×N)" suffix when `amendmentCount > 1`;
 *  - a later member of the SAME amended result: "Edited — see <first test>";
 *  - an unamended test, or one whose result carries no reason on record: no
 *    entry (the caller shows nothing, which is correct for reception, who
 *    never receives a reason for a result RLS keeps them from reading).
 */
export function foldEditNotes(
  rows: readonly EditNoteTestRow[],
  reasonByResultId: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  const noteByTestId = new Map<string, string>();
  const firstNameByResultId = new Map<string, string>();

  for (const r of rows) {
    if (!r.resultId || r.amendmentCount <= 0 || !r.amendedAt) continue;
    const reason = reasonByResultId.get(r.resultId);
    if (!reason) continue; // RLS returned no rows (e.g. reception) — show nothing.

    const firstName = firstNameByResultId.get(r.resultId);
    if (!firstName) {
      firstNameByResultId.set(r.resultId, r.name);
      const suffix = r.amendmentCount > 1 ? ` (×${r.amendmentCount})` : "";
      noteByTestId.set(
        r.id,
        `Edited ${manilaDateTime(r.amendedAt)}${suffix} — ${reason}`,
      );
    } else {
      noteByTestId.set(r.id, `Edited — see ${firstName}`);
    }
  }

  return noteByTestId;
}
