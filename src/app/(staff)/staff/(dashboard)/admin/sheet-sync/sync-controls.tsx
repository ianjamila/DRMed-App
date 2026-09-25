"use client";

import { useState, useTransition } from "react";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { friendlyManilaDate } from "@/lib/dates/manila";
import type { TabKey } from "@/lib/sheet-sync/types";
import type { RunOutcome, RevertSummary } from "@/lib/sheet-sync/run";
import { runSheetSyncNowAction, setSheetSyncPausedAction, revertRunAction, type RunOutcomeSummary } from "./actions";
import { KIND_LABEL, TAB_LABEL } from "./format";

// ---------------------------------------------------------------------------
// Pause / resume — same confirm-before-pausing idea as online-booking's
// toggle (client.tsx), rebuilt on the shared <Switch>. Resuming is low
// stakes and applies immediately; pausing asks for an optional reason first.
// ---------------------------------------------------------------------------

export function SyncSwitch({
  paused: initialPaused,
}: {
  paused: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [paused, setPaused] = useState(initialPaused);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState("");
  const [err, setErr] = useState<string | null>(null);

  function apply(nextPaused: boolean, reasonToSend: string | null) {
    setErr(null);
    startTransition(async () => {
      const res = await setSheetSyncPausedAction({ paused: nextPaused, reason: reasonToSend });
      if (!res.ok) {
        setErr(res.error);
        return;
      }
      setPaused(nextPaused);
      setConfirming(false);
      setReason("");
    });
  }

  function onToggle(next: boolean) {
    if (!next) {
      // Turning it ON — no downside, apply right away.
      apply(false, null);
      return;
    }
    setConfirming(true);
  }

  return (
    <div>
      <div className="flex items-center gap-3">
        <Switch checked={!paused} onCheckedChange={onToggle} disabled={pending} aria-label="Sheet sync on/off" />
        <span className="text-sm font-semibold">
          {paused ? (
            <span className="text-amber-700">Paused</span>
          ) : (
            <span className="text-green-700">On — runs every night at 12:00 midnight</span>
          )}
        </span>
      </div>

      {confirming && (
        <div className="mt-3 w-full max-w-md rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm">
          <p className="font-semibold text-amber-900">Pause the nightly sheet sync?</p>
          <p className="mt-1 text-amber-800">
            The nightly run stops updating patients from the sheet until this is turned back on.
            Preview (dry run) keeps working while paused.
          </p>
          <label htmlFor="pause-reason" className="mt-2 block text-xs font-semibold text-amber-900">
            Reason (optional)
          </label>
          <textarea
            id="pause-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={400}
            placeholder="e.g. Cleaning up the sheet, will resume after."
            className="mt-1 w-full rounded-md border border-amber-300 bg-white px-2 py-1.5 text-sm"
          />
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => apply(true, reason.trim() || null)}
              className="min-h-9 rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
            >
              {pending ? "Pausing…" : "Yes, pause the sync"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                setConfirming(false);
                setReason("");
              }}
              className="min-h-9 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sync now / preview
// ---------------------------------------------------------------------------

function tabRows(perTab: RunOutcome["perTab"] | null | undefined) {
  if (!perTab) return [];
  return (Object.keys(TAB_LABEL) as TabKey[])
    .filter((tab) => perTab[tab])
    .map((tab) => ({ tab, out: perTab[tab]! }));
}

function reviewCountsLine(review: Record<string, number> | undefined) {
  if (!review || Object.keys(review).length === 0) return null;
  return Object.entries(review)
    .map(([kind, n]) => `${KIND_LABEL[kind as keyof typeof KIND_LABEL] ?? kind}: ${n}`)
    .join(" · ");
}

function PerTabPanel({ perTab }: { perTab: RunOutcome["perTab"] }) {
  const rows = tabRows(perTab);
  if (rows.length === 0) return null;
  return (
    <div className="mt-3 space-y-3">
      {rows.map(({ tab, out }) => (
        <div key={tab} className="rounded-md border border-[color:var(--color-brand-bg-mid)] p-3 text-sm">
          <p className="font-semibold text-[color:var(--color-brand-navy)]">{TAB_LABEL[tab]}</p>
          {out.status === "failed" ? (
            <p className="mt-1 text-red-600">{out.error ?? "This tab failed."}</p>
          ) : (
            <div className="mt-1 space-y-1 text-[color:var(--color-brand-text-mid)]">
              <p>
                {out.rows_read ?? 0} row{out.rows_read === 1 ? "" : "s"} read
                {out.last_date ? ` · sheet last updated ${friendlyManilaDate(out.last_date)}` : ""}
              </p>
              {tab === "customers" && out.planned ? (
                <p>
                  To link: {Number(out.planned.link_new ?? 0)} · To create: {Number(out.planned.create ?? 0)} ·
                  {" "}To fill: {Number(out.planned.fill ?? 0)} · Facts: {Number(out.planned.facts ?? 0)}
                </p>
              ) : null}
              {out.mirror_rows !== undefined ? <p>Mirror rows: {out.mirror_rows}</p> : null}
              {reviewCountsLine(out.review) ? <p>Review: {reviewCountsLine(out.review)}</p> : null}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

export function SyncNow({
  paused,
  lastRunPerTab,
}: {
  paused: boolean;
  // The latest non-dry run's per_tab, shown when idle (before this component
  // has run anything itself).
  lastRunPerTab: RunOutcome["perTab"] | null;
}) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<RunOutcomeSummary | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [runningDry, setRunningDry] = useState<boolean | null>(null);

  function run(dryRun: boolean) {
    setErr(null);
    setRunningDry(dryRun);
    startTransition(async () => {
      const res = await runSheetSyncNowAction({ dryRun });
      if (!res.ok) {
        setErr(res.error);
        return;
      }
      setResult(res.data);
      if (res.data.error) setErr(res.data.error);
    });
  }

  const perTab = result?.perTab ?? lastRunPerTab;

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => run(true)}
          className="min-h-9 rounded-md border border-[color:var(--color-brand-navy)] px-3 py-1.5 text-sm font-semibold text-[color:var(--color-brand-navy)] disabled:opacity-60"
        >
          {pending && runningDry === true ? "Reading the sheet…" : "Preview (dry run)"}
        </button>
        <button
          type="button"
          disabled={pending || paused}
          title={paused ? "Turn the sync on first. A preview works while paused." : undefined}
          onClick={() => run(false)}
          className="min-h-9 rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {pending && runningDry === false ? "Reading the sheet…" : "Sync now"}
        </button>
      </div>
      {paused && (
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          Turn the sync on first. A preview works while paused.
        </p>
      )}
      {pending && <p className="mt-2 text-sm text-[color:var(--color-brand-text-soft)]">Reading the sheet… this can take a minute.</p>}
      {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
      {result && !pending && (
        <p className="mt-2 text-sm text-[color:var(--color-brand-text-soft)]">
          {result.status === "skipped_paused" ? "Skipped — the sync is paused." : `Finished (${result.status}).`}
        </p>
      )}
      <PerTabPanel perTab={perTab ?? {}} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Undo a run — confirm dialog, from Run history.
// ---------------------------------------------------------------------------

function undoResultLine(r: RevertSummary): string {
  let line = `Put back ${r.restored} · Kept ${r.blocked} (changed since) · Removed ${r.deleted} new patients · Kept ${r.kept} (in use)`;
  if (r.gone > 0) line += ` · ${r.gone} already removed by staff`;
  if (r.held > 0) line += ` · ${r.held} link(s) returned to review`;
  return line;
}

export function UndoRunButton({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function confirm() {
    setErr(null);
    startTransition(async () => {
      const res = await revertRunAction({ runId });
      if (!res.ok) {
        setErr(res.error);
        return;
      }
      setDone(undoResultLine(res.data));
      setOpen(false);
    });
  }

  if (done) return <p className="text-xs text-[color:var(--color-brand-text-soft)]">{done}</p>;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs font-semibold text-red-700 hover:underline"
      >
        Undo
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Undo this run?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-[color:var(--color-brand-text-mid)]">
            Patients it created are removed if nothing uses them yet; details it filled in are put
            back unless someone changed that patient since. Changes to the reporting copy are not
            undone. The next sync rebuilds it.
          </p>
          {err && <p className="text-sm text-red-600">{err}</p>}
          <DialogFooter>
            <button
              type="button"
              onClick={() => setOpen(false)}
              disabled={pending}
              className="min-h-9 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={pending}
              className="min-h-9 rounded-md bg-red-700 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
            >
              {pending ? "Undoing…" : "Undo this run"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
