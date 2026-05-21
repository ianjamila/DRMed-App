# ADR-0001: Patient self-service PIN reset is out of scope

- **Status**: Accepted
- **Date**: 2026-05-22
- **Decision-makers**: drmed.ph team
- **Supersedes**: —
- **Superseded by**: —

## Context

The patient portal at `/portal/*` authenticates patients via **DRM-ID + receipt PIN**, not Supabase Auth. Specifically:

- DRM-ID is the patient's permanent identifier (printed on every receipt).
- PIN is an 8-char value, **bcrypt-hashed at rest, scoped to a single visit, with a 60-day expiry**. Reception generates it at visit creation and prints it on the receipt exactly once.
- Patients have no Supabase Auth row — there is no email/SMS verification path tied to the patient identity.
- Sessions are short-lived HS256-signed JWT cookies (`drmed_patient_session`).

Stakeholders periodically ask whether patients can self-reset a lost PIN (e.g., "I lost my receipt, can I get a code emailed to me?"). The answer is **no, by design**, and this ADR records why so future maintainers don't accidentally rebuild the wrong thing.

## Decision

Patients **cannot self-reset their PIN**. To regain access, a patient must visit the clinic reception in person; reception verifies identity against the `patients` table (full name, birthdate, last-visit details) and issues a new visit-scoped PIN through the existing reception flow.

The architecture intentionally has no email / SMS / token-based recovery flow for patients.

## Consequences

### Positive

- **No credential-recovery attack surface.** No verification email → no phishing for that email, no "verify your account" templates an attacker can clone.
- **No verified-contact infrastructure required.** Email/SMS verification at registration would force a workflow change every patient sees, friction that small-clinic UX doesn't tolerate.
- **PIN is a per-visit secret.** Losing it is equivalent to losing a single receipt, not a long-lived account credential. Recovery via in-person identity check matches the value of what's protected.
- **RA 10173 audit trail stays clean.** Every PIN issuance is reception-mediated and audit-logged.

### Negative

- **Friction for genuinely lost receipts.** Patients who throw out their receipt before viewing results must physically return to the clinic. Mitigation: the printed receipt clearly states this.
- **Cannot serve remote / overseas patients.** A patient who already left town with no receipt has no path to results from afar. Mitigation: results can be emailed by staff on request through the staff portal (audit-logged).
- **Doesn't scale to multi-clinic / franchise.** If drmed.ph expands beyond a single physical reception, this decision needs revisiting.

## Alternatives considered

### A1: Email-based PIN reset

Capture email at visit registration → send a one-time reset link → patient sets a new PIN. **Rejected** because:
- Requires verified-email infrastructure at registration (new field, new validation step, new failure modes).
- Adds a phishing-clone attack vector (clone the reset email template, harvest PINs).
- Doesn't match the security model — the PIN is per-visit, not per-account, so "reset" semantics are unclear (which visit's PIN gets reset?).
- Adds compliance overhead: stored emails are PII under RA 10173 and need their own retention rules.

### A2: SMS-based reset

Same shape as A1, with PH SMS via Semaphore. **Rejected** for the same structural reasons plus:
- SMS delivery is unreliable in PH (network coverage, SIM changes).
- Phone-number recycling means a recovered SMS factor could be in the wrong hands a year later.

### A3: Hybrid (email/SMS allowed only after in-person verification)

Patient visits reception once, opts in to remote recovery, contact info is captured + verified. **Rejected** because it adds 80% of A1's complexity for a small fraction of the audience that would use it; the in-person visit is the same workload as just issuing a new PIN.

## Revisit triggers

This decision should be revisited if any of:

1. drmed.ph expands beyond a single reception location.
2. PH telemedicine regulations create a hard requirement for remote credential recovery.
3. A patient-segment that needs remote-only access (overseas Filipino workers, hospital-bound patients) becomes >5% of result-viewing traffic.
4. The portal grows beyond "view results" to anything stateful (appointment booking from the portal, payments, etc.).

## Related

- `src/lib/auth/patient-session.ts` — JWT session implementation
- `src/lib/auth/pin.ts` — PIN hashing + lookup
- `src/app/(patient)/portal/login/actions.ts` — login flow with rate-limit + PIN-lock
- `supabase/migrations/0006_patient_pins.sql` (or similar) — `visit_pins` table schema
