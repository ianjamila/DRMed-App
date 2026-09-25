"use client";

// Client controls for the review queue (Task 15). Each control uses
// useTransition, shows the action's error inline (role="alert"), and calls
// router.refresh() on success so review-queue.tsx re-fetches and the handled
// item drops off the open list.

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { manilaDate } from "@/lib/dates/manila";
import { REFERRAL_SOURCE_IDS, REFERRAL_SOURCE_LABEL, type ReferralSourceId } from "@/lib/patients/referral-sources";
import { mapAnswerToChannelAction, resolveReviewItemAction } from "./actions";

const primaryBtn =
  "min-h-9 rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50";
const secondaryBtn =
  "min-h-9 rounded-md border border-[color:var(--color-brand-navy)] px-3 py-1.5 text-sm font-semibold text-[color:var(--color-brand-navy)] disabled:opacity-50";
const quietBtn =
  "min-h-9 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-sm disabled:opacity-50";

function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p className="mt-2 text-sm text-red-600" role="alert">
      {error}
    </p>
  );
}

// ---------------------------------------------------------------------------
// 1. ambiguous_patient / identity_conflict / possible_existing_patient
// ---------------------------------------------------------------------------

export interface CandidatePayload {
  patient_id: string;
  drm_id: string;
  name: string;
  birthdate: string | null;
}

/**
 * "none": not held (or held loosely enough that a fresh key never got a
 * hold op — see customer-plan.ts's `settled` case) — every button works.
 * "keep_undone": every held key's hold_reason is exactly "undone by an
 * admin" — Dismiss becomes Keep undone (same action, calls dismiss).
 * "blocked": at least one held key has a different hold reason — the SQL
 * refuses dismiss (22023), so Dismiss/Keep undone is hidden entirely and
 * only Link / Create remain.
 */
export type HoldState = "none" | "keep_undone" | "blocked";

export function IdentityItemControls({
  itemId,
  candidates,
  holdState,
}: {
  itemId: string;
  candidates: CandidatePayload[];
  holdState: HoldState;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [selected, setSelected] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  function resolve(action: "link" | "create" | "dismiss") {
    setErr(null);
    startTransition(async () => {
      try {
        const res = await resolveReviewItemAction({
          itemId,
          action,
          patientId: action === "link" ? selected : null,
        });
        if (!res.ok) {
          setErr(res.error);
          return;
        }
        router.refresh();
      } catch (e) {
        console.error("sheet sync review resolve failed", e);
        setErr("Could not reach the server. Check your connection and try again.");
      }
    });
  }

  return (
    <div className="mt-3">
      {candidates.length > 0 && (
        <fieldset>
          <legend className="text-xs font-bold uppercase tracking-wide text-[color:var(--color-brand-text-soft)]">
            Candidates
          </legend>
          <div className="mt-1.5 space-y-1.5">
            {candidates.map((c) => (
              <label
                key={c.patient_id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-[color:var(--color-brand-bg-mid)] p-2 text-sm"
              >
                <input
                  type="radio"
                  name={`candidate-${itemId}`}
                  value={c.patient_id}
                  checked={selected === c.patient_id}
                  onChange={() => setSelected(c.patient_id)}
                  aria-label={`Link to ${c.name}, ${c.drm_id}`}
                />
                <Link
                  href={`/staff/patients/${c.patient_id}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-xs text-cyan-700 hover:underline"
                >
                  {c.drm_id}
                </Link>
                <span className="font-semibold">{c.name}</span>
                <span className="text-xs text-[color:var(--color-brand-text-soft)]">
                  {c.birthdate ? manilaDate(c.birthdate) : "DOB not on file"}
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending || !selected}
          onClick={() => resolve("link")}
          aria-label="Link to selected patient"
          className={primaryBtn}
        >
          {pending ? "Working…" : "Link to selected patient"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => resolve("create")}
          aria-label="Create a new patient"
          className={secondaryBtn}
        >
          {pending ? "Working…" : "Create a new patient"}
        </button>
        {holdState !== "blocked" && (
          <button
            type="button"
            disabled={pending}
            onClick={() => resolve("dismiss")}
            aria-label={holdState === "keep_undone" ? "Keep undone" : "Dismiss"}
            className={quietBtn}
          >
            {pending ? "Working…" : holdState === "keep_undone" ? "Keep undone" : "Dismiss"}
          </button>
        )}
      </div>
      <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
        Applied on the next sync (nightly, or Sync now).
      </p>
      <ErrorLine error={err} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. unmapped_source
// ---------------------------------------------------------------------------

export function UnmappedItemControls({ itemId }: { itemId: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [sourceId, setSourceId] = useState<ReferralSourceId | "">("");
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function mapAnswer() {
    if (!sourceId) return;
    setErr(null);
    startTransition(async () => {
      try {
        const res = await mapAnswerToChannelAction({ itemId, sourceId });
        if (!res.ok) {
          setErr(res.error);
          return;
        }
        setDone(`${res.data.patientsUpdated} patient${res.data.patientsUpdated === 1 ? "" : "s"} updated.`);
        router.refresh();
      } catch (e) {
        console.error("sheet sync map answer failed", e);
        setErr("Could not reach the server. Check your connection and try again.");
      }
    });
  }

  function dismiss() {
    setErr(null);
    startTransition(async () => {
      try {
        const res = await resolveReviewItemAction({ itemId, action: "dismiss", patientId: null });
        if (!res.ok) {
          setErr(res.error);
          return;
        }
        router.refresh();
      } catch (e) {
        console.error("sheet sync review dismiss failed", e);
        setErr("Could not reach the server. Check your connection and try again.");
      }
    });
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Select value={sourceId} onValueChange={(v) => setSourceId(v as ReferralSourceId)}>
        <SelectTrigger size="sm" className="w-64" aria-label="Choose a channel">
          <SelectValue placeholder="Choose a channel" />
        </SelectTrigger>
        <SelectContent>
          {REFERRAL_SOURCE_IDS.map((id) => (
            <SelectItem key={id} value={id}>
              {REFERRAL_SOURCE_LABEL[id]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <button type="button" disabled={pending || !sourceId} onClick={mapAnswer} className={primaryBtn}>
        {pending ? "Working…" : "Map answer"}
      </button>
      <button type="button" disabled={pending} onClick={dismiss} className={quietBtn}>
        {pending ? "Working…" : "Dismiss"}
      </button>
      {done && (
        <p className="w-full text-sm text-[color:var(--color-brand-text-soft)]" role="status">
          {done}
        </p>
      )}
      {err && (
        <p className="w-full text-sm text-red-600" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. unparseable_date / invalid_row / suspect_snapshot — Dismiss only
// ---------------------------------------------------------------------------

export function SimpleDismissControls({
  itemId,
  label = "Dismiss",
  hint,
}: {
  itemId: string;
  label?: string;
  hint?: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function dismiss() {
    setErr(null);
    startTransition(async () => {
      try {
        const res = await resolveReviewItemAction({ itemId, action: "dismiss", patientId: null });
        if (!res.ok) {
          setErr(res.error);
          return;
        }
        router.refresh();
      } catch (e) {
        console.error("sheet sync review dismiss failed", e);
        setErr("Could not reach the server. Check your connection and try again.");
      }
    });
  }

  return (
    <div className="mt-3">
      <button type="button" disabled={pending} onClick={dismiss} className={quietBtn}>
        {pending ? "Working…" : label}
      </button>
      {hint && <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">{hint}</p>}
      <ErrorLine error={err} />
    </div>
  );
}
