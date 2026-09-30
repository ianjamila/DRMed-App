"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { releaseTestsAction } from "@/app/(staff)/staff/(dashboard)/queue/actions";
import { RELEASE_MEDIUM_OPTIONS, type ReleaseMedium } from "@/lib/visits/release-media";
import { releaseOutcomeText, useReleaseOutcome } from "./release-outcome";

// The lab queue's Release control. Bench page, consolidated report, queue row
// and panel card differ only in the ids they send; releaseTestsAction
// re-proves every row and releases a combined report whole or not at all.
// Outcomes go to the page-level ReleaseOutcomeProvider (this button unmounts
// on the refresh); the inline message is the no-provider fallback and the
// place for input errors.
export function QueueReleaseButton({
  testRequestIds,
  preferredMedium,
  blockReason,
  consentWarning = false,
  label = "Release",
  size = "default",
}: {
  testRequestIds: string[];
  preferredMedium: ReleaseMedium | null;
  /** evaluateRelease's refusal, or null when it can be released. */
  blockReason: string | null;
  /** Consent missing while the gate is off — a warning, not a block. */
  consentWarning?: boolean;
  label?: string;
  size?: "default" | "compact";
}) {
  const router = useRouter();
  const outcome = useReleaseOutcome();
  const [pending, start] = useTransition();
  const [medium, setMedium] = useState<ReleaseMedium>(preferredMedium ?? "physical");
  const [message, setMessage] = useState<string | null>(null);
  const disabled = pending || blockReason !== null;
  const textCls = size === "compact" ? "text-[10px]" : "text-xs";

  function release() {
    start(async () => {
      setMessage(null);
      const res = await releaseTestsAction({ testRequestIds, medium });
      if (!res.ok) {
        setMessage(res.error);
        return;
      }
      const text = releaseOutcomeText({
        changedCount: res.changedIds.length,
        alsoReleasedCount: res.alsoReleasedIds.length,
        skipped: res.skipped,
        warnings: res.warnings,
      });
      if (text) {
        if (outcome) outcome.show(text);
        else setMessage(text);
      }
      if (res.changedIds.length > 0 || res.alsoReleasedIds.length > 0) router.refresh();
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center justify-end gap-1.5">
        {consentWarning ? <span className="text-[11px] text-amber-600">Consent not on file</span> : null}
        <select
          value={medium}
          onChange={(e) => setMedium(e.target.value as ReleaseMedium)}
          disabled={disabled}
          aria-label="Release medium"
          className={`rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1 focus:border-[color:var(--color-brand-cyan)] focus:outline-none disabled:opacity-50 ${textCls}`}
        >
          {RELEASE_MEDIUM_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <Button
          type="button"
          size="sm"
          disabled={disabled}
          title={blockReason ?? undefined}
          className="bg-[color:var(--color-brand-cyan)] text-white hover:bg-[color:var(--color-brand-navy)]"
          onClick={release}
        >
          {pending ? "Releasing…" : label}
        </Button>
      </div>
      {blockReason ? (
        <span className={`${textCls} max-w-[18rem] text-right text-[color:var(--color-brand-text-soft)]`}>{blockReason}</span>
      ) : null}
      {message ? (
        <span role="status" className={`${textCls} max-w-[18rem] whitespace-pre-line text-right text-amber-700`}>
          {message}
        </span>
      ) : null}
    </div>
  );
}
