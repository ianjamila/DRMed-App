"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { RELEASE_BLOCKED_CONSENT, RELEASE_BLOCKED_UNPAID } from "@/lib/visits/release-messages";
import { RELEASE_MEDIUM_OPTIONS } from "@/lib/visits/release-media";
import { releaseOutcomeText, useReleaseOutcome } from "@/components/staff/release/release-outcome";
import { releaseTestAction } from "./actions";
import type { ReleaseMedium } from "@/lib/visits/release-media";

interface Props {
  testRequestId: string;
  visitId: string;
  moneySettled: boolean;
  // Pre-selected medium from the patient's preferred_release_medium when set,
  // so reception just clicks Release in the common case.
  preferredMedium: ReleaseMedium | null;
  // Whether the patient has current data-privacy consent on file.
  consentOnFile: boolean;
  // Whether the consent release-gate is currently switched on. When on and
  // consent is missing, release is hard-blocked (the DB trigger would reject
  // it anyway). When off, missing consent is only a soft warning.
  gateRequired: boolean;
  // "compact" is used inside package-component rows, which are denser than
  // the standalone tests table.
  size?: "default" | "compact";
  // "Release report (N tests)" on a combined chemistry report; defaults to "Release".
  label?: string;
  // Whole-report rule: why this report can't be released yet (an unfinished or
  // deleted sibling). Disables the button and is shown under it. Display only —
  // releaseTestAction re-proves it.
  blockReason?: string | null;
}

export function ReleaseButton({
  testRequestId,
  visitId,
  moneySettled,
  preferredMedium,
  consentOnFile,
  gateRequired,
  size = "default",
  label = "Release",
  blockReason = null,
}: Props) {
  const outcome = useReleaseOutcome();
  const [pending, start] = useTransition();
  const [medium, setMedium] = useState<ReleaseMedium>(
    preferredMedium ?? "physical",
  );

  const blockedForConsent = gateRequired && !consentOnFile;
  const disabled = pending || !moneySettled || blockedForConsent || blockReason !== null;
  const title = !moneySettled
    ? RELEASE_BLOCKED_UNPAID
    : blockedForConsent
      ? RELEASE_BLOCKED_CONSENT
      : (blockReason ?? undefined);

  const textCls = size === "compact" ? "text-[10px]" : "text-xs";
  const btnSizeCls = size === "compact" ? "text-[10px] min-h-[28px]" : "";

  return (
    <div className="flex flex-col items-end gap-0.5">
      <div className="flex items-center justify-end gap-1.5">
        {!consentOnFile && !gateRequired ? (
          <span className="text-[11px] text-amber-600">Consent not on file</span>
        ) : null}
        <select
          value={medium}
          onChange={(e) => setMedium(e.target.value as ReleaseMedium)}
          disabled={disabled}
          title={title ?? "Release medium"}
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
          title={title}
          className={`bg-[color:var(--color-brand-cyan)] text-white hover:bg-[color:var(--color-brand-navy)] ${btnSizeCls}`}
          onClick={() =>
            start(async () => {
              const result = await releaseTestAction(testRequestId, visitId, medium);
              // The page refreshes on success and unmounts this button, so the
              // outcome goes to the page-level provider (alert is the fallback).
              const text = result.ok
                ? releaseOutcomeText({
                    changedCount: result.changedCount,
                    alsoReleasedCount: result.alsoReleasedCount,
                    skipped: result.skipped,
                    warnings: result.warnings,
                  })
                : result.error;
              if (text) {
                if (outcome) outcome.show(text);
                else alert(text);
              }
            })
          }
        >
          {pending ? "Releasing…" : label}
        </Button>
      </div>
      {blockReason ? (
        <span className={`${textCls} max-w-[16rem] text-right text-[color:var(--color-brand-text-soft)]`}>
          {blockReason}
        </span>
      ) : null}
    </div>
  );
}
