/**
 * Search and filters for /staff/users.
 *
 * Filtering runs in memory rather than in SQL on purpose. Three of the four
 * filterable fields — email, sign-in method and last sign-in — come from the
 * Auth admin API, not from `staff_profiles`, so Postgres cannot join them; and
 * the page already loads every profile and every auth user to render the table
 * at all. Pushing role/status down to SQL while the rest stayed here would
 * split one decision across two layers for no gain at this size.
 *
 * Mirrors src/lib/results/status-filter.ts: parsers that always resolve to a
 * valid value, so a hand-edited query string can never 500 the page.
 */

import type { SignInSummary } from "@/lib/auth/sign-in-methods";

export const STAFF_ROLES = [
  "reception",
  "medtech",
  "xray_technician",
  "pathologist",
  "admin",
] as const;

export type StaffRole = (typeof STAFF_ROLES)[number];
export type StaffRoleFilter = "all" | StaffRole;
export type StaffStatusFilter = "all" | "active" | "inactive";
/** "password_only" is the migration lens: who still has to be moved to Google. */
export type SignInFilter = "all" | "google" | "password_only";

// Single source of truth for the label — the table renders it and the search
// matches against it, so they can never drift apart.
export const ROLE_LABEL: Record<string, string> = {
  reception: "Reception",
  medtech: "Medical Tech",
  xray_technician: "X-ray Technician",
  pathologist: "Pathologist",
  admin: "Admin",
};

export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role;
}

export function parseRoleFilter(value: string | undefined): StaffRoleFilter {
  return (STAFF_ROLES as readonly string[]).includes(value ?? "")
    ? (value as StaffRole)
    : "all";
}

export function parseStatusFilter(
  value: string | undefined,
): StaffStatusFilter {
  return value === "active" || value === "inactive" ? value : "all";
}

export function parseSignInFilter(value: string | undefined): SignInFilter {
  return value === "google" || value === "password_only" ? value : "all";
}

export interface FilterableStaffRow {
  full_name: string;
  email: string;
  role: string;
  is_active: boolean;
  sign_in: SignInSummary;
}

export interface StaffFilters {
  q: string;
  role: StaffRoleFilter;
  status: StaffStatusFilter;
  signIn: SignInFilter;
}

// Every token must match SOME field (name, email or role label), in any order —
// the same rule the patients search uses, so "jamila ian" finds "Ian Jamila".
function matchesQuery(row: FilterableStaffRow, q: string): boolean {
  const tokens = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;

  const haystack = [row.full_name, row.email, roleLabel(row.role)]
    .join(" ")
    .toLowerCase();

  return tokens.every((token) => haystack.includes(token));
}

export function filterStaffRows<T extends FilterableStaffRow>(
  rows: readonly T[],
  filters: StaffFilters,
): T[] {
  return rows.filter((row) => {
    if (filters.role !== "all" && row.role !== filters.role) return false;

    if (filters.status === "active" && !row.is_active) return false;
    if (filters.status === "inactive" && row.is_active) return false;

    if (filters.signIn === "google" && !row.sign_in.google) return false;
    if (
      filters.signIn === "password_only" &&
      !(row.sign_in.password && !row.sign_in.google)
    ) {
      return false;
    }

    return matchesQuery(row, filters.q);
  });
}
