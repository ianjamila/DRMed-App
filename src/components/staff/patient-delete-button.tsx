"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/staff/confirm-dialog";
import {
  deletePatientAction,
  previewPatientDeleteAction,
  restorePatientAction,
  type DeletePreview,
} from "@/lib/actions/patients/lifecycle";
import {
  DELETE_NOTE_MAX,
  DELETE_REASONS,
  DELETE_REASON_LABEL,
  groupBlockers,
  keptSummary,
  type DeleteBlocker,
  type DeleteReason,
} from "@/lib/patients/deletion";
import { formatPatientName } from "@/lib/patients/format-name";
import { formatPhp } from "@/lib/marketing/format";
import { manilaDate } from "@/lib/dates/manila";

// Admin-only. The dialog asks the database what is still open (appointments,
// unfinished work, money, HMO claims) and disables confirmation while
// anything is; delete_patient() re-checks under its own lock, so this list
// is advisory. Reason is required; a note is required for "Other".

export interface DeleteConfirmState {
  loading: boolean;
  hasPreview: boolean;
  blockerCount: number;
  reason: DeleteReason | "";
  noteLength: number;
}

/**
 * Pure gate for the dialog's confirm button — extracted so it can be unit
 * tested directly (patient-delete-button.test.tsx) rather than only through
 * DOM interaction, which renderToStaticMarkup can't drive.
 */
export function canConfirmDelete({ loading, hasPreview, blockerCount, reason, noteLength }: DeleteConfirmState): boolean {
  if (loading) return false;
  if (!hasPreview) return false;
  if (blockerCount > 0) return false;
  if (!reason) return false;
  if (reason === "other" && noteLength === 0) return false;
  if (noteLength > DELETE_NOTE_MAX) return false;
  return true;
}
export function PatientDeleteButton({
  patientId,
  drmId,
  initialReason,
}: {
  patientId: string;
  drmId: string;
  initialReason?: DeleteReason;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<DeletePreview | null>(null);
  const [blockers, setBlockers] = useState<DeleteBlocker[]>([]);
  const [reason, setReason] = useState<DeleteReason | "">(initialReason ?? "");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const [pending, startDelete] = useTransition();

  function openDialog() {
    setOpen(true);
    setError(null);
    setPreview(null);
    setBlockers([]);
    startLoading(async () => {
      const res = await previewPatientDeleteAction(patientId);
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setPreview(res.data);
      setBlockers(res.data.blockers);
    });
  }

  function close() {
    if (pending) return;
    setOpen(false);
    setReason(initialReason ?? "");
    setNote("");
    setError(null);
  }

  function confirm() {
    if (!reason) return;
    setError(null);
    startDelete(async () => {
      const res = await deletePatientAction({ patientId, reason, note });
      if (!res.ok) {
        setError(res.error);
        if (res.blockers) setBlockers(res.blockers);
        return;
      }
      setOpen(false);
      const deleted = res.data.drmId;
      toast.success(`${deleted} deleted`, {
        duration: 10_000,
        action: {
          label: "Undo",
          onClick: () => {
            void restorePatientAction(patientId).then((r) => {
              if (r.ok) {
                toast.success(`${deleted} restored`);
                router.refresh();
              } else {
                toast.error(r.error);
              }
            });
          },
        },
      });
      router.push("/staff/patients");
    });
  }

  const trimmedNote = note.trim();
  const confirmDisabled = !canConfirmDelete({
    loading,
    hasPreview: !!preview,
    blockerCount: blockers.length,
    reason,
    noteLength: trimmedNote.length,
  });

  const groups = groupBlockers(blockers);

  const body = (
    <div className="space-y-4">
      {loading ? (
        <p className="text-[color:var(--color-brand-text-soft)]">Checking what this record still has open…</p>
      ) : null}
      {preview ? (
        <>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">Patient</dt>
            <dd className="font-semibold">{formatPatientName(preview.patient) || "(no name on file)"}</dd>
            <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">DRM-ID</dt>
            <dd className="font-mono">{preview.patient.drm_id}</dd>
            <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">Birthdate</dt>
            <dd>{preview.patient.birthdate ? manilaDate(preview.patient.birthdate) : "—"}</dd>
          </dl>
          <p className="rounded-md bg-[color:var(--color-brand-bg)] px-3 py-2">
            <b>These stay on file:</b> {keptSummary(preview.kept)}. Deleting hides the record from the patient
            list, the pickers, booking and the patient portal. It does not erase any history, and an admin can
            restore it from Admin Tools › Deleted Patients.
          </p>
        </>
      ) : null}

      {groups.length > 0 ? (
        <div role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-rose-900">
          <p className="font-bold">This record can&apos;t be deleted yet. Close these first:</p>
          {groups.map((g) => (
            <div key={g.kind} className="mt-2">
              <p className="text-xs font-bold uppercase tracking-wider">{g.title}</p>
              <ul className="mt-1 list-disc space-y-0.5 pl-5">
                {g.items.map((b) => (
                  <li key={`${b.kind}:${b.resource_id}`}>
                    {b.href ? (
                      <Link href={b.href} className="underline hover:no-underline">
                        {b.label}
                      </Link>
                    ) : (
                      b.label
                    )}
                    {b.amount_php !== null ? ` (${formatPhp(b.amount_php)})` : ""}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : null}

      {preview && groups.length === 0 ? (
        <fieldset className="space-y-2">
          <legend className="mb-1 text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Why is this record being deleted? (required)
          </legend>
          {DELETE_REASONS.map((r) => (
            <label key={r} className="flex items-center gap-2">
              <input
                type="radio"
                name="delete-reason"
                value={r}
                checked={reason === r}
                onChange={() => setReason(r)}
                disabled={pending}
              />
              {DELETE_REASON_LABEL[r]}
            </label>
          ))}
          <label
            htmlFor="delete-note"
            className="block pt-2 text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]"
          >
            Note {reason === "other" ? "(required)" : "(optional)"}
          </label>
          <textarea
            id="delete-note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            maxLength={DELETE_NOTE_MAX + 50}
            disabled={pending}
            aria-required={reason === "other"}
            className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
          />
          <p
            className={`text-xs ${
              trimmedNote.length > DELETE_NOTE_MAX ? "text-rose-700" : "text-[color:var(--color-brand-text-soft)]"
            }`}
          >
            {trimmedNote.length}/{DELETE_NOTE_MAX}
          </p>
        </fieldset>
      ) : null}
    </div>
  );

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        className="min-h-[44px] rounded-md border border-rose-300 bg-white px-4 py-2 text-sm font-bold text-rose-700 hover:border-rose-600 hover:bg-rose-50 disabled:opacity-50"
      >
        Delete patient
      </button>
      <ConfirmDialog
        open={open}
        title={`Delete ${drmId}?`}
        body={body}
        confirmLabel="Delete patient"
        confirmVariant="danger"
        confirmDisabled={confirmDisabled}
        onConfirm={confirm}
        onCancel={close}
        isPending={pending}
        errorMessage={error}
      />
    </>
  );
}
