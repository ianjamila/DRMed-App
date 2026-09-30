"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { releaseOutcomeText, useReleaseOutcome } from "@/components/staff/release/release-outcome";
import { releaseAllReadyComponentsAction } from "./actions";
import type { ReleaseMedium } from "@/lib/visits/release-media";

interface Props {
  headerId: string;
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
  // Number of components currently at ready_for_release under this package.
  readyCount: number;
}

const MEDIUM_OPTIONS: { value: ReleaseMedium; label: string }[] = [
  { value: "physical", label: "Physical" },
  { value: "email", label: "Email" },
  { value: "viber", label: "Viber" },
  { value: "gcash", label: "GCash" },
  { value: "pickup", label: "Pickup" },
  { value: "other", label: "Other" },
];

export function ReleaseAllButton({
  headerId,
  visitId,
  moneySettled,
  preferredMedium,
  consentOnFile,
  gateRequired,
  readyCount,
}: Props) {
  const outcome = useReleaseOutcome();
  const [pending, start] = useTransition();
  const [medium, setMedium] = useState<ReleaseMedium>(
    preferredMedium ?? "physical",
  );

  const blockedForConsent = gateRequired && !consentOnFile;
  const disabled = pending || !moneySettled || blockedForConsent;
  const title = !moneySettled
    ? "Visit must be paid, waived, or HMO-covered before release"
    : blockedForConsent
      ? "Patient consent not on file — capture consent first"
      : undefined;

  return (
    <div className="flex items-center justify-end gap-1.5">
      {!consentOnFile && !gateRequired ? (
        <span className="text-[11px] text-amber-600">Consent not on file</span>
      ) : null}
      <select
        value={medium}
        onChange={(e) => setMedium(e.target.value as ReleaseMedium)}
        disabled={disabled}
        title={title ?? "Release medium"}
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
        disabled={disabled}
        title={title}
        className="bg-[color:var(--color-brand-cyan)] text-white hover:bg-[color:var(--color-brand-navy)]"
        onClick={() =>
          start(async () => {
            const result = await releaseAllReadyComponentsAction(
              headerId,
              visitId,
              medium,
            );
            // Counts come from the write (changedCount), never the render-time
            // readyCount: a component on a combined report may be refused, and
            // report members outside the package may be pulled in.
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
        {pending ? "Releasing…" : `Release all ready (${readyCount})`}
      </Button>
    </div>
  );
}
