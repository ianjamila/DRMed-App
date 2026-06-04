// Classify a line's discount_kind from the sheet's per-type discount columns.
// Allowed: senior_pwd_20 | pct_10 | pct_5 | other_pct_20 (or null = no discount).
export type DiscountKind = "senior_pwd_20" | "pct_10" | "pct_5" | "other_pct_20";

interface LabCells { senior: number; d10: number; d5: number; }
interface ConsultCells { senior: number; other: number; }

export function classifyDiscount(
  cells: LabCells | ConsultCells, isConsult: boolean,
): DiscountKind | null {
  if ((cells.senior ?? 0) > 0) return "senior_pwd_20";
  if (isConsult) {
    return ((cells as ConsultCells).other ?? 0) > 0 ? "other_pct_20" : null;
  }
  const lab = cells as LabCells;
  if ((lab.d10 ?? 0) > 0) return "pct_10";
  if ((lab.d5 ?? 0) > 0) return "pct_5";
  return null;
}
