import "server-only";

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
      return "That value already exists. Pick a different one.";
    }
    case "23514":
      // check_violation — most likely the normal_balance / type mismatch.
      return "Invalid value: that combination is not allowed by the schema.";
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
      return err.message ?? "End of day is already closed for that date. Ask an admin to reopen first.";
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
      return "An attending physician is required for consults and procedures. Please select a physician on the visit before releasing this test.";
    default:
      return err.message ?? "Database error. Please try again.";
  }
}
