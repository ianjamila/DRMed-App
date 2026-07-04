"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/ui/panel";
import {
  releaseSelectedAction,
  undoReleaseSelectedAction,
  type ReleaseMedium,
} from "./actions";
import { useRowSelection } from "./selection-context";

interface Props {
  visitId: string;
  paid: boolean;
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
}

const MEDIUM_OPTIONS: { value: ReleaseMedium; label: string }[] = [
  { value: "physical", label: "Physical" },
  { value: "email", label: "Email" },
  { value: "viber", label: "Viber" },
  { value: "gcash", label: "GCash" },
  { value: "pickup", label: "Pickup" },
  { value: "other", label: "Other" },
];

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
  paid,
  preferredMedium,
  consentOnFile,
  gateRequired,
  viewedCountById,
}: Props) {
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

  const totalSelected = releaseCount + unreleaseCount;
  if (totalSelected === 0) return null;

  const blockedForConsent = gateRequired && !consentOnFile;
  const releaseDisabled =
    releasePending || releaseCount === 0 || !paid || blockedForConsent;
  const releaseTitle = !paid
    ? "Visit must be paid before release"
    : blockedForConsent
      ? "Patient consent not on file — capture consent first"
      : undefined;

  // Undo is a corrective action, not a delivery event — it's never
  // payment-gated (a visit can go back to unpaid after release, e.g. a void).
  const unreleaseDisabled = unreleasePending || unreleaseCount === 0;
  const viewedSelected = unreleaseIds.filter(
    (trId) => (viewedCountById[trId] ?? 0) > 0,
  ).length;

  function onRelease() {
    // Snapshot the ids being sent so success only clears exactly this batch —
    // rows in the other bucket, or ticked while the action is in flight,
    // keep their checkmarks.
    const sentIds = releaseIds;
    startRelease(async () => {
      const result = await releaseSelectedAction(visitId, sentIds, medium);
      if (!result.ok) {
        alert(result.error);
        return;
      }
      if (result.count < sentIds.length) {
        alert(
          `Released ${result.count} of ${sentIds.length} selected — the rest were already handled or not yours to release.`,
        );
      }
      clearIds(sentIds);
    });
  }

  function onUnrelease() {
    if (!reason.trim()) {
      setReasonError("Reason is required.");
      return;
    }
    setReasonError(null);
    const sentIds = unreleaseIds;
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

  return (
    <Panel
      role="region"
      aria-label="Bulk actions"
      className="sticky bottom-0 z-10 mt-4 flex flex-wrap items-center gap-3 p-3 shadow-sm"
    >
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
        onClick={() => {
          clear();
          setReason("");
          setReasonError(null);
        }}
        className="text-xs font-semibold text-[color:var(--color-brand-text-soft)] hover:underline"
      >
        Clear
      </button>

      <div className="ml-auto flex flex-wrap items-center gap-2">
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
              {MEDIUM_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
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
            {viewedSelected > 0 ? (
              <span className="rounded-md border border-amber-300 bg-amber-50 px-2 py-1 text-[11px] font-semibold text-amber-800">
                {viewedSelected === 1
                  ? unreleaseCount === 1
                    ? "Patient already viewed the selected result — undoing does not un-see it."
                    : `Patient already viewed 1 of the ${unreleaseCount} selected results — undoing does not un-see it.`
                  : `Patient already viewed ${viewedSelected} of the ${unreleaseCount} selected results — undoing does not un-see them.`}
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
  );
}
