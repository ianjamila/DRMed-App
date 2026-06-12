# DRMed 2026 Redesign — Design Handoff

This folder is the complete, final handoff of the DRMed marketing redesign
(June 2026) for implementation in the Next.js repo (`ianjamila/DRMed-App`).
It is written to be consumed by **Claude Code** — point it at this folder
(see `SKILL.md`) and it has everything: reference pages, the design system,
brand guidance, and the launch checklist below.

## What's here

```
design-handoff/
├── homepage.html          ← FINAL merged homepage (open in a browser — fully working)
├── booking.html           ← FINAL booking wizard (5 steps, 4 paths, validation, success)
├── booking-wizard.js      ← wizard logic (state, ECG progress, branching, validation)
├── assets/                ← logo, clinic photo, doctors/, hmo/, photos/ (→ /public/... in Next.js)
├── design-system/
│   ├── styles.css         ← single CSS entry (imports tokens/)
│   ├── tokens/            ← colors, typography, spacing/radius/shadow, fonts, base utilities
│   ├── components/        ← React reference components (`X.ref.jsx` + `X.ref.d.ts` props + `X.ref.prompt.md` usage; `export` keywords stripped — see file headers)
│   └── readme.md          ← full brand guide: voice, visual foundations, iconography
├── PHOTO-MANIFEST.md      ← every image slot, expected path, aspect, status
└── SKILL.md               ← Claude Code skill front-matter + working instructions
```

## Implementation notes

- **Routes:** `homepage.html` → `/` (route group `(marketing)`); `booking.html`
  → `/schedule`. Both are static reference builds — port the markup into App
  Router components; all interactivity is vanilla JS you can translate to React
  state (the wizard's logic in `booking-wizard.js` is deliberately framework-free
  and heavily commented).
- **Tokens:** `design-system/tokens/*.css` are plain CSS custom properties —
  map them into Tailwind v4 `@theme` or keep them as-is in `globals.css`.
  Canonical brand values: navy `#263F91`, cyan `#08A8E2` (decorative/large only;
  AA text cyans: `#0779A6` on light, `#3FC1F2`/`#9BDCF7` on dark), warm
  marketing field `#FBF9F5`/`#F3EEE6`, cool tints retained for portals.
- **Fonts:** Public Sans (UI/body), Instrument Serif (marketing display, italic
  accents), Montserrat (portal headings). Self-host via `next/font` in
  production — `tokens/fonts.css` currently uses Google Fonts `@import` for
  prototyping.
- **Icons:** Lucide everywhere (`lucide-react` in production). No emoji.
- **Motion guardrails** (already implemented in the reference pages): ambient
  cycles ≥8s, transform/opacity only, everything gated on
  `prefers-reduced-motion`, ambient simplified to static under 640px, max two
  ambient layers per section.
- **Buttons:** pill-shaped; cyan CTA carries a navy-ink label (white-on-cyan
  fails AA) and flips to navy/white on hover.

## Booking wizard — business rules (preserve exactly)

1. **Diagnostic Package** → no scheduling; branches to a friendly walk-in path
   (hours, location, what to bring) + optional pre-registration.
2. **Laboratory Request** → multi-select tests; **only ultrasound requires a
   date + time slot**.
3. **Doctor Appointment** → specialty → doctor → date → slot; "reception will
   text to confirm."
4. **Home Service** → address details; sets the "reception will call to
   confirm schedule and fee" expectation.
- Helper copy throughout: identity verified at the counter; corporate/HMO →
  message us instead; RA 10173 privacy note; inline validation with no
  end-of-form surprises.

## ⚠️ LAUNCH CHECKLIST — placeholder content that MUST be replaced/verified

**Content needing replacement or sign-off (Claude Code: carry these flags):**

1. **Testimonials (highest priority).** The three quotes are lifted verbatim
   from public Facebook/Google reviews (Sassyy Llabres · FB Jul 2024, Lei
   Malana · FB Aug 2024, April Veluz · Google Jan 2021). **Obtain permission
   to feature names**, or swap for reviews the clinic has clearance to use.
2. **FAQ answers.** Drafted by design, **not clinically/operationally
   reviewed**: fasting guidance (8–10h), HMO/LOA cashless process, results
   timing ("within 24 hours", text+email notification claim), pediatric
   availability, home-service scope and fee process. Confirm each with clinic
   ops before launch.
3. **Prices.** ₱500 consultation / ₱550 X-ray / ₱400 fit-to-work; package
   ranges ₱950–₱1,999, from ₱5,888, from ₱699 — sourced from the repo's
   marketing config; re-verify current pricing.
4. **Trust stats.** "19+ physicians, 10+ HMO partners, up to 50% less, 24h
   turnaround" — verify all four are still accurate claims.
5. **Doctor roster.** 6 of 19+ physicians shown with inferred specialty tags;
   confirm roster, specialties, and photo permissions.
6. **HMO logos.** 6 logos shipped vs "10+" claimed — supply the remaining
   partner logos (see PHOTO-MANIFEST).
7. **Hero + portal lifestyle photos.** AI-generated comps in place — replace
   with real shoots (specs in PHOTO-MANIFEST #2 and #3).
8. **Booking wizard mock data:** time slots (8 AM–4 PM with two artificially
   disabled), the test/package catalogs, the doctor-per-specialty mapping, the
   DRM-ID format check (`DRM-####`), and client-generated reference codes —
   all need wiring to the real Supabase backend.
9. **Contact details & hours.** Address, phones, email, Mon–Sat 8–5 (also
   drives the "Open now" pill, Asia/Manila) — verify.
10. **Messenger link** `m.me/drmed.ph` — confirm the page handle.

## Provenance

Built on the DRMed design system reverse-engineered from
`ianjamila/DRMed-App` (Next.js 15 + Supabase + Tailwind v4 + shadcn/ui),
https://drmed.ph and https://drmedapp.vercel.app. Direction: "Refined
Evolution" (warm editorial serif) merged with the ECG-pulse motif, selected
June 2026 after a two-direction exploration.
