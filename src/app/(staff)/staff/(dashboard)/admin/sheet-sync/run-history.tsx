import { createClient } from "@/lib/supabase/server";
import { manilaDateTime } from "@/lib/dates/manila";
import { Panel } from "@/components/ui/panel";
import { ListPagination, PAGE_SIZES } from "@/components/staff/list-pagination";
import {
  buildListHref,
  DEFAULT_PAGE_SIZE,
  pageCount,
  parsePage,
  parsePageSize,
  rangeFor,
} from "@/lib/ui/table-params";
import type { ReleaseSummary, RevertSummary } from "@/lib/sheet-sync/run";
import type { TabKey } from "@/lib/sheet-sync/types";
import { ReleaseUndoButton, UndoRunButton } from "./sync-controls";
import { canRelease, canUndo, durationLabel, releaseSummaryLine, revertSummaryLine, STATUS_LABEL, tabErrorLabel, TAB_LABEL, TRIGGER_LABEL } from "./format";

const BASE_PATH = "/staff/admin/sheet-sync";

interface RunTabOutcome {
  status?: string;
  applied?: Record<string, number>;
  mirror_rows?: number;
  error?: string;
}

interface RunRow {
  id: string;
  trigger: string;
  dry_run: boolean;
  status: string;
  started_at: string;
  ended_at: string | null;
  per_tab: Record<string, RunTabOutcome> | null;
  summary: { duration_ms?: number; result?: unknown } | null;
  error: string | null;
  reverted_by_run_id: string | null;
  released_by_run_id: string | null;
  undo_run: { started_at: string } | null;
}

function whatChanged(run: RunRow): string {
  if (run.trigger === "resort" || run.trigger === "alias" || run.trigger === "revert" || run.trigger === "release") {
    const result = run.summary?.result;
    if (run.trigger === "revert" && result && typeof result === "object") {
      return revertSummaryLine(result as RevertSummary);
    }
    if (run.trigger === "release" && result && typeof result === "object") {
      return releaseSummaryLine(result as ReleaseSummary);
    }
    if (typeof result === "number") return `${result} patient${result === 1 ? "" : "s"} updated`;
    return "—";
  }

  const per = run.per_tab ?? {};
  const parts: string[] = [];
  const applied = per.customers?.applied;
  if (applied) {
    const bits = [
      applied.created ? `${applied.created} created` : null,
      applied.filled ? `${applied.filled} filled` : null,
      applied.linked ? `${applied.linked} linked` : null,
    ].filter((b): b is string => b !== null);
    if (bits.length) parts.push(bits.join(", "));
  }
  for (const tab of ["customers", "lab", "consult"] as TabKey[]) {
    const mr = per[tab]?.mirror_rows;
    if (mr !== undefined) parts.push(`${TAB_LABEL[tab]}: ${mr} copied row${mr === 1 ? "" : "s"}`);
  }
  return parts.length ? parts.join(" · ") : "—";
}

function tabErrors(run: RunRow): string | null {
  if (run.error) return run.error;
  const per = run.per_tab ?? {};
  const errs = Object.entries(per)
    .filter(([, out]) => out?.status === "failed" && out.error)
    .map(([tab, out]) => `${TAB_LABEL[tab as TabKey] ?? tab}: ${tabErrorLabel(tab as TabKey, out.error)}`);
  return errs.length ? errs.join("; ") : null;
}

export async function RunHistory({ searchParams }: { searchParams: Record<string, string | undefined> }) {
  const supabase = await createClient();
  const page = parsePage(searchParams.page);
  const size = parsePageSize(searchParams.size);
  const [from, to] = rangeFor(page, size);

  const { data, count, error } = await supabase
    .from("sheet_sync_runs")
    .select(
      "id, trigger, dry_run, status, started_at, ended_at, per_tab, summary, error, reverted_by_run_id, released_by_run_id, " +
        // Self-referencing FK: PostgREST's embed hint here must be the COLUMN
        // name, not the constraint name — sheet_sync_runs!<constraint> returns
        // PGRST200 ("Could not find a relationship between 'sheet_sync_runs'
        // and 'sheet_sync_runs'") even after a schema cache reload; verified
        // directly against the local PostgREST API.
        "undo_run:sheet_sync_runs!reverted_by_run_id(started_at)",
      { count: "exact" },
    )
    .order("started_at", { ascending: false })
    .order("id", { ascending: true })
    .range(from, to);

  if (error) {
    console.error("sheet sync run history load failed", error);
    return (
      <p className="text-sm text-red-600" role="alert">
        Could not load run history. Try refreshing the page.
      </p>
    );
  }

  const runs = (data ?? []) as unknown as RunRow[];
  const total = count ?? 0;
  const totalPages = pageCount(total, size);
  const baseParams = { page: String(page), size: String(size) };

  return (
    <div>
      <Panel className="overflow-x-auto p-0">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[color:var(--color-brand-bg-mid)] text-xs font-semibold uppercase tracking-wide text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-3 py-2">Started</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2">Status</th>
              <th className="px-3 py-2">Duration</th>
              <th className="px-3 py-2">What changed</th>
              <th className="px-3 py-2">Error</th>
              <th className="px-3 py-2">Undo</th>
            </tr>
          </thead>
          <tbody>
            {runs.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-3 py-6 text-center text-[color:var(--color-brand-text-soft)]">
                  No sheet sync runs yet.
                </td>
              </tr>
            ) : (
              runs.map((run) => (
                <tr key={run.id} className="border-b border-[color:var(--color-brand-bg-mid)] align-top last:border-0">
                  <td className="px-3 py-2 whitespace-nowrap">{manilaDateTime(run.started_at)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {TRIGGER_LABEL[run.trigger] ?? run.trigger}
                    {run.dry_run ? (
                      <span className="ml-1 rounded-full bg-[color:var(--color-brand-bg)] px-2 py-0.5 text-xs font-semibold text-[color:var(--color-brand-text-mid)]">
                        Preview
                      </span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{STATUS_LABEL[run.status] ?? run.status}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{durationLabel(run.summary?.duration_ms)}</td>
                  <td className="px-3 py-2">{whatChanged(run)}</td>
                  <td className="px-3 py-2 text-red-600">{tabErrors(run) ?? "—"}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {run.reverted_by_run_id ? (
                      <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                        Undone{run.undo_run ? ` ${manilaDateTime(run.undo_run.started_at)}` : ""}
                      </span>
                    ) : canUndo(run) ? (
                      <UndoRunButton
                        runId={run.id}
                        runLabel={`the ${TRIGGER_LABEL[run.trigger] ?? run.trigger} sync run from ${manilaDateTime(run.started_at)}`}
                      />
                    ) : run.released_by_run_id ? (
                      <span className="text-xs text-[color:var(--color-brand-text-soft)]">Sync decides again</span>
                    ) : canRelease(run) ? (
                      <ReleaseUndoButton
                        undoRunId={run.id}
                        runLabel={`the undo from ${manilaDateTime(run.started_at)}`}
                      />
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Panel>

      <div className="mt-3">
        <ListPagination
          page={page}
          pageCount={totalPages}
          total={total}
          size={size}
          prevHref={
            page > 1
              ? buildListHref(BASE_PATH, { ...baseParams, view: "history" }, { page: page - 1 > 1 ? String(page - 1) : null })
              : null
          }
          nextHref={
            page < totalPages
              ? buildListHref(BASE_PATH, { ...baseParams, view: "history" }, { page: String(page + 1) })
              : null
          }
          sizeOptions={PAGE_SIZES.map((s) => ({
            size: s,
            href: buildListHref(BASE_PATH, { ...baseParams, view: "history" }, {
              size: s === DEFAULT_PAGE_SIZE ? null : String(s),
              page: null,
            }),
          }))}
          noun="run"
        />
      </div>
    </div>
  );
}
