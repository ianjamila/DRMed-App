// For list rows (results archive, appointments) whose patient record is
// deleted or merged. The row stays — history — but staff can see why the
// patient is missing from the directory.
export function InactivePatientBadge({
  deletedAt,
  mergedIntoId,
}: {
  deletedAt: string | null | undefined;
  mergedIntoId: string | null | undefined;
}) {
  if (!deletedAt && !mergedIntoId) return null;
  return (
    <span className="ml-2 rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-rose-800">
      {mergedIntoId ? "Merged record" : "Deleted record"}
    </span>
  );
}
