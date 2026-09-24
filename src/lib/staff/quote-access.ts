import type { StaffSession } from "@/lib/auth/require-staff";

/**
 * Who may use Quick Quote (/staff/quote). The one list behind every doorway to
 * it: the sidebar item, the Cmd+K jump, the page's own role check, and the
 * "Send a quote" button on a Website Message. Medtech lost access 2026-09-24
 * (owner decision); change it here and every doorway follows.
 */
export const QUICK_QUOTE_ROLES: readonly StaffSession["role"][] = ["reception", "admin"];

export function canUseQuickQuote(role: StaffSession["role"]): boolean {
  return QUICK_QUOTE_ROLES.includes(role);
}
