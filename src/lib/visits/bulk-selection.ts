import type { ServiceSection } from "@/lib/auth/role-sections";

// Hard cap on how many test_request ids a single bulk-selection action will
// accept. Shared by the server actions (validation) and the Task 4 client UI
// (selection cap) — which is why it lives here and not in the "use server"
// actions module (those files may only export async functions).
export const MAX_BULK_SELECTION = 100;

// Supabase returns an embedded relation as an array or a single object
// depending on the join shape, and `services.section` is nullable in the
// generated DB types.
type ServicesEmbed =
  | { section: string | null; name: string }
  | { section: string | null; name: string }[]
  | null;

export interface SelectableRow {
  id: string;
  services: ServicesEmbed;
}

function flatten(
  services: ServicesEmbed,
): { section: string | null; name: string } | null {
  return (Array.isArray(services) ? services[0] : services) ?? null;
}

// Section-scopes a set of candidate rows down to the ids the current role is
// allowed to act on. Mirrors the visit page's SELECT-side filter and
// releaseAllReadyComponentsAction's inline scoping block exactly:
// `null` = unrestricted (admin/pathologist), `[]` = no sections (reception),
// otherwise only rows whose service section is in the allowed set — a row
// with no resolvable section is always filtered out when a list applies.
// Rows also carry the service name for notification/audit use.
export function scopeToAllowedSections(
  rows: SelectableRow[],
  allowedSections: readonly ServiceSection[] | null,
): { id: string; name: string | null }[] {
  return rows
    .filter((r) => {
      if (allowedSections === null) return true;
      const sect = flatten(r.services)?.section ?? null;
      return sect != null && allowedSections.includes(sect as ServiceSection);
    })
    .map((r) => ({ id: r.id, name: flatten(r.services)?.name ?? null }));
}
