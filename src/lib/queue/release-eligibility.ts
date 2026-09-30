// Per-row release predicate for the lab queue — bench page, consolidated
// report, queue rows, bulk bar and releaseTestsAction all use it, so every
// surface refuses for the same reason in the same words. Pure: no I/O.
// The DB still enforces payment (0133) and consent (0088) at UPDATE time.
import type { StaffSession } from "@/lib/auth/require-staff";
import { canActOnResult } from "@/lib/visits/line-visibility";
import { moneySettled, type MoneySettledVisit } from "@/lib/visits/money-settled";
import type { Eligibility } from "@/lib/queue/claim-eligibility";
import {
  RELEASE_BLOCKED_CONSENT,
  RELEASE_BLOCKED_UNPAID,
  RELEASE_REFUSAL_PATIENT_INACTIVE,
} from "@/lib/visits/release-messages";

type Role = StaffSession["role"];

export interface ReleaseCandidate {
  status: string;
  isPackageHeader: boolean;
  /** isDoctorKind(services.kind), computed next to the caller's read (query-surfaces guard). */
  isDoctorLine: boolean;
  section: string | null;
  visitDeleted: boolean;
  patientActive: boolean;
  visit: MoneySettledVisit;
  consentOnFile: boolean;
  gateRequired: boolean;
}

export const RELEASE_REFUSAL = {
  reception: "Results are released by the lab team, not reception.",
  notReady: "This result is no longer ready to release.",
  header: "Package headers release on their own once every test in the package is released.",
  doctor: "Consultations and procedures are completed on the visit page with “Mark done”.",
  visitDeleted: "This visit was deleted from the queue.",
  patientInactive: RELEASE_REFUSAL_PATIENT_INACTIVE,
  section: "This test is outside the sections you can release.",
  unpaid: RELEASE_BLOCKED_UNPAID,
  consent: RELEASE_BLOCKED_CONSENT,
} as const;

export function evaluateRelease(c: ReleaseCandidate, role: Role): Eligibility {
  if (role === "reception") return { ok: false, error: RELEASE_REFUSAL.reception };
  if (c.visitDeleted) return { ok: false, error: RELEASE_REFUSAL.visitDeleted };
  if (!c.patientActive) return { ok: false, error: RELEASE_REFUSAL.patientInactive };
  if (c.isPackageHeader) return { ok: false, error: RELEASE_REFUSAL.header };
  if (c.isDoctorLine) return { ok: false, error: RELEASE_REFUSAL.doctor };
  if (!canActOnResult(role, c.section)) return { ok: false, error: RELEASE_REFUSAL.section };
  if (c.status !== "ready_for_release") return { ok: false, error: RELEASE_REFUSAL.notReady };
  if (!moneySettled(c.visit)) return { ok: false, error: RELEASE_REFUSAL.unpaid };
  if (c.gateRequired && !c.consentOnFile) return { ok: false, error: RELEASE_REFUSAL.consent };
  return { ok: true };
}
