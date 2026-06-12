---
name: drmed-design
description: Use this skill to implement and extend the DRMed Clinic & Laboratory (drmed.ph) 2026 redesign — branded interfaces, marketing pages, and the booking flow — for production Next.js code or prototypes. Contains the final reference pages, design tokens, components, brand guide, photo manifest, and launch checklist.
user-invocable: true
---

# DRMed 2026 Redesign — implementation skill

Read **`README.md`** in this folder first — it contains the structure, the
implementation notes (routes, tokens→Tailwind mapping, fonts, icons, motion
guardrails), the booking wizard's business rules, and the **launch checklist
of placeholder content that must be replaced** (testimonials permissions, FAQ
sign-off, prices, mock wizard data). Carry those flags into any build.

Then explore:

- `homepage.html` + `booking.html` — the FINAL shipped reference pages. These
  are the source of truth for layout, copy, motion, and behavior. Open them in
  a browser; port them into Next.js App Router routes (`/`, `/schedule`).
- `design-system/readme.md` — the full brand guide: content voice (warm
  Filipino-English, "you/your family", numbers as proof), visual foundations
  (navy #263F91 / cyan #08A8E2, warm marketing field, Instrument Serif display
  with italic cyan accents, pill buttons with navy-ink CTA labels, ECG-pulse
  motif), iconography (Lucide only, no emoji), and AA contrast rules for cyan.
- `design-system/tokens/` + `styles.css` — CSS custom properties; map into
  Tailwind v4 `@theme`.
- `design-system/components/` — React reference components (`X.ref.jsx`, with
  `X.ref.d.ts` props and `X.ref.prompt.md` usage notes). Treat as visual spec,
  not drop-in code — `export` keywords are stripped (see file headers).
- `PHOTO-MANIFEST.md` — every image slot, its production path under
  `/public/photos/`, aspect, and supplied/pending status.

If creating throwaway visual artifacts (mocks, slides), copy assets out and
build static HTML against `design-system/styles.css`. If working on production
code, follow the implementation notes in README.md. If invoked without other
guidance, ask what the user wants to build, then act as an expert DRMed
designer-engineer.
