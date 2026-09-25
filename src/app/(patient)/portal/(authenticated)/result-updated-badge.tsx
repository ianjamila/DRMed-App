import {
  RESULT_UPDATED_HINT,
  RESULT_UPDATED_LABEL,
} from "@/lib/results/patient-update-marker";

// "Result updated" chip for a result the patient downloaded before the clinic
// last corrected it (see isUpdatedSinceDownload). The explanation rides along as
// visually-hidden text and a tooltip — never the clinic's reason for the edit.
export function ResultUpdatedBadge({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span
      title={RESULT_UPDATED_HINT}
      className="inline-block rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-900"
    >
      {RESULT_UPDATED_LABEL}
      <span className="sr-only">. {RESULT_UPDATED_HINT}</span>
    </span>
  );
}
