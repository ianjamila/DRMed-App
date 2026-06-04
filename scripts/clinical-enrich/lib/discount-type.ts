// Classify a line's discount_kind from the sheet's per-type discount FLAG columns.
// The sheet stores each discount type as a "YES"/"N/A"/blank flag (not an amount),
// so callers pass booleans (flag === "YES"). Allowed kinds:
// senior_pwd_20 | pct_10 | pct_5 | other_pct_20 (or null = no discount flag set).
export type DiscountKind = "senior_pwd_20" | "pct_10" | "pct_5" | "other_pct_20";

interface LabFlags { senior: boolean; d10: boolean; d5: boolean; }
interface ConsultFlags { senior: boolean; other: boolean; }

export function classifyDiscount(
  flags: LabFlags | ConsultFlags, isConsult: boolean,
): DiscountKind | null {
  if (flags.senior) return "senior_pwd_20";
  if (isConsult) {
    return (flags as ConsultFlags).other ? "other_pct_20" : null;
  }
  const lab = flags as LabFlags;
  if (lab.d10) return "pct_10";
  if (lab.d5) return "pct_5";
  return null;
}
