"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { ConsentNotice } from "@/components/consent/consent-notice";
import { acceptConsentPortalAction } from "@/lib/actions/consent/portal-accept";

export function PortalConsentGate() {
  const [pending, start] = useTransition();
  const [agreed, setAgreed] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[color:var(--color-brand-bg)]/95 p-4">
      <div className="mx-auto max-w-lg rounded-2xl bg-white p-5 shadow-xl">
        <h1 className="text-lg font-extrabold text-[color:var(--color-brand-navy)]">
          Data Privacy Consent
        </h1>
        <p className="text-xs font-semibold uppercase tracking-wide text-[color:var(--color-brand-steel)]">
          RA 10173 — required before viewing your results
        </p>
        <div className="mt-3 max-h-[50vh] overflow-y-auto">
          <ConsentNotice compact />
        </div>
        {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
        <label className="mt-3 flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            checked={agreed}
            onChange={(e) => setAgreed(e.target.checked)}
            className="mt-1"
          />
          <span>
            I have read and understood this notice and consent to the processing
            of my personal and health data.
          </span>
        </label>
        <Button
          type="button"
          disabled={!agreed || pending}
          className="mt-3 w-full bg-[color:var(--color-brand-navy)] text-white"
          onClick={() =>
            start(async () => {
              setErr(null);
              const res = await acceptConsentPortalAction({ signatory: "self" });
              if (!res.ok) setErr(res.error);
            })
          }
        >
          {pending ? "Recording…" : "I Agree"}
        </Button>
      </div>
    </div>
  );
}
