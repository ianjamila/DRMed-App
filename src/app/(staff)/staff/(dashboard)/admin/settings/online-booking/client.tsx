"use client";

import { useState, useTransition } from "react";
import { updateOnlineBookingSettingsAction } from "./actions";
import { Panel } from "@/components/ui/panel";
import { BookingPausedNotice } from "@/components/marketing/booking-paused-notice";
import { PAUSED_MESSAGE_MAX, normalizePausedMessage } from "@/lib/booking/online-booking-copy";

export function OnlineBookingSettings({
  paused: initialPaused,
  message: initialMessage,
}: {
  paused: boolean;
  message: string | null;
}) {
  const [pending, start] = useTransition();
  const [paused, setPaused] = useState(initialPaused);
  const [savedMessage, setSavedMessage] = useState(initialMessage ?? "");
  const [draft, setDraft] = useState(initialMessage ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const draftCheck = normalizePausedMessage(draft);
  const draftDirty = draft.trim() !== savedMessage.trim();

  function save(nextPaused: boolean, successNotice: string) {
    setErr(null);
    setNotice(null);
    if (!draftCheck.ok) {
      setErr(draftCheck.error);
      return;
    }
    const message = draftCheck.message;
    start(async () => {
      const res = await updateOnlineBookingSettingsAction({ paused: nextPaused, message });
      if (!res.ok) {
        setErr(res.error ?? "Could not update the setting. Try again.");
        return;
      }
      setPaused(nextPaused);
      setSavedMessage(message ?? "");
      setDraft(message ?? "");
      setConfirming(false);
      setNotice(successNotice);
    });
  }

  function onToggleClick() {
    if (paused) {
      // Resuming is low-stakes — immediate.
      save(false, "Online booking is back on. Patients can book on the website again.");
    } else {
      // Pausing turns patients away from the booking form — confirm first.
      setConfirming(true);
    }
  }

  return (
    <div className="space-y-6">
      <Panel className="p-5">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="font-bold text-[color:var(--color-brand-navy)]">Pause online booking</p>
            <p className="mt-0.5 text-sm" role="status">
              {paused ? (
                <span className="text-amber-700">
                  PAUSED — patients see a &ldquo;contact reception&rdquo; notice instead of the booking form
                </span>
              ) : (
                <span className="text-green-700">OFF — patients can book online as usual</span>
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onToggleClick}
            disabled={pending}
            aria-pressed={paused}
            className={`relative inline-flex h-7 w-12 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-cyan)] disabled:cursor-wait disabled:opacity-60 ${
              paused ? "bg-amber-500" : "bg-[color:var(--color-brand-bg-mid)]"
            }`}
          >
            <span className="sr-only">Pause online booking</span>
            <span
              aria-hidden="true"
              className={`pointer-events-none inline-block h-6 w-6 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                paused ? "translate-x-5" : "translate-x-0"
              }`}
            />
          </button>
        </div>

        {confirming && (
          <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm">
            <p className="font-semibold text-amber-900">Pause online booking?</p>
            <p className="mt-1 text-amber-800">
              The booking form on the website and in the patient portal is replaced right away by a
              notice asking patients to call, text, or message reception. Bookings already made are
              not affected, and reception can still book patients from Appointments →
              &ldquo;+ New appointment&rdquo;. Make sure reception is ready for more calls and
              messages.
            </p>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={pending}
                onClick={() => save(true, "Online booking is paused. Patients now see the notice below.")}
                className="min-h-9 rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-60"
              >
                {pending ? "Pausing…" : "Yes, pause online booking"}
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

        {err && <p className="mt-3 text-sm text-red-600">{err}</p>}
        {notice && !err && <p className="mt-3 text-sm text-green-700">{notice}</p>}
      </Panel>

      <Panel className="p-5">
        <label htmlFor="paused-message" className="font-bold text-[color:var(--color-brand-navy)]">
          Note for patients <span className="font-normal text-[color:var(--color-brand-text-soft)]">(optional)</span>
        </label>
        <p className="mt-0.5 text-sm text-[color:var(--color-brand-text-soft)]">
          Shown on the notice while booking is paused — for example, when online booking will be
          back. Leave it empty to show only the standard message.
        </p>
        <textarea
          id="paused-message"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={3}
          maxLength={PAUSED_MESSAGE_MAX + 50}
          placeholder="e.g. Online booking will be back on 1 October."
          className="mt-3 w-full rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-cyan)]"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          <span
            className={`text-xs ${draftCheck.ok ? "text-[color:var(--color-brand-text-soft)]" : "text-red-600"}`}
          >
            {draft.trim().length} / {PAUSED_MESSAGE_MAX}
          </span>
          <button
            type="button"
            disabled={pending || !draftDirty || !draftCheck.ok}
            onClick={() => save(paused, draftCheck.ok && draftCheck.message ? "Note saved." : "Note removed.")}
            className="min-h-9 rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
          >
            {pending ? "Saving…" : "Save note"}
          </button>
        </div>
      </Panel>

      <section aria-label="Preview of the patient notice">
        <p className="mb-2 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          What patients see while booking is paused{draftDirty ? " (with your unsaved note)" : ""}
        </p>
        <div className="rounded-2xl bg-[color:var(--color-warm-bg)] p-3 sm:p-5">
          <BookingPausedNotice
            context="preview"
            message={draftCheck.ok ? draftCheck.message : draft.trim().slice(0, PAUSED_MESSAGE_MAX)}
          />
        </div>
      </section>
    </div>
  );
}
