# DRMed Marketing Redesign — Design Notes

Living record of the June 2026 marketing redesign: where the implementation
deliberately departs from the design-handoff bundle, why, and what must be
verified before launch. The bundle itself is committed under `design-handoff/`
as the visual source of truth.

Brand canon (refreshed June 2026):

- Navy `#263F91`, navy-deep `#1B2E6E`, cyan `#08A8E2` (decorative/large only).
- AA-safe cyans: `#0779A6` on light, `#3FC1F2` / `#9BDCF7` on dark.
- Warm marketing field `#FBF9F5` / sand `#F3EEE6` / line `#E9E2D5` (marketing
  only — portals keep their cool tints).
- Marketing ink trio `#20283A` / `#4A5266` / `#7C8398`.
- Display serif: Instrument Serif (italic accents). Body: Public Sans.
- Tokens live in `src/app/globals.css` `@theme`; motion primitives in
  `src/components/marketing/motion/`.

## Deviations from the bundle (conflict resolutions)

These mirror the C1–C20 table in the approved plan. The constraint (codebase
truth / RA 10173 / accessibility) wins over the bundle in every case below.

### Booking wizard

- **C1 — Email required.** Bundle marked email optional; the zod schema requires
  it ("Valid email required for confirmation"; it is part of the dedup key). The
  wizard requires email.
- **C2 — Sex optional.** Bundle made F/M required; schema allows `"" | male |
  female`. Chips render with an unselected (blank) state allowed.
- **C3 — Mobile validation.** Bundle enforced `^09\d{9}$`; schema is
  `.min(7).max(40)`. Schema wins; the PH `inputmode`/placeholder styling is kept
  for affordance only.
- **C4 — Home service.** Bundle used street/brgy/city/landmark and no service
  picker; schema has one optional `address` field plus a **required** multi-select
  of tests/packages. Implemented as service multi-picker + a single address field.
- **C5 — Existing-patient lookup.** Bundle accepted a DRM-ID alone (`DRM-\d{3,6}`).
  Real flow needs DRM-ID **+ last name** via `lookupPatientAction` (regex
  `^DRM-\d{4,}$`, rate-limited); looked-up patients skip the "About you" step.
- **C6 — Consents + notes.** `service_agreement` is required, `marketing_consent`
  and `notes` optional. Added to the wizard (agreement + consent on Review, notes
  in Details).
- **C7 — Real slot rules.** Bundle mocked 8AM–4PM hourly with two fake-disabled
  slots. Real rules: 30-min slots Mon–Sat 08:00–16:30, ≥1h ahead, ≤60 days,
  honoring physician windows/overrides and clinic closures. Reuses the existing
  `SlotPicker` data/logic, restyled as a chip grid.
- **C8 — Time-slot is data-driven.** "Only ultrasound needs a slot" is really the
  per-service `requires_time_slot` flag; copy adjusted to stay truthful.
- **C9 — Doctor branch.** Bookable physicians confirm instantly; by-appointment
  physicians take no slot and return `pending_callback` ("we'll call to confirm").
  Success copy keys off the real status.
- **C10 — No PII in localStorage.** Bundle generated client ref codes (WK-1234)
  and persisted all PII to localStorage. We use the server-returned `drm_id` +
  `booking_group_id` and keep wizard state in memory only (RA 10173).
- **C11 — Walk-in exit + pre-register.** Bundle's package branch exited with no
  submission. We include **both** paths (per the standing "booking always
  optional" rule): an informational walk-in panel (hours/location/what to bring)
  **and** a "Pre-register" path that submits exactly as today. This is the one
  intentional behavioral addition.
- **C12 — Focused wizard layout.** `/schedule` adopts the bundle's focused funnel
  (no full marketing nav/footer; "Back to homepage" + hours/location inside the
  walk-in panel) via a route-level presentational opt-out. Route and metadata are
  preserved. `/portal/book` keeps working through `prefilledPatient` (patient-type
  step skipped).

### Homepage / shell

- **C13 — Dynamic roster + logos.** 6 specialists come from the DB (first 6 by
  `display_order`); all **10** HMO logos render from `HMO_PARTNERS` (bundle showed
  6 hardcoded doctors / 6 logos).
- **C14 — Real routes + full footer.** "Check all services" → `/all-services`
  (not `#contact`). Footer keeps **all** current link groups (Services, All
  Services, Packages, Schedule, Register, About, Contact, Portal, Privacy, Terms,
  socials, Staff sign-in) plus the newsletter signup, restyled.
- **C15 — Reuse ContactForm.** Homepage inquiry reuses `ContactForm` +
  `submitContactMessage` (name/email/phone/subject/message + honeypot); the
  subject is the bundle-styled select posting the same `subject` field.
- **C16 — No AI comps shipped.** The two pending-asset slots (hero inset,
  portal lifestyle) ship as `PendingPhoto` brand-gradient/ECG fallbacks sized to
  the exact slot, not the bundle's AI comps. Real photos drop in with zero layout
  change.
- **C17 — Token union, reference wins.** Where `tokens/colors.css` and the FINAL
  reference pages disagreed, the reference-page inline values win for marketing
  ink/warm field (ink `#20283A/#4A5266/#7C8398`, navy-deep `#1B2E6E`,
  cyan-on-navy `#9BDCF7`). Documented in the brand canon above.
- **C18 — Shared brand tokens.** The navy/cyan refresh touches tokens read by
  staff + patient portals. Allowed: portals get the refreshed navy/cyan but keep
  their cool-tint surfaces (warm tokens are marketing-scoped). The `.dark` block
  is untouched.
- **C19 — Placeholder content flagged.** Messenger FAB (`m.me/drmed.ph`),
  testimonials (3 named reviewers), FAQ answers, and prices/stats are implemented
  but marked PLACEHOLDER/VERIFY in code comments and in the launch checklist below.
- **C20 — Clip-path reveals sanctioned.** The brief's "transform/opacity only"
  rule and its "clip-path photo reveals" both appear; clip-path reveals are
  implemented as specified (GPU-composited, zero CLS) and are the sanctioned
  exception. Per review addendum R1 the hero photo renders **static below 640px**
  (no clip-path) to protect mobile LCP.

## Launch checklist — must replace/verify before go-live

Carried from the bundle's launch checklist (placeholder content). Each item below
is flagged PLACEHOLDER/VERIFY at its use site in code.

- [ ] **Testimonials** — 3 quotes lifted from public FB/Google reviews (Sassyy
      Llabres, Lei Malana, April Veluz). Obtain permission to feature names, or
      swap for cleared reviews.
- [ ] **FAQ answers** — drafted by design, not clinically reviewed: fasting
      guidance, HMO/LOA cashless process, results timing, pediatric availability,
      home-service scope/fee. Confirm each with clinic ops.
- [ ] **Prices** — ₱500 consult / ₱550 X-ray / ₱400 fit-to-work; package ranges
      ₱950–₱1,999, from ₱5,888, from ₱699. Sourced from marketing config;
      re-verify current pricing.
- [ ] **Trust stats** — "19+ physicians, 10+ HMO partners, up to 50% less, 24h
      turnaround". Verify all four.
- [ ] **Doctor roster** — confirm the 6 shown, specialties, and photo permissions.
- [ ] **HMO logos** — all 10 partner logos present in `public/hmo/`; confirm the
      roster is current.
- [ ] **Hero inset + portal lifestyle photos** — currently `PendingPhoto`
      fallbacks. Replace per PHOTOS-NEEDED.md (#2, #3).
- [ ] **Contact details & hours** — address, phones, email, Mon–Sat 08:00–17:00
      (also drives the "Open now" pill, Asia/Manila). Verify.
- [ ] **Messenger link** — confirm `m.me/drmed.ph` is the live page handle.

## Implementation log

- **Phase a** — foundation: tokens, Instrument Serif, motion primitives, bundle + photos.
- **Phase b** — shell: warm sticky nav (condense-on-scroll), navy-deep serif footer
  (all links + newsletter), Messenger FAB, ScrollPulse.
- **Phase c** — homepage rebuilt section-by-section in `src/components/marketing/home/`
  with shared primitives in `src/components/marketing/ui/` (`Eyebrow`,
  `SectionHeading`, `PillLink`). Sections: hero (serif H1 + ECG underline, CountUp
  stats, arch-top photo with ≥640px clip-path reveal, PendingPhoto inset), trust
  strip, NEW how-it-works, services (8, Lucide), navy packages band, DB-driven
  specialists (first 6 by `display_order`, C13), NEW testimonials (PLACEHOLDER),
  portal promo (#portal, PendingPhoto), HMO marquee (all 10, C13), payments, NEW
  gallery (4 real photos), NEW FAQ (PLACEHOLDER), restyled contact (ContactForm
  reused, subject→service select, C15) with hydration-safe open-now pill (R4).
  ECG dividers between sections + a navy ECG bridge into the footer. JSON-LD +
  metadata + anchors preserved. Brand icons: lucide-react has no Facebook/Instagram
  glyphs in this version → ExternalLink + aria-label used in contact/footer.

- **Phase d** — booking wizard. `/schedule`'s `BookingForm` rewritten into a
  5-step ECG-progress wizard (Patient → Booking → Details → About you → Review →
  Success) in `src/components/marketing/booking-wizard/` (EcgProgress, StepShell,
  ChoiceCard, Chip, WizardField, ReviewRows, SuccessPanel). **Booking behavior is
  unchanged**: the same `submitBookingAction` / `lookupPatientAction` / zod
  schemas, the same FormData keys. Architecture: visible steps are pure state UI
  (AnimatePresence slides), and one persistent `HiddenFields` block carries every
  value to the server, so steps can mount/unmount without losing data. `SlotPicker`
  was made controlled (state lifted) and restyled as a chip grid; availability /
  closure logic unchanged. Inline per-step validation shows the same zod messages
  (shake + ok-tick); server zod stays the source of truth. Focused-funnel layout
  (C12): `/schedule` hides the marketing nav/footer/FAB via `HideOnPaths` +
  `MarketingNav` self-opt-out and renders its own header + minimal footer; the
  walk-in hours/location moved into the diagnostic-package step. `/portal/book`
  reuses the wizard via `prefilledPatient` (Patient + About-you steps skipped).
  Deviations: the multi-test picker stays a searchable list (not chips) since the
  real catalog is ~250 tests; native `required` dropped in favor of JS gating +
  server zod (avoids hidden-step focusability errors). Verified steps 1–5 + doctor
  branch + validation at 1440/390; **live submission deferred to the phase-f E2E**
  (no real bookings created from local dev — R3).

_Updated through phase d. Subpages + final pass to follow._
