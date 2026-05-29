"use client";

import { useState, useTransition } from "react";
import { setConsentGateRequiredAction } from "./actions";

export function ConsentGateToggle({
  enabled,
  blockedCount,
}: {
  enabled: boolean;
  blockedCount: number;
}) {
  const [pending, start] = useTransition();
  const [on, setOn] = useState(enabled);
  const [err, setErr] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  function apply(next: boolean) {
    setErr(null);
    start(async () => {
      const res = await setConsentGateRequiredAction(next);
      if (!res.ok) {
        setErr(res.error ?? "Could not update the setting. Try again.");
        return;
      }
      setOn(next);
      setConfirming(false);
    });
  }

  function onToggleClick() {
    if (on) {
      apply(false); // turning OFF is low-stakes — immediate
    } else {
      setConfirming(true); // turning ON blocks releases — confirm first
    }
  }

  return (
    <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
      <div className="flex items-center justify-between gap-4">
        <div>
          <p className="font-bold text-[color:var(--color-brand-navy)]">
            Require consent before result release
          </p>
          <p className="mt-0.5 text-sm">
            {on ? (
              <span className="text-green-700">
                ON — releases are blocked for patients without consent on file
              </span>
            ) : (
              <span className="text-amber-700">
                OFF — releases are not blocked (consent is still captured &amp;
                audited)
              </span>
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={onToggleClick}
          disabled={pending}
          aria-pressed={on}
          className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-cyan)] disabled:cursor-wait disabled:opacity-60 ${
            on
              ? "bg-[color:var(--color-brand-cyan)]"
              : "bg-[color:var(--color-brand-bg-mid)]"
          }`}
        >
          <span className="sr-only">Toggle consent gate</span>
          <span
            aria-hidden="true"
            className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
              on ? "translate-x-5" : "translate-x-0"
            }`}
          />
        </button>
      </div>

      {err && <p className="mt-3 text-sm text-red-600">{err}</p>}

      {confirming && (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
          <p className="font-semibold text-amber-900">
            Turn the consent gate ON?
          </p>
          <p className="mt-1 text-amber-800">
            This immediately blocks lab-result release for every patient without
            data-privacy consent on file.
            {blockedCount > 0 ? (
              <>
                {" "}
                Right now <b>{blockedCount.toLocaleString()}</b> patient
                {blockedCount === 1 ? "" : "s"} ha
                {blockedCount === 1 ? "s" : "ve"} no consent and would be blocked
                until reception captures it.
              </>
            ) : null}{" "}
            Make sure reception is briefed first.
          </p>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              disabled={pending}
              onClick={() => apply(true)}
              className="min-h-9 rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
            >
              {pending ? "Enabling…" : "Yes, turn it on"}
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={() => setConfirming(false)}
              className="min-h-9 rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
