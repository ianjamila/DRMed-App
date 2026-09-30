"use client";

import { RELEASE_BLOCKED_CONSENT, RELEASE_BLOCKED_UNPAID } from "@/lib/visits/release-messages";
import { RELEASE_MEDIUM_OPTIONS } from "@/lib/visits/release-media";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { releaseTestAction, type ReleaseMedium } from "./actions";

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
}

export function ReleaseButton({
  testRequestId,
  visitId,
  moneySettled,
  preferredMedium,
  consentOnFile,
  gateRequired,
  size = "default",
}: Props) {
  const [pending, start] = useTransition();
  const [medium, setMedium] = useState<ReleaseMedium>(
    preferredMedium ?? "physical",
  );

  const blockedForConsent = gateRequired && !consentOnFile;
  const disabled = pending || !moneySettled || blockedForConsent;
  const title = !moneySettled
    ? RELEASE_BLOCKED_UNPAID
    : blockedForConsent
      ? RELEASE_BLOCKED_CONSENT
      : undefined;

  const textCls = size === "compact" ? "text-[10px]" : "text-xs";
  const btnSizeCls = size === "compact" ? "text-[10px] min-h-[28px]" : "";

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
            if (!result.ok) alert(result.error);
          })
        }
      >
        {pending ? "Releasing…" : "Release"}
      </Button>
    </div>
  );
}
