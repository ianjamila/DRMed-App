import type { Tab } from "./types";

/**
 * Build a unique legacy visit_number. Base is `H-<control_no>`; when control_no
 * is blank we synthesize `H-<tab>-<rowNumber>` (spaces -> underscore). On
 * collision against `used` we append `-2`, `-3`, ... The issued number is added
 * to `used` so subsequent calls stay unique within the run.
 */
export function buildVisitNumber(tab: Tab, controlNo: string, rowNumber: number, used: Set<string>): string {
  const c = (controlNo ?? "").trim();
  const base = c ? `H-${c}` : `H-${tab}-${rowNumber}`.replace(/\s+/g, "_");
  let candidate = base;
  let n = 1;
  while (used.has(candidate)) {
    n += 1;
    candidate = `${base}-${n}`;
  }
  used.add(candidate);
  return candidate;
}
