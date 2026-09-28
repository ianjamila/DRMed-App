import type { StalePrint } from "@/lib/results/print-summary";

// Under <PrintedNote>: the copy that went out on paper is an older version
// than the file now on file — reprint before handing it to the patient.
export function StalePrintWarning({ stale }: { stale: StalePrint | undefined }) {
  if (!stale) return null;
  return (
    <p className="text-xs text-amber-800" role="note">
      Printed copy is v{stale.printedVersion} — the current version is v{stale.currentVersion}. Reprint before handing over.
    </p>
  );
}
