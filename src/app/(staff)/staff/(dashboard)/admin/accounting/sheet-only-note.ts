import { manilaDate } from "@/lib/dates/manila";
import type { TabKey } from "@/lib/accounting/types";
import type { SheetOnlyCoverage } from "@/lib/sheet-sync/sheet-only-coverage";

// The per-tab line under "Copied up to …": how many rows exist only on the
// reception sheet, which this copy never sends. Without it a tab whose last
// app-entered visit is months old reads as a stuck sync (asked 2026-10-02:
// "only showing up to Jul 4 when there's more data after that").
export function sheetOnlyNote(
  key: TabKey,
  coverage: Record<"lab" | "consult", SheetOnlyCoverage | null>,
): string | null {
  if (key === "doctor_procedures") {
    return "Procedure HMO rows on the reception sheet are not read by the app, so none are copied.";
  }
  const c = key === "lab_services" ? coverage.lab : coverage.consult;
  if (!c || c.rows === 0) return null;
  const noun = key === "lab_services" ? "lab" : "consultation";
  const rows = `${c.rows.toLocaleString("en-US")} ${noun} row${c.rows === 1 ? "" : "s"}`;
  const range =
    c.firstDate && c.lastDate
      ? c.firstDate === c.lastDate
        ? ` on ${manilaDate(c.firstDate)}`
        : ` from ${manilaDate(c.firstDate)} to ${manilaDate(c.lastDate)}`
      : "";
  return `On the reception sheet only, not copied: ${rows}${range}.`;
}
