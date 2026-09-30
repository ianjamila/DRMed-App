"use client";

// Client controls for the review queue (Task 15) and the re-sort panel
// (Task 16). Each control uses useTransition and shows the action's error
// inline (role="alert"). Link / Create / Dismiss / Keep undone show no
// success text of their own — they just `router.refresh()`, and the row
// leaving the open list on success IS the feedback. Map answer and Approve
// group DO have something to say ("N patients updated") but their own
// row/group also leaves its list on success, which would unmount the
// message before anyone could read it — see `useGoDone` below for how they
// hand it to page.tsx's DoneBanner instead.

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { manilaDate } from "@/lib/dates/manila";
import { REFERRAL_SOURCE_IDS, REFERRAL_SOURCE_LABEL, type ReferralSourceId } from "@/lib/patients/referral-sources";
import { approveResortGroupAction, mapAnswerToChannelAction, resolveReviewItemAction } from "./actions";
import type { DoneKind } from "./format";

/**
 * Navigate to the current URL with `?done=<kind>&n=<count>` appended (every
 * other current param preserved) — the durable-success-banner handoff to
 * page.tsx (DoneBanner). Used instead of `router.refresh()` by the two
 * controls whose own row/group disappears from the list on success (Map
 * answer, Approve group), so the "N patients updated" text survives past the
 * unmount that a plain refresh would cause — the same class of bug Task 14
 * fixed for Undo by keeping its message in a row that survives; here there
 * is no surviving row, so the message rides the URL instead.
 */
function useGoDone() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return (kind: DoneKind, n: number) => {
    const sp = new URLSearchParams(searchParams.toString());
    sp.set("done", kind);
    sp.set("n", String(n));
    router.push(`${pathname}?${sp.toString()}`);
  };
}

const primaryBtn =
  "min-h-9 rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50";
const secondaryBtn =
  "min-h-9 rounded-md border border-[color:var(--color-brand-navy)] px-3 py-1.5 text-sm font-semibold text-[color:var(--color-brand-navy)] disabled:opacity-50";
const quietBtn =
  "min-h-9 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-sm disabled:opacity-50";
const dangerBtn =
  "min-h-9 rounded-md border border-red-300 px-3 py-1.5 text-sm font-semibold text-red-700 disabled:opacity-50";

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
 * "kept_undone": the item is already kept undone (Show handled) — only Link /
 * Create, which answer who the row is (0170 accepts them on such an item).
 */
export type HoldState = "none" | "keep_undone" | "blocked" | "kept_undone";

export function IdentityItemControls({
  itemId,
  candidates,
  holdState,
  rowLabel,
}: {
  itemId: string;
  candidates: CandidatePayload[];
  holdState: HoldState;
  /** Identifies this card in its aria-labels, e.g. "row 12" — never a name. */
  rowLabel: string;
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
          startTransition(() => {
            setErr(res.error);
          });
          return;
        }
        router.refresh();
      } catch (e) {
        console.error("sheet sync review resolve failed", e);
        startTransition(() => {
          setErr("Could not reach the server. Check your connection and try again.");
        });
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
          aria-label={`Link ${rowLabel} to selected patient`}
          className={primaryBtn}
        >
          {pending ? "Working…" : "Link to selected patient"}
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => resolve("create")}
          aria-label={`Create a new patient for ${rowLabel}`}
          className={secondaryBtn}
        >
          {pending ? "Working…" : "Create a new patient"}
        </button>
        {(holdState === "none" || holdState === "keep_undone") && (
          <button
            type="button"
            disabled={pending}
            onClick={() => resolve("dismiss")}
            aria-label={holdState === "keep_undone" ? `Keep ${rowLabel} undone` : `Dismiss ${rowLabel}`}
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
// 1b. possible_existing_patient, deleted-patient-match variant (review fix E,
//     owner decision 2026-09-25). No candidate list — the only "candidate" is
//     the deleted patient itself, and admin Link onto a deleted patient is
//     refused outright by sheet_review_resolve, so this offers only Create
//     new (the existing create path — an admin create is allowed even over a
//     deleted match) and Keep deleted (dismiss; the SQL now allows it for
//     this hold reason, same as "Keep undone" for an undo hold — the hold
//     stays so the row is never auto-created). Restoring the deleted patient
//     (Admin Tools › Deleted Patients) lets an admin Link normally afterward.
// ---------------------------------------------------------------------------

export function DeletedPatientMatchControls({ itemId, rowLabel, handled = false }: { itemId: string; rowLabel: string; handled?: boolean }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function resolve(action: "create" | "dismiss") {
    setErr(null);
    startTransition(async () => {
      try {
        const res = await resolveReviewItemAction({ itemId, action, patientId: null });
        if (!res.ok) {
          startTransition(() => {
            setErr(res.error);
          });
          return;
        }
        router.refresh();
      } catch (e) {
        console.error("sheet sync review resolve failed", e);
        startTransition(() => {
          setErr("Could not reach the server. Check your connection and try again.");
        });
      }
    });
  }

  return (
    <div className="mt-3">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => resolve("create")}
          aria-label={`Create a new patient for ${rowLabel}`}
          className={secondaryBtn}
        >
          {pending ? "Working…" : "Create a new patient"}
        </button>
        {/* A handled item was already "kept deleted": sheet_review_resolve accepts only link / create on it and refuses a second dismiss (P0064). */}
        {!handled && (
          <button
            type="button"
            disabled={pending}
            onClick={() => resolve("dismiss")}
            aria-label={`Keep ${rowLabel} deleted`}
            className={quietBtn}
          >
            {pending ? "Working…" : "Keep deleted"}
          </button>
        )}
        <Link
          href="/staff/admin/deleted-patients"
          target="_blank"
          rel="noreferrer"
          className={`${secondaryBtn} inline-flex items-center`}
        >
          Find the deleted record
        </Link>
      </div>
      <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
        Restoring the deleted patient there lets you link this row to them normally on the next sync. The sync will
        never re-create this person on its own.
      </p>
      <ErrorLine error={err} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. unmapped_source
// ---------------------------------------------------------------------------

export function UnmappedItemControls({ itemId, answer }: { itemId: string; answer: string }) {
  const router = useRouter();
  const goDone = useGoDone();
  const [pending, startTransition] = useTransition();
  const [sourceId, setSourceId] = useState<ReferralSourceId | "">("");
  const [err, setErr] = useState<string | null>(null);

  function mapAnswer() {
    if (!sourceId) return;
    setErr(null);
    startTransition(async () => {
      try {
        const res = await mapAnswerToChannelAction({ itemId, sourceId });
        if (!res.ok) {
          startTransition(() => {
            setErr(res.error);
          });
          return;
        }
        // Not router.refresh(): the item leaves the open list once mapped,
        // which would unmount this component — and its "N updated" message
        // with it — before anyone could read it. goDone() carries the
        // message to page.tsx's DoneBanner via the URL instead.
        goDone("alias", res.data.patientsUpdated);
      } catch (e) {
        console.error("sheet sync map answer failed", e);
        startTransition(() => {
          setErr("Could not reach the server. Check your connection and try again.");
        });
      }
    });
  }

  function dismiss() {
    setErr(null);
    startTransition(async () => {
      try {
        const res = await resolveReviewItemAction({ itemId, action: "dismiss", patientId: null });
        if (!res.ok) {
          startTransition(() => {
            setErr(res.error);
          });
          return;
        }
        router.refresh();
      } catch (e) {
        console.error("sheet sync review dismiss failed", e);
        startTransition(() => {
          setErr("Could not reach the server. Check your connection and try again.");
        });
      }
    });
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <Select value={sourceId} onValueChange={(v) => setSourceId(v as ReferralSourceId)}>
        <SelectTrigger size="sm" className="w-64" aria-label={`Choose a channel for the answer "${answer}"`}>
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
      <button
        type="button"
        disabled={pending || !sourceId}
        onClick={mapAnswer}
        aria-label={`Map the answer "${answer}" to the selected channel`}
        className={primaryBtn}
      >
        {pending ? "Working…" : "Map answer"}
      </button>
      <button
        type="button"
        disabled={pending}
        onClick={dismiss}
        aria-label={`Dismiss the answer "${answer}"`}
        className={quietBtn}
      >
        {pending ? "Working…" : "Dismiss"}
      </button>
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
  rowLabel,
}: {
  itemId: string;
  label?: string;
  hint?: string;
  /** Identifies this card in its aria-label, e.g. "Customers row 90". */
  rowLabel: string;
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
          startTransition(() => {
            setErr(res.error);
          });
          return;
        }
        router.refresh();
      } catch (e) {
        console.error("sheet sync review dismiss failed", e);
        startTransition(() => {
          setErr("Could not reach the server. Check your connection and try again.");
        });
      }
    });
  }

  return (
    <div className="mt-3">
      <button
        type="button"
        disabled={pending}
        onClick={dismiss}
        aria-label={`${label} — ${rowLabel}`}
        className={quietBtn}
      >
        {pending ? "Working…" : label}
      </button>
      {hint && <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">{hint}</p>}
      <ErrorLine error={err} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. Task 16 — approve a re-sort group
// ---------------------------------------------------------------------------

export function ApproveResortGroupButton({
  answerNorm,
  from,
  to,
  patientCount,
  fromLabel,
  toLabel,
  sampleAnswer,
}: {
  answerNorm: string;
  from: string | null;
  to: string | null;
  patientCount: number;
  fromLabel: string;
  toLabel: string;
  /** Identifies this group's Approve button/dialog, e.g. `"Family / Friends"`. */
  sampleAnswer: string;
}) {
  const goDone = useGoDone();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function confirm() {
    setErr(null);
    startTransition(async () => {
      try {
        const res = await approveResortGroupAction({ answerNorm, from, to });
        if (!res.ok) {
          startTransition(() => {
            setErr(res.error);
          });
          return;
        }
        startTransition(() => {
          setOpen(false);
        });
        // Not router.refresh(): once approved, this group's patients no
        // longer match the proposal and the row disappears from the table —
        // which would unmount this button, and its "N updated" message with
        // it, before anyone could read it. goDone() carries the message to
        // page.tsx's DoneBanner via the URL instead.
        goDone("resort", res.data.updated);
      } catch (e) {
        console.error("sheet sync resort approve failed", e);
        startTransition(() => {
          setErr("Could not reach the server. Check your connection and try again.");
        });
      }
    });
  }

  const groupLabel = `the "${sampleAnswer}" group`;

  return (
    <>
      <button type="button" onClick={() => setOpen(true)} aria-label={`Approve ${groupLabel}`} className={secondaryBtn}>
        Approve
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Approve this group?</DialogTitle>
            <DialogDescription>
              {patientCount} patient{patientCount === 1 ? "" : "s"} will be changed from{" "}
              <span className="font-semibold">{fromLabel}</span> to{" "}
              <span className="font-semibold">{toLabel}</span>. This can be undone from Run history.
            </DialogDescription>
          </DialogHeader>
          <ErrorLine error={err} />
          <DialogFooter>
            <button type="button" onClick={() => setOpen(false)} disabled={pending} className={quietBtn}>
              Cancel
            </button>
            <button
              type="button"
              onClick={confirm}
              disabled={pending}
              aria-label={`Confirm approve ${groupLabel}`}
              className={dangerBtn}
            >
              {pending ? "Updating…" : "Approve"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
