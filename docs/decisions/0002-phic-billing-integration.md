# ADR-0002: PHIC (PhilHealth) billing integration is out of scope

- **Status**: Accepted
- **Date**: 2026-05-22
- **Decision-makers**: drmed.ph team
- **Supersedes**: —
- **Superseded by**: —

## Context

drmed.ph ships **commercial HMO billing** as a first-class feature (Phase 12.3 + 12.A): vendors like Maxicare, Intellicare, and Medicard have full claim-batch lifecycle support — submission → acknowledgment → settlement → write-off — under `/staff/admin/accounting/hmo-claims/`.

**PHIC (PhilHealth)** is structurally different: it is the Philippine government's national health insurance program. Stakeholders ask whether PHIC billing can be added to the same subledger. The answer is **not in scope for the current phase**, and this ADR records why.

## Decision

PHIC e-claims integration is **deferred indefinitely**. Clinics that bill PhilHealth do so through PhilHealth's own portal and/or paper forms; drmed.ph does not capture PHIC member data, generate PHIC claim forms, or reconcile PHIC remittance.

## Consequences

### Positive

- **Phase 12.4 (AP subledger) shipped on schedule.** PHIC scope would have added weeks of regulatory discovery and pushed the AP feature back.
- **No PHIC-specific PII captured.** Less data to protect under RA 10173 (PHIC member ID + dependent info are sensitive).
- **No coupling to a moving regulatory target.** PHIC publishes new case-rate tables and policy circulars periodically; integrating would mean ongoing maintenance to track those changes.
- **Manual workflow already works.** Most small-to-mid PH clinics handle PHIC manually; clinic ops staff are familiar with it.

### Negative

- **Manual double-entry.** Staff record PHIC claims separately in the PhilHealth portal; revenue from PHIC is captured in drmed.ph only as a generic "PHIC payment" line, not at the case-rate level.
- **No drmed.ph-side audit of PHIC submissions.** The clinic relies on PHIC's portal for that.
- **Reporting gap.** Cannot answer "how much PHIC revenue did we book this quarter?" from drmed.ph alone without manual reconciliation.

## What integration would require

A future Phase ~13 / 14 / 15 PHIC integration would need (rough scope estimate: 3–6 weeks of focused work):

1. **Member data capture at visit registration.** New fields on `patients`: PHIC member ID, dependent, employer, premium status. Field validation against PHIC ID format. Optional verification against PHIC's eligibility API (if available).
2. **Subledger.** Either a new `phic_claims` family of tables or extension of `hmo_claim_batches` with a `program = 'phic' | 'hmo'` discriminator. Per-case-rate billing schedule.
3. **Case-rate mapping.** Procedure → PHIC RVS code → case-rate amount lookup. PHIC publishes these in periodic memoranda; needs a quarterly update process.
4. **Claim submission.**
   - **API path**: Most PH clinics do not have direct PHIC API access. Some accredited HCIs do; would need credential issuance via PHIC.
   - **Portal path**: Generate the claim packet for manual upload to PhilHealth Online (Claim Form 1 + 2 PDFs).
5. **Settlement reconciliation.** PHIC remittance arrives ~60–180 days post-submission. New flow: parse remittance file (CSV / PDF), match to outstanding claims, post settlement JEs, write off rejected amounts.
6. **Regulatory currency.** Periodic monitoring of PHIC circulars; quarterly review of case-rate updates; case-rate retroactivity rules.

## Alternatives considered

### A1: Lightweight PHIC subledger (no API)

Only capture PHIC at the case-rate level + manual settlement entry; no portal integration. Would address the reporting gap (~1.5 weeks) but doesn't reduce staff workload. **Deferred** until the reporting gap becomes a problem.

### A2: Full API integration

Pursue PHIC API accreditation, build full submission + remittance integration. **Rejected for current phase** — accreditation is its own multi-month process and clinic operating model doesn't require it yet.

### A3: Third-party PHIC integration vendor

Several PH-local SaaS vendors offer PHIC submission as a service. **Not pursued** — adds vendor dependency, monthly cost, and data-sharing exposure for member PII.

## Revisit triggers

This decision should be revisited if any of:

1. PHIC mandates electronic submission for accredited HCIs and drmed.ph clinics become subject to that mandate.
2. PHIC revenue exceeds ~15% of total clinic revenue, making the manual-double-entry overhead material.
3. The reporting gap (cannot see PHIC revenue in drmed.ph reports) becomes a recurring complaint from clinic ops or accounting.
4. A neighboring feature (e.g., capture insurance details at booking on the marketing site) creates a natural place to also capture PHIC info.

## Related

- `src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/page.tsx` — the commercial-HMO claims page (NOT PHIC)
- `supabase/migrations/0034_hmo_*.sql` etc. — HMO claim batch + resolution schema
- Memory note: `project_12.4_ap_brainstorm.md` discusses the boundary between AP and PHIC during 12.4 planning
