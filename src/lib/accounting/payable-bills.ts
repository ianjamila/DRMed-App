/**
 * Bills that can actually receive a payment allocation: still owing, and past
 * draft.
 *
 * A draft bill computes an `outstanding_amount` but cannot be allocated
 * against — `postBillAction` refuses anything but a draft-to-posted move, and
 * the payment side only allocates to posted/partially-paid bills — so counting
 * drafts as payable overstates what the clinic owes today. The AP subledger's
 * own CHECK (0048_ap_subledger_schema.sql) allows
 * `draft | posted | partially_paid | paid | voided`; only the middle two can
 * carry a real, payable balance.
 *
 * This lives in its own module, NOT in `actions/accounting/bills.ts`, because
 * that file is `"use server"` — such a module may only export async functions,
 * so a plain `const` there type-checks but fails the production build. The
 * admin dashboard card and the bills list's `?payable=1` filter both import it
 * from here so the figure and the screen it opens cannot drift apart.
 */
export const PAYABLE_BILL_STATUSES = ["posted", "partially_paid"] as const;
