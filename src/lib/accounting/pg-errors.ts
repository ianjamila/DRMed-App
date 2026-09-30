import "server-only";

import { eodClosedMessage } from "./eod-closed-message";
import { RELEASE_BLOCKED_CONSENT, RELEASE_BLOCKED_UNPAID } from "@/lib/visits/release-messages";

interface PgError {
  code?: string;
  message?: string;
  details?: string;
}

// Translate Postgres error codes + custom RAISE EXCEPTION codes into user
// readable strings. The original error is logged to Sentry by the Server
// Action layer; this function only produces the UI-facing message.
export function translatePgError(err: PgError): string {
  switch (err.code) {
    case "23505": {
      const m = err.message ?? "";
      if (m.includes("vendors_lower_name_unique")) {
        return "A vendor with this name already exists.";
      }
      if (m.includes("vendors_tin_unique")) {
        return "A vendor with this TIN already exists.";
      }
      if (m.includes("services_code_key")) {
        return "A service with this code already exists. Pick a different code.";
      }
      if (m.includes("payments_gift_code_redemption_unique")) {
        // Finding 6 (go-live review): the redemption race guard — someone
        // else's redemption of the same code landed first.
        return "This code was just redeemed by someone else. Refresh the visit and check its balance.";
      }
      return "That value already exists. Pick a different one.";
    }
    case "23514": {
      const m = err.message ?? "";
      if (/consent/i.test(m)) {
        return RELEASE_BLOCKED_CONSENT;
      }
      if (/payment_status/i.test(m)) {
        return RELEASE_BLOCKED_UNPAID;
      }
      // A genuine table CHECK constraint (e.g. employee_loans_outstanding_nonneg,
      // 0044) fails with Postgres's own generic "... violates check constraint
      // <name> ..." wording — there is nothing case-specific to say, and the
      // constraint's internal name is not for staff, so keep the generic
      // message. A hand-written plpgsql `raise ... using errcode = '23514'` /
      // `'check_violation'` (0001/0133's payment gate and 0086/0088's consent
      // gate above; 0184's "a correction record stays on its result and
      // test", "a critical alert stays on its result and test", "a payment
      // correction stays linked to the payment it corrects", "a critical
      // alert's patient must match its test's patient", "a result can only
      // hold one patient's tests", "an alert can only be withdrawn by a
      // correction of its own result") carries neither marker and IS written
      // to be read by staff — pass it through instead of hiding it behind the
      // generic line. (`err.constraint` would be another such marker, but the
      // PostgrestError shape this app receives never carries one — only
      // message/details/hint/code — so only the message/details text can be
      // checked here.)
      const isRealConstraintViolation =
        /violates check constraint/i.test(m) || /violates check constraint/i.test(err.details ?? "");
      if (isRealConstraintViolation || !m) {
        return "Invalid value: that combination is not allowed by the schema.";
      }
      return m;
    }
    case "23503":
      // foreign_key_violation — caller referenced a row that doesn't exist or is locked from deletion.
      return err.message ?? "Referenced record was not found.";
    case "P0001":
      // Our je_lines_balance_check raise. The message already names the JE.
      return err.message ?? "Journal entry is unbalanced.";
    case "P0002":
      // Our je_period_lock_check raise.
      return err.message ?? "That accounting period is closed.";
    case "P0003":
      // Zero-line guard: journal entry has no lines.
      return err.message ?? "Journal entry must have at least one line.";
    case "P0004":
      return err.message ?? "Cannot edit payment after JE has posted. Void and re-create instead.";
    case "P0005":
      return err.message ?? "Cannot post to inactive account.";
    case "P0006":
      return err.message ?? "Accounts are append-only; deactivate via is_active = false instead.";
    case "P0007":
      return err.message ?? "Cannot un-void a payment. Create a new payment instead.";
    case "P0008":
      return err.message ?? "Cannot change billed amount: this claim item already has payments or resolutions.";
    case "P0009":
      return err.message ?? "Cannot delete resolution: void it instead so the journal entry can be reversed.";
    case "P0010":
      return err.message ?? "Cannot void this batch: it has allocated payments or resolutions on its items. Reverse those first.";
    case "P0011":
      return err.message ?? "Resolution amount exceeds the item's unresolved balance.";
    case "P0012":
      return err.message ?? "Allocation amount would exceed the item's billed amount.";
    // 12.A — HMO history import
    case "P0013":
      return err.message ?? "That import run no longer exists.";
    case "P0014":
      return err.message ?? "Can't commit — there are still rows with errors. Fix the workbook or resolve in the preview.";
    case "P0015":
      // The raw 0043 text leaks business_date and a UTC instant; say the day plainly.
      return eodClosedMessage(err.message);
    case "P0017":
      return err.message ?? "Cannot edit this cash adjustment after its journal entry has posted. Void and re-create instead.";
    case "P0018":
      return err.message ?? "Staff advance cannot go below zero.";
    case "P0019":
      return err.message ?? "That account is inactive. Pick a different one.";
    case "P0020":
      return err.message ?? "Cannot finalise: at least one employee is missing complete DTR / leave data.";
    case "P0021":
      return err.message ?? "Cannot edit this run after payouts have started. Adjust in the next period.";
    case "P0022":
      return err.message ?? "Employee has no daily rate set.";
    case "P0023":
      return err.message ?? "OT pay requires an approved OT slip for the same date.";
    case "P0024":
      return err.message ?? "Staff advance settlement cannot exceed the outstanding balance.";
    case "P0026":
      return err.message ?? "Cannot add an employee to a finalised run. Void and reopen first.";
    case "P0027":
      return err.message ?? "Cannot finalise an empty run. Compute first, or delete the run if no payroll is due.";
    case "P0028":
      return err.message ?? "Cannot use more leave than the employee has accrued. Grant additional days first if approving an advance.";
    // 12.4 — AP subledger
    case "P0029":
      // bill_void_blocked — DB message includes "has N active payment(s)"; use it as-is.
      return err.message ?? "Cannot void this bill — payments are still active. Void each payment first.";
    case "P0030":
      return err.message ?? "Allocation total doesn't match payment amount.";
    case "P0031":
      return err.message ?? "Allocation exceeds the bill's outstanding amount.";
    case "P0032":
      return err.message ?? "All allocated bills must be from the same vendor as the payment.";
    case "P0033":
      return err.message ?? "Cannot allocate to a draft or voided bill.";
    // 12.5 — COGS + Doctor PF subledger
    case "P0034":
      return "An attending physician is required for consults and procedures that pay the doctor a PF. Please select a physician on the visit before releasing this test.";
    // 12.5 sibling — send-out services have no structured template (0059).
    // Reachable from admin/result-templates/[service_id]/edit, which already
    // routes through this translator; it had no case until 0149 added the
    // coverage test that found it.
    case "P0035":
      return err.message ?? "Send-out services use the partner lab's PDF and cannot have a structured result template.";
    // PR 7 — booking hardening
    case "P0040":
      // appointments_insert_slot_guarded raise; byte-identical to the
      // historical slot_taken conflict message in timing.ts.
      return "That slot was just taken. Please pick another time.";
    case "P0041":
      // 0121 guard: template param deletes require explicit opt-in.
      return err.message ?? "Template parameter deletes must go through the admin tools.";
    // PR H — queue entry soft delete (0125)
    case "P0042":
      return "Only unpaid entries can be deleted. Void the recorded payments first (or, for a waived visit, ask an admin).";
    case "P0043":
      return "This entry has a released result and cannot be deleted. Undo the release first.";
    case "P0044":
      return "This test is part of a package — delete the whole package instead.";
    case "P0045":
      return "This visit was deleted from the queue. Restore it before recording a payment.";
    case "P0046":
      return "This visit was deleted from the queue. Restore it before changing its payment status.";
    // PR G — discount types
    case "P0047":
      return err.message ?? "Senior/PWD is a statutory 20% discount and cannot be changed, disabled, or deleted.";
    // PR N — EOD cash denomination count (0132)
    case "P0048":
      return err.message ?? "The denomination counts don't add up to the counted total. Re-check the count sheet.";
    // M1 — till cash has one write path (0145). Reception should never see
    // this: both doors now write eod_cash_adjustments. It fires only if some
    // future code path tries to post a petty-cash journal entry directly.
    case "P0049":
      return "Cash paid from the till has to go through the cash drawer so the day's count stays right. Record it under Cash Drawer › Petty Cash.";
    // 0147 — the entry is already billed to an HMO. Deleting it would drop a
    // real receivable out of the HMO reports (which skip deleted rows since
    // 0146), so the claim has to be withdrawn first.
    case "P0050":
      return "This entry has already been claimed from an HMO and cannot be deleted. Void the claim batch first.";
    // The third cash door — AP cash bill payments reach the drawer (0149).
    case "P0051":
      // Configuration faults, not data entry: no active cash shift, or a
      // payment with no staff member behind it. The DB message names which.
      return err.message ?? "This cash payment cannot be recorded against the cash drawer. Ask an admin to check the cash shift setup.";
    case "P0052":
      // Someone tried to void or edit the drawer row instead of the payment.
      // Doing that would hand the cash back to the till while the books still
      // show the supplier as paid.
      return err.message ?? "This cash drawer entry belongs to an AP bill payment. Void the payment itself so the books and the drawer stay together.";
    // Website Messages (0154): what the sender wrote is a record, not a draft.
    // Staff triage a message (status, type, notes, booking link) but never
    // rewrite it.
    case "P0053":
      return "A website message cannot be edited. You can only change its status, type or notes.";
    // Edit payment (0161): correct_payment refuses a stale, already-voided,
    // gift-code, HMO or imported payment, or an input it cannot record. The
    // DB message names which one and is written for reception.
    case "P0054":
      return err.message ?? "This payment cannot be edited. Delete it and record it again.";
    // Patient delete/restore (0167). The SQL messages are written for staff;
    // P0059's DETAIL carries the blocker list, which the delete action parses
    // separately (src/lib/patients/deletion.ts).
    case "P0057":
      return "Only an admin can delete or restore a patient record.";
    case "P0058":
      return err.message ?? "This patient record is already deleted or merged. Restore it first.";
    case "P0059":
      return "This patient still has open items. Close them first, then delete.";
    case "P0060":
      return err.message ?? "Choose a reason, and add a note (up to 500 characters) when the reason is Other.";
    case "P0061":
      return "This patient record is not deleted, so there is nothing to restore.";
    // 0172 — editing a FINISHED result (result_edit_commit / result_finalise_commit / result_save_draft)
    case "P0065":
      // Someone else's edit landed first under the row lock; the version this
      // form was opened with is stale. A fixed message reads better than the
      // DB's own wording here.
      return "Someone saved an edit to this result since you opened it. Reload the page to see their change, then make yours again.";
    case "P0066":
      // Raised from several different checks (result not found, no finished
      // PDF yet, not finalised, bad reason length, every test deleted, a test
      // not finished, the anchor test not live, already finalised…) — each
      // message is already staff-readable, so pass it through like P0029/P0051.
      // The raises are lower-case clauses; show them as a sentence.
      return err.message
        ? `${err.message.charAt(0).toUpperCase()}${err.message.slice(1)}.`
        : "This result can't be edited right now. Reload the page and try again.";
    case "P0067":
      return "This test is part of a finished combined report (such as Chemistry), so it can't be deleted on its own.";
    // Sheet Sync (0170): the lease-fenced sync RPCs.
    case "P0062":
      return "Another sheet sync is running. Try again in a few minutes.";
    case "P0063":
      return "This sheet sync stopped because a newer run took over. Check the run history.";
    case "P0064":
      return "Someone already handled this review item. Refresh the page.";
    // 0179: result_mark_copy_contacted — either the amendment id no longer
    // exists, or it is not the result's latest correction any more.
    case "P0068":
      return "This correction is no longer the latest one (the result was corrected again, or the entry is gone). Refresh the list and follow up the newest correction.";
    // 0183 — waived balances
    case "P0069":
      // Entering 'waived' outside waive_visit_balance(), leaving it, or
      // changing a waived visit's total / paid / billing / waiver record.
      return err.message ?? "A balance can only be waived with Waive balance on the visit page.";
    case "P0070":
      // Money or bill lines on a waived visit. Several messages, all written
      // for staff — pass them through.
      return err.message ?? "This visit's balance was waived, so its payments and lines are fixed.";
    case "P0071":
      // waive_visit_balance refusals (not admin, HMO, already waived/paid,
      // mixed provenance, total out of step, gift code in flight …).
      return err.message ?? "This visit's balance cannot be waived.";
    // Patient lifecycle locks (0184). P0072: the record moved to another
    // patient (or the patient was deleted/merged) while this save waited for
    // the lock; the transaction rolled back whole, so trying again is safe —
    // callers retry once automatically (src/lib/patients/lifecycle-retry.ts).
    case "P0072":
      return "This patient's records changed while you were saving. Please try again.";
    // create_visit_encounter (0184): a refusal the SQL words for reception
    // (bad total, malformed package, wrong role) — pass it through.
    case "P0073":
      return err.message
        ? `${err.message.charAt(0).toUpperCase()}${err.message.slice(1)}.`
        : "The visit could not be created. Please try again.";
    // A deadlock victim / serialization failure: nothing was saved. Covers
    // both 0183's waived-balance protocol and 0184's patient lifecycle locks
    // — both accept a rare conflict and let Postgres abort one side, and the
    // caller (or lifecycle-retry.ts) retries once, so the wording stays generic.
    case "40P01":
    case "40001":
      return "Another change to the same records was being saved at the same moment. Please try again.";
    // 0187: view_as_transition — the caller is not an active admin.
    case "P0074":
      return "Only an admin can view the app as another role.";
    // 0190: test_requests_claim_holder_guard — two distinct messages under
    // one code: the section-scope/inactive-holder refusal, and the
    // single-owner-role refusal ("Only an X-ray Technician can hold this
    // test.") — pass either through like P0066.
    case "P0075":
      return err.message
        ? err.message
        : "This staff member doesn't work this test's section, so they can't hold it.";
    // 0190: view_as_end_for — the caller isn't an admin, or is themselves
    // mid-simulation.
    case "P0076":
      return "Only an admin who isn't viewing the app as another role can end someone's role view.";
    // 0191 claim_panel_members: the panel was not claimed at all (all or nothing).
    case "P0077":
      return err.message
        ? err.message
        : "Some tests in this report were already claimed or changed status.";
    default:
      return err.message ?? "Database error. Please try again.";
  }
}
