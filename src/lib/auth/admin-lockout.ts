// H7 — admin lockout safety. Two independent guards apply to
// updateStaffUserAction, both pure so they can be unit-tested without a DB:
//
// 1. selfGuard: an admin can never remove their OWN admin role or deactivate
//    their OWN account through this form, regardless of how many other
//    admins exist — mirrors the existing self-service blocks on password
//    reset / email change / delete ("Use Personal → My profile…" /
//    "You cannot delete your own account.").
// 2. wouldRemoveLastActiveAdmin: no edit — self or otherwise — may leave the
//    clinic with zero active admins. The caller counts OTHER active admins
//    (role='admin', is_active=true, deleted_at is null, id <> target) with a
//    fresh query at write time, in the same Server Action that performs the
//    update — a client-side count races against concurrent edits.

export interface StaffRoleActiveUpdate {
  role: string;
  is_active: boolean;
}

/**
 * True when `update` would remove the acting admin's own admin access —
 * either by changing their role away from "admin" or by deactivating them.
 * Applies unconditionally, even if other admins exist (matches the existing
 * self-service blocks elsewhere on this page).
 */
export function isSelfAdminLockout(
  isSelf: boolean,
  update: StaffRoleActiveUpdate,
): boolean {
  if (!isSelf) return false;
  return update.role !== "admin" || !update.is_active;
}

/**
 * True when applying `update` to the target user would leave zero active
 * admins clinic-wide, given `otherActiveAdminCount` — the count of active,
 * non-deleted admins EXCLUDING the target user, fetched fresh by the caller
 * immediately before the write.
 */
export function wouldRemoveLastActiveAdmin(
  otherActiveAdminCount: number,
  update: StaffRoleActiveUpdate,
): boolean {
  const targetRemainsActiveAdmin = update.role === "admin" && update.is_active;
  if (targetRemainsActiveAdmin) return false;
  return otherActiveAdminCount <= 0;
}
