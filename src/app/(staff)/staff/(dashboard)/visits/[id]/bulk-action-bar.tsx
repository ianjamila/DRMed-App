"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import { FixedBottomBar } from "@/components/staff/fixed-bottom-bar";
import { isTextTarget, useBarFocus } from "@/components/staff/row-selection/bar-focus";
import { ShortcutsHelp } from "@/components/staff/row-selection/shortcuts-help";
import { BulkOutcomePanel } from "@/components/staff/row-selection/bulk-outcome";
import { UNDO_ALREADY, UNDO_EXPIRED, UNDO_WINDOW_MS } from "@/lib/ui/bulk-undo";
import { RELEASE_MEDIUM_OPTIONS, type ReleaseMedium } from "@/lib/visits/release-media";
import { releaseOutcomeText, useReleaseOutcome } from "@/components/staff/release/release-outcome";
import {
  releaseSelectedAction,
  undoReleaseBatchAction,
  undoReleaseSelectedAction,
} from "./actions";
import { useRowSelection } from "./selection-context";
import { RELEASE_BLOCKED_CONSENT, RELEASE_BLOCKED_UNPAID } from "@/lib/visits/release-messages";

// Undo state for a "Release selected" batch — server-checked, 10-minute
// window (owner 2026-09-28). Kept as local state, not tied to
// `selectionEdits` (this page's SelectionProvider has none): it persists
// until Dismiss or the operator runs a NEW release/unrelease action, even
// though a successful release always clears the ids it acted on (which would
// otherwise make `totalSelected === 0` unmount the whole bar, taking the
// outcome with it — see the render branch below).
interface ReleaseOutcome {
  message: string;
  undo: ReleaseUndo | null;
}

// `notified`: the release sent the patient a notice (notifiedCount > 0) —
// only then does the Undo message warn that it cannot be taken back.
interface ReleaseUndo {
  batchId: string;
  doneAt: number;
  notified: boolean;
}

const ALREADY_NOTIFIED = "The patient was already notified that results are ready — tell them if needed.";

interface Props {
  visitId: string;
  moneySettled: boolean;
  // Pre-selected medium from the patient's preferred_release_medium when set,
  // mirrors ReleaseButton/ReleaseAllButton's default logic.
  preferredMedium: ReleaseMedium | null;
  consentOnFile: boolean;
  gateRequired: boolean;
  // Patient viewed/downloaded counts for the visit's released rows, computed
  // server-side by the page — the unrelease group shows a loud warning when
  // any selected result has already been seen (same message the per-row undo
  // dialog carries; bulk must not be a quiet bypass).
  viewedCountById: Record<string, number>;
  // 0172 §5 / §9 R6: which of the visit's released rows share a finished
  // combined report, and that report's full membership — display only, so
  // the bar can show "this also undoes N more tests" before the operator
  // confirms. The server expansion in undoReleaseSelectedAction is what
  // actually decides what reverts.
  reportScopeByTrId: Record<string, { memberIds: string[]; label: string }>;
  // Live ready-for-release ids on the visit — with reportScopeByTrId, lets the
  // bar preview how many more tests a release pulls in (display only).
  readyIds: string[];
}

// Sticky bottom toolbar (same pattern as the hmo-claims bulk bars) that
// appears once at least one row is selected in either bucket. Rendered as
// the last child inside the SelectionProvider wrapping the Tests section, so
// it stays in-flow — no overlap with the Payments section below — and sticks
// to the viewport bottom while the Tests tables are in view. Release and
// unrelease are independent actions with independent pending/enabled state —
// a receptionist can have some ready-for-release rows and some released rows
// checked at once (e.g. re-doing a release with the wrong medium) and act on
// either group without disturbing the other's checkboxes.
export function BulkActionBar({
  visitId,
  moneySettled,
  preferredMedium,
  consentOnFile,
  gateRequired,
  viewedCountById,
  reportScopeByTrId,
  readyIds,
}: Props) {
  // #261's page-level notice (survives the refresh that remounts rows):
  // used here only for a release that released nothing — a successful one
  // reports in this bar's own outcome panel, next to its Undo.
  const releaseNotice = useReleaseOutcome();
  const {
    releaseIds,
    unreleaseIds,
    releaseCount,
    unreleaseCount,
    clear,
    clearIds,
  } = useRowSelection();
  const [medium, setMedium] = useState<ReleaseMedium>(
    preferredMedium ?? "physical",
  );
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [releasePending, startRelease] = useTransition();
  const [unreleasePending, startUnrelease] = useTransition();
  // Separate from releasePending/unreleasePending so an Undo in flight isn't
  // mistaken for (or blocked by) a fresh bulk action, and double-clicking
  // ↶ Undo itself can't fire two undos.
  const [undoPending, startUndo] = useTransition();
  const [outcome, setOutcome] = useState<ReleaseOutcome | null>(null);
  const totalSelected = releaseCount + unreleaseCount;
  const barRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useBarFocus(barRef, totalSelected > 0);
  const clearAndReturn = useCallback(() => {
    restoreFocus();
    clear();
    setReason("");
    setReasonError(null);
  }, [restoreFocus, clear]);

  // Same rule as the kit's BulkBar: Escape clears the selection unless a
  // dialog/sheet is open or focus is in a text field (the reason input).
  useEffect(() => {
    if (totalSelected === 0) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (document.querySelector('[role="dialog"]')) return;
      if (isTextTarget(event.target)) return;
      clearAndReturn();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [totalSelected, clearAndReturn]);

  if (totalSelected === 0) {
    return outcome ? (
      <BulkOutcomePanel
        message={outcome.message}
        undo={undoProp(outcome.undo)}
        onDismiss={() => setOutcome(null)}
      />
    ) : null;
  }

  const blockedForConsent = gateRequired && !consentOnFile;
  const releaseDisabled =
    releasePending || releaseCount === 0 || !moneySettled || blockedForConsent;
  const releaseTitle = !moneySettled
    ? RELEASE_BLOCKED_UNPAID
    : blockedForConsent
      ? RELEASE_BLOCKED_CONSENT
      : undefined;

  // Undo is a corrective action, not a delivery event — it's never
  // payment-gated (a visit can go back to unpaid after release, e.g. a void).
  const unreleaseDisabled = unreleasePending || unreleaseCount === 0;

  // Display-only preview of the server's whole-report expansion (0172 §5 /
  // §9 R6): every combined report any selected row belongs to, deduplicated,
  // so the operator sees "this also undoes N more tests" before confirming.
  // undoReleaseSelectedAction re-derives and enforces this itself — this is
  // never what actually decides what reverts.
  const touchedReports = new Map<string, { memberIds: string[]; label: string }>();
  const expandedIds = new Set<string>(unreleaseIds);
  for (const trId of unreleaseIds) {
    const scope = reportScopeByTrId[trId];
    if (!scope) continue;
    touchedReports.set(scope.label + ":" + scope.memberIds.join(","), scope);
    for (const id of scope.memberIds) expandedIds.add(id);
  }
  const extraFromReports = expandedIds.size - unreleaseCount;
  const viewedSelected = Array.from(expandedIds).filter(
    (trId) => (viewedCountById[trId] ?? 0) > 0,
  ).length;

  // Display-only preview of the release side of the whole-report rule:
  // releasing one member of a combined report releases every ready member, so
  // count the ready members the selection does not already include.
  // releaseSelectedAction re-derives and enforces this itself.
  const readySet = new Set(readyIds);
  const selectedRelease = new Set<string>(releaseIds);
  const alsoReleased = new Set<string>();
  for (const trId of releaseIds) {
    const scope = reportScopeByTrId[trId];
    if (!scope) continue;
    for (const id of scope.memberIds) {
      if (readySet.has(id) && !selectedRelease.has(id)) alsoReleased.add(id);
    }
  }
  const releaseExtra = alsoReleased.size;

  function onRelease() {
    // Snapshot the ids being sent so success only clears exactly this batch —
    // rows in the other bucket, or ticked while the action is in flight,
    // keep their checkmarks.
    const sentIds = releaseIds;
    // A new deliberate bulk action replaces whatever outcome/Undo the last
    // one left showing.
    setOutcome(null);
    startRelease(async () => {
      const result = await releaseSelectedAction(visitId, sentIds, medium);
      if (!result.ok) {
        // Nothing was released — keep the selection. #261's page-level
        // notice carries the reason; alert is the no-provider fallback.
        if (releaseNotice) releaseNotice.show(result.error);
        else alert(result.error);
        return;
      }
      clearIds(sentIds);
      // #261's outcome text (count, the tests a combined report pulled in,
      // each skipped reason, warnings) in this bar's own panel, with ↶ Undo.
      // The bar is not remounted by the refresh, so the panel survives it.
      const lines = [
        releaseOutcomeText({
          changedCount: result.count,
          alsoReleasedCount: result.alsoReleasedCount,
          skipped: result.skipped,
          warnings: result.warnings,
        }) ?? "",
      ];
      // Undo does not un-notify: say so only when a notice actually went out.
      const notified = (result.notifiedCount ?? 0) > 0;
      if (notified) lines.push(ALREADY_NOTIFIED);
      setOutcome({
        message: lines.filter(Boolean).join("\n"),
        undo: result.batchId ? { batchId: result.batchId, doneAt: Date.now(), notified } : null,
      });
    });
  }

  function onUnrelease() {
    if (!reason.trim()) {
      setReasonError("Reason is required.");
      return;
    }
    setReasonError(null);
    const sentIds = unreleaseIds;
    setOutcome(null);
    startUnrelease(async () => {
      const result = await undoReleaseSelectedAction(
        visitId,
        sentIds,
        reason.trim(),
      );
      if (!result.ok) {
        alert(result.error);
        return;
      }
      if (result.count < sentIds.length) {
        alert(
          `Unreleased ${result.count} of ${sentIds.length} selected — the rest had already changed.`,
        );
      }
      setReason("");
      clearIds(sentIds);
    });
  }

  // ↶ Undo for a "Release selected" batch (server-checked 10-minute window).
  function runUndo(undo: ReleaseUndo) {
    if (undoPending) return;
    startUndo(async () => {
      const result = await undoReleaseBatchAction({ batchId: undo.batchId });
      if (!result.ok) {
        const gone = result.error === UNDO_EXPIRED || result.error === UNDO_ALREADY;
        setOutcome({ message: result.error, undo: gone ? null : undo });
        return;
      }
      const restored = result.restoredIds.length;
      let message =
        restored > 0
          ? `Undone — ${restored} test${restored === 1 ? " is" : "s are"} back to Ready for release.${undo.notified ? ` ${ALREADY_NOTIFIED}` : ""}`
          : "Nothing was undone.";
      if (result.notRestored.length > 0) {
        message += `\nNot undone (${result.notRestored.length}): ${result.notRestored
          .map((n) => n.reason)
          .join("; ")}`;
      }
      setOutcome({ message, undo: null });
    });
  }

  function undoProp(undo: ReleaseUndo | null) {
    return undo
      ? { doneAt: undo.doneAt, windowMs: UNDO_WINDOW_MS, pending: undoPending, onUndo: () => runUndo(undo) }
      : null;
  }

  return (
    <FixedBottomBar>
      <Panel
        ref={barRef}
        tabIndex={-1}
        role="region"
        aria-label="Bulk actions"
        aria-keyshortcuts="Alt+B"
        className="flex flex-wrap items-center gap-3 p-3 shadow-lg"
      >
        {outcome ? (
          <BulkOutcomePanel
            inline
            message={outcome.message}
            undo={undoProp(outcome.undo)}
            onDismiss={() => setOutcome(null)}
          />
        ) : null}

        <div
          aria-live="polite"
          className="text-xs text-[color:var(--color-brand-text-soft)]"
        >
          <span className="font-semibold text-[color:var(--color-brand-navy)]">
            {totalSelected}
          </span>{" "}
          selected
          {releaseCount > 0 ? ` · ${releaseCount} ready` : ""}
          {unreleaseCount > 0 ? ` · ${unreleaseCount} released` : ""}
        </div>

        <button
          type="button"
          onClick={clearAndReturn}
          className="text-xs font-semibold text-[color:var(--color-brand-text-soft)] hover:underline"
        >
          Clear
        </button>

        <ShortcutsHelp />

        <div data-bar-actions className="ml-auto flex flex-wrap items-center gap-2">
          {releaseCount > 0 ? (
            <div className="flex items-center gap-1.5">
              {!consentOnFile && !gateRequired ? (
                <span className="text-[11px] text-amber-600">
                  Consent not on file
                </span>
              ) : null}
              <select
                value={medium}
                onChange={(e) => setMedium(e.target.value as ReleaseMedium)}
                disabled={releaseDisabled}
                title={releaseTitle ?? "Release medium"}
                className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1 text-xs focus:border-[color:var(--color-brand-cyan)] focus:outline-none disabled:opacity-50"
              >
                {RELEASE_MEDIUM_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {releaseExtra > 0 ? (
                <span className="rounded-md border border-violet-300 bg-violet-50 px-2 py-1 text-[11px] font-semibold text-violet-900">
                  Releasing these also releases {releaseExtra} other test
                  {releaseExtra === 1 ? "" : "s"} on the same combined report.
                </span>
              ) : null}
              <Button
                type="button"
                size="sm"
                disabled={releaseDisabled}
                title={releaseTitle}
                className="bg-[color:var(--color-brand-cyan)] text-white hover:bg-[color:var(--color-brand-navy)]"
                onClick={onRelease}
              >
                {releasePending
                  ? "Releasing…"
                  : `Release selected (${releaseCount})`}
              </Button>
            </div>
          ) : null}

          {unreleaseCount > 0 ? (
            <div className="flex items-center gap-1.5">
              {touchedReports.size > 0 ? (
                <span className="rounded-md border border-violet-300 bg-violet-50 px-2 py-1 text-[11px] font-semibold text-violet-900">
                  {Array.from(touchedReports.values())
                    .map((r) => `the whole ${r.label} report (${r.memberIds.length} tests)`)
                    .join(", ")}{" "}
                  {touchedReports.size === 1 ? "will" : "will each"} be undone as
                  a whole{extraFromReports > 0 ? ` — ${extraFromReports} more test${extraFromReports === 1 ? "" : "s"} beyond your selection` : ""}.
                </span>
              ) : null}
              {viewedSelected > 0 ? (
                <span className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800">
                  {viewedSelected === 1
                    ? expandedIds.size === 1
                      ? "Patient already viewed the selected result — undoing does not un-see it."
                      : `Patient already viewed 1 of the ${expandedIds.size} affected results — undoing does not un-see it.`
                    : `Patient already viewed ${viewedSelected} of the ${expandedIds.size} affected results — undoing does not un-see them.`}
                </span>
              ) : null}
              <input
                type="text"
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  if (reasonError) setReasonError(null);
                }}
                placeholder="Reason (required)…"
                disabled={unreleasePending}
                className="w-40 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1 text-xs focus:border-[color:var(--color-brand-cyan)] focus:outline-none disabled:opacity-50"
              />
              {reasonError ? (
                <span className="text-[11px] text-red-600">{reasonError}</span>
              ) : null}
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={unreleaseDisabled}
                onClick={onUnrelease}
              >
                {unreleasePending
                  ? "Undoing…"
                  : `Unrelease selected (${unreleaseCount})`}
              </Button>
            </div>
          ) : null}
        </div>
      </Panel>
    </FixedBottomBar>
  );
}
