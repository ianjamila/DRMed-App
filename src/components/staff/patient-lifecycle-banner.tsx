import Link from "next/link";
import { manilaDate } from "@/lib/dates/manila";
import { deleteReasonLabel } from "@/lib/patients/deletion";
import type { PatientLifecycleDisplay } from "@/lib/patients/lifecycle-display";
import { RestorePatientButton } from "./restore-patient-button";

// Shown on every history page of a deleted or merged record. Screen only —
// never on a printout.
export function PatientLifecycleBanner({
  lifecycle,
  isAdmin,
  className = "",
}: {
  lifecycle: PatientLifecycleDisplay;
  isAdmin: boolean;
  className?: string;
}) {
  if (lifecycle.mergedIntoId) {
    return (
      <div
        role="status"
        className={`print:hidden rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 ${className}`}
      >
        This record was merged into{" "}
        <Link href={`/staff/patients/${lifecycle.mergedIntoId}`} className="font-semibold underline">
          {lifecycle.mergedIntoDrmId ?? "another record"}
        </Link>
        {lifecycle.mergedAt ? ` on ${manilaDate(lifecycle.mergedAt)}` : ""}. Use the surviving record for
        anything new.
      </div>
    );
  }
  if (!lifecycle.deletedAt) return null;
  const reason = deleteReasonLabel(lifecycle.deleteReason);
  return (
    <div
      role="status"
      className={`print:hidden flex flex-wrap items-center justify-between gap-3 rounded-md border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-900 ${className}`}
    >
      <p>
        This patient record was deleted on {manilaDate(lifecycle.deletedAt)} by{" "}
        {lifecycle.deletedByName ?? "an admin"} ({reason}
        {isAdmin && lifecycle.deleteNote ? `: ${lifecycle.deleteNote}` : ""}). Its history stays on file;
        nothing new can be added until it is restored.
      </p>
      {isAdmin ? <RestorePatientButton patientId={lifecycle.patientId} drmId={lifecycle.drmId} /> : null}
    </div>
  );
}
