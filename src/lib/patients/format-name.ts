/**
 * Format a patient's display name as "Last, First Middle".
 *
 * The receipt/header convention has always shown "Last, First"; the middle
 * name is now included too (partner request, 2026-06-13 — "no middle name,
 * why?"). One helper keeps every surface — receipts, patient header, search
 * results, visits list — formatting names the same way.
 *
 * Returns "" when neither last nor first name is on file, so callers can keep
 * their own placeholder (e.g. "(no name on file)").
 *
 * Pure logic (no `server-only`, no DB) so it is unit-tested and usable from
 * both server components and client filtering.
 */
export function formatPatientName(p: {
  first_name?: string | null;
  middle_name?: string | null;
  last_name?: string | null;
}): string {
  const last = p.last_name?.trim() ?? "";
  const first = p.first_name?.trim() ?? "";
  const middle = p.middle_name?.trim() ?? "";
  const given = [first, middle].filter(Boolean).join(" ");
  if (last && given) return `${last}, ${given}`;
  return last || given;
}
