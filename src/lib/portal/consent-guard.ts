import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import { activePatients } from "@/lib/patients/active";

/**
 * The portal's consent rule, applied where the layout cannot reach.
 *
 * The (authenticated) layout shows the consent notice in place of the page
 * when `patients.consent_current` is false — a patient who never agreed, or
 * whose withdrawal staff recorded. That alone does not keep their record
 * behind the notice:
 *
 *   - Server Actions and route handlers are plain POST/GET endpoints; the
 *     layout never runs for them, so a stale tab or a direct call reaches
 *     result downloads, the statement email and the data export.
 *   - Layouts and pages render in parallel, and a layout does not re-render on
 *     a client-side navigation (Next.js docs, "Layout checks"), so a page must
 *     not assume the layout's check ran first.
 *
 * Owner decision 2026-09-25: withdrawal blocks the portal entirely, record
 * access included — the patient agrees again in the portal, or gets printouts
 * at the front desk.
 */

export const PORTAL_CONSENT_REQUIRED_ERROR =
  "Please review and accept the privacy notice on your portal home page first.";

/**
 * Whether the signed-in patient has consent on file. Takes the session's
 * patient id — already proven active by getActivePatientSession /
 * requirePatientProfile — and re-reads it as an ACTIVE record only (0167:
 * no merge chain). A record deleted or merged between the session check and
 * this read answers false, so nothing is disclosed from it, and a merged
 * record never borrows the kept record's consent. `cache` shares one read
 * between the layout-free page and anything else in the same request.
 */
export const portalConsentCurrent = cache(async (patientId: string): Promise<boolean> => {
  const admin = createAdminClient();
  const { data: row } = await activePatients(
    admin.from("patients").select("consent_current").eq("id", patientId),
  ).maybeSingle();
  return row?.consent_current === true;
});
