"use server";

import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { reportError } from "@/lib/observability/report-error";
import { STATEMENT_ROLES } from "@/lib/visits/statement";
import { fetchStatement } from "@/lib/visits/statement-data";
import { sendStatementEmail, type SendStatementResult } from "@/lib/visits/send-statement-email";

/**
 * Staff "Email to patient" on a visit's statement of account.
 *
 * Only ever to the address on the patient's record — there is no free-text
 * recipient, so a mistyped address cannot send someone's bill lines to a
 * stranger (RA 10173); a wrong address is fixed on the patient page first.
 * The content is rebuilt here from the database, never taken from the
 * client, through the same loader the printed page uses. The send itself —
 * the one-sender claim, the email, the audit row — is `sendStatementEmail`,
 * shared with the patient's own "Email it to me" in the portal.
 */
export async function emailStatementAction(visitId: string): Promise<SendStatementResult> {
  const session = await requireActiveStaff();
  if (!STATEMENT_ROLES.has(session.role)) {
    return { ok: false, error: "Only reception and admin can email a statement." };
  }

  let data;
  try {
    data = await fetchStatement(await createClient(), visitId);
  } catch (err) {
    await reportError({ scope: "statement/email:load", error: err, metadata: { visit_id: visitId } });
    return { ok: false, error: "Couldn't load the statement. Try again." };
  }
  if (!data) return { ok: false, error: "This visit no longer exists." };

  return sendStatementEmail(data, { type: "staff", userId: session.user_id });
}
