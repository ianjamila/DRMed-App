// src/lib/audit/viewing-as-filter.ts
//
// Pure helpers for the Audit log's "Viewing as" column + filter (spec
// addendum A4, docs/superpowers/specs/2026-09-28-view-as-followups-design.md).
// A DB trigger (migration 0187) stamps `metadata.acting_as = '<role>'` on a
// staff audit row written while an admin has an active "View as role"
// override. No server-only imports — safe for the page and for vitest.

import { isViewAsRole, type ViewAsRole } from "@/lib/auth/view-as";
import { ROLE_LABEL } from "@/lib/staff/role-labels";

/** `"any"` means "rows that carry `metadata.acting_as` at all", regardless of
 *  which role. A specific `ViewAsRole` narrows to that one role. */
export type ViewingAsFilter = "any" | ViewAsRole;

/**
 * Resolve `?viewing_as=` against the allow-list. Anything else — unset,
 * junk, a probe, `"admin"` (never a valid `acting_as` value) — resolves to
 * `null`, meaning no filter, the same "unrecognised falls back" contract as
 * `parseSort` in `table-params.ts`.
 */
export function parseViewingAsFilter(raw: string | undefined): ViewingAsFilter | null {
  if (raw === "any") return "any";
  if (isViewAsRole(raw)) return raw;
  return null;
}

/**
 * Plain-language label for the "Viewing as" column cell. Blank ("—") when
 * the row carries no `acting_as`, or a value outside the four View-as roles.
 */
export function viewingAsLabel(actingAs: unknown): string {
  if (!isViewAsRole(actingAs)) return "—";
  return ROLE_LABEL[actingAs];
}
