# DRMed Design System

A brand & UI design system for **DRMed Clinic & Laboratory** (`drmed.ph`) — a
medical clinic and diagnostic laboratory in Quezon City, Metro Manila. This
system captures the colors, type, components, and full-screen UI kits used
across DRMed's three product surfaces so that any new design or prototype can
be built on-brand in minutes.

> Tagline: **"Your Family's Well-Being is Our Mission."**

---

## Sources

This system was reverse-engineered from the live product and its source code.
If you have access, explore them to go deeper:

- **Live marketing site:** https://drmed.ph/
- **Rebuild (staging):** https://drmedapp.vercel.app/
- **Facebook:** https://www.facebook.com/drmed.ph
- **Codebase (primary source of truth):** GitHub `ianjamila/DRMed-App`
  — a Next.js 15 + Supabase + Tailwind v4 + shadcn/ui monorepo. Brand tokens
  were lifted verbatim from `src/app/globals.css`; copy from
  `src/lib/marketing/site.ts`; component look from `src/components/ui/*` and
  `src/components/marketing/*`. Browse the repo to find additional screens,
  exact service catalogs, and the staff-portal workflow if you need them.

Reading these repositories will let you build far more accurate designs than
working from this summary alone.

---

## The product at a glance

DRMed serves three audiences from one codebase and one domain:

| Surface | Who | What |
|---|---|---|
| **Marketing site** (`/`) | The public | Services, packages, physicians, HMO partners, online booking |
| **Patient portal** (`/portal`) | Patients | Sign in with DRM-ID + receipt PIN; view & download released lab results |
| **Staff portal** (`/staff`) | Reception, medtechs, pathologists, admins | Run the daily lab workflow: intake → testing → sign-off → payment → release |

Locale is **en-PH**, currency **₱ (PHP)**, timezone **Asia/Manila**. The
product is built for compliance with the Philippine Data Privacy Act (RA 10173).

---

## CONTENT FUNDAMENTALS — how DRMed writes

**Voice:** warm, reassuring, and plainly competent. It speaks to families and
working professionals in everyday Filipino-English, never clinical jargon on
public pages. Trust and affordability are the recurring promises.

- **Person & address.** Marketing speaks to **"you / your family"** ("Your
  Family's Well-Being is Our Mission", "Access **your** complete lab results").
  It refers to the clinic as **"we / us"** ("**We** come to you", "**We** Accept
  Your HMO"). Friendly and direct.
- **Casing.** Headlines use **Title Case** ("Everything Under One Roof",
  "Meet Our Doctors"). Eyebrow kickers are **ALL-CAPS** with wide tracking
  ("CLINIC & LAB SERVICES", "ACCREDITED HMO PARTNERS"). Body is sentence case.
- **Accent fragment pattern.** Headlines split into a navy phrase + a **cyan
  highlight word**: "Everything Under *One Roof*", "Your Results, *Securely
  Accessible*", "We Accept Your *HMO*". Reuse this device — it's load-bearing.
- **Numbers as proof.** Confidence is shown with hard figures: "**19+**
  Specialist Physicians", "**24h** Average Turnaround", "**up to 50% less**
  than hospitals", "**10** HMO Partners". Keep stats concrete and short.
- **Plain language by audience** (a hard rule from the codebase): reception &
  patient-facing screens humanize jargon ("Starting cash" not "Opening float",
  "Difference" not "Variance"). Bookkeeper/accounting screens keep load-bearing
  terms (debit/credit, BIR codes). When unsure which audience a screen serves,
  ask.
- **Tone of CTAs:** imperative and short — "Book Now", "Book Appointment",
  "View Packages", "Meet Our Doctors", "Access my results", "Check All Services".
- **Compliance is stated, calmly.** "🔒 Protected under the Philippine Data
  Privacy Act (RA 10173)." appears in footers and portal pages — reassurance,
  not legalese.
- **Emoji**: the original site used emoji pictographs on marketing pages, but
  the June 2026 redesign **retires emoji entirely** in favor of Lucide line
  icons (see ICONOGRAPHY). Don't use emoji in new designs. The portals were
  always clean and text-led.

---

## VISUAL FOUNDATIONS

**Overall vibe:** clean, clinical, trustworthy — a cool blue field with
confident navy headlines and a bright cyan accent. Lots of white space, soft
hairline-ringed cards, and a calm, professional rhythm. Nothing flashy.

### Color
- **Navy `#263F91`** is the primary — headings, nav text, dark sections,
  solid buttons. **Cyan `#08A8E2`** is the single accent — CTAs, highlight
  words, eyebrow rules, focus rings, price text. **Steel `#4682b4`** is a
  secondary blue (logo subtext). The palette is otherwise restrained.
  _(Refreshed June 2026; legacy production values were `#284570` / `#06AEF1`.)_
- **Cyan contrast rules (AA):** `#08A8E2` measures **2.7:1 on white** and
  **3.5:1 on navy** — use it for icons, rules, fills, and LARGE display
  accents only. For small cyan text/links on light surfaces use
  `--color-brand-cyan-text` (`#0779A6`, 4.9:1 ✓). On dark surfaces use
  `--color-brand-cyan-bright` (`#3FC1F2`, 8.8:1 on the dark base ✓).
- Surfaces are **white** on a cool **`#f0f6fc`** page tint, with
  **`#e3eef9`** for hairline borders on tint. Ink is a near-navy **`#1a2537`**,
  softening to `#374151` and `#6b7280`.
- **Marketing surfaces went warm** in the June 2026 redesign: page field
  `#FBF9F5`, sand panels `#F3EEE6`, hairlines `#E9E2D5`/`#F0EBDF`
  (`--color-warm-*`). The cool blue tints remain for the patient/staff portals.
- **Status:** emerald `#059669` (released / paid), red `#dc2626`
  (destructive / errors), amber `#d97706` (caution). Emerald shows as a soft
  `#d1fae5` pill with `#064e3b` text.
- Avoid purple/violet gradients entirely — they're off-brand.

### Type
- **Instrument Serif** (400; italic for accents) is the **marketing display
  voice** — the June 2026 merged-D1 redesign. Big serif headlines with an
  *italic cyan accent word* ("Everything under *one roof.*").
- **Montserrat** (600–900, usually extrabold 800) remains for **portal/app
  headings** — tight leading, slightly negative tracking.
- **Public Sans** (400–700) for UI and body. Comfortable, neutral, legible.
- All are Google Fonts (loaded via `tokens/fonts.css`). See the font caveat
  at the bottom of this file.

### Backgrounds & sections
- Sections alternate three treatments: **white**, **`#f0f6fc` tint**, and a
  **solid navy** block (packages / contact / portal CTA) with white text.
- Soft top-to-bottom gradients `from #f0f6fc to white` open hero and teaser
  sections. A faint blurred cyan→navy glow sits behind the hero image.
- Real **photography** (clinic, physician headshots) and **partner logos**
  (HMO) — never illustration. Imagery is bright, warm, and human.

### Cards, borders & elevation
- The signature card is **white, ~14px radius (`--radius-xl`), with a 1px
  hairline** — either a `1px solid #e3eef9` border or an inset
  `ring (rgb(26 37 55 / .10))`, *not* a heavy drop shadow. Cards lift to a
  soft, cool-tinted shadow **on hover** (`--shadow-lg`) with a 2px rise.
- Radii: inputs/buttons `8–10px`, cards `14px`, feature panels `18–22px`,
  badges/avatars/pills fully round.
- Shadows are cool (navy-tinted, low opacity) and used sparingly — mostly on
  hover and floating elements (the hero's overlapping info chips).

### Buttons, hover & press
- Buttons are **pill-shaped** (June 2026). The **Cyan CTA** (`Book Now`) carries a **navy-ink label** (white-on-cyan fails AA) → navy fill + white label
  on hover. **Navy "brand"** buttons warm to cyan on hover. **Outline** buttons
  are hairline pills (`--color-warm-line`) whose border darkens to navy on hover.
- Hover lifts buttons ~1px; **press** nudges them back down 1px
  (`active:translate-y-px`). Transitions are quick (~120–200ms,
  `cubic-bezier(.4,0,.2,1)`).
- Focus shows a **3px cyan ring** at ~30–50% opacity.

### Motion
- Restrained. Short fades and color transitions; the only looping animation is
  the **HMO partner marquee** (40s linear, pauses on hover, disabled under
  `prefers-reduced-motion`). No bounces, no parallax.

### Transparency & blur
- The sticky marketing header is **white at 85–95% with a backdrop blur**.
- Navy feature panels occasionally hold **`white/5` glass cards** with a faint
  border and blur. Used lightly, for depth, on dark sections only.

### Layout
- Content max width **`max-w-7xl` (80rem)**, generous side padding. Vertical
  section rhythm is **~80px (`py-20`)**.
- Sticky 64px marketing header; fixed **256px staff sidebar** with a scrollable
  nav and a pinned user/sign-out footer.
- Eyebrow → headline → description → content grid is the repeating section
  skeleton.

---

## ICONOGRAPHY

**Standard: [Lucide](https://lucide.dev) everywhere — including marketing. No emoji.**
(Decision June 2026: the original drmed.ph used emoji pictographs on marketing
pages; the redesign replaces them with a consistent Lucide line-icon system.)

- Load from CDN in prototypes:
  `<script src="https://unpkg.com/lucide@0.469.0/dist/umd/lucide.min.js"></script>`
  then `<i data-lucide="stethoscope"></i>` + `lucide.createIcons()`.
  In production React, use `lucide-react` (already the shadcn/ui convention).
- Style: 1.5–2px stroke, round caps, `currentColor` — matches the app's
  existing ad-hoc chrome SVGs (hamburger, close, chevron).
- Suggested service mappings: stethoscope (consultation), test-tube /
  flask-conical (lab), scan-line (X-ray), heart-pulse (ECG), audio-waveform
  (ultrasound), clipboard-check (fit-to-work), house (home service), bus
  (mobile clinic), key-round (PIN), file-down (PDF), history (full history),
  shield-check (RA 10173), banknote / qr-code / landmark / credit-card
  (payments).
- The brand **logo** (`assets/logo.png`) is a stethoscope bent into a heart
  enclosing a family, beside the "DRMed Healthcare Inc." wordmark (DR navy /
  Med cyan). Use it on white or tint; knock out to white on navy.

---

## What's in this system (index)

**Root**
- `styles.css` — the single entry point consumers link (an `@import` manifest).
- `readme.md` — this guide.
- `SKILL.md` — Agent-Skill front-matter so this folder works in Claude Code.

**`tokens/`** — foundations imported by `styles.css`
- `colors.css` · `typography.css` · `spacing.css` (spacing + radius + shadow +
  motion) · `fonts.css` (@import webfonts) · `base.css` (resets + brand utility
  classes: `.drmed-eyebrow`, `.drmed-accent`, `.drmed-link`, surface helpers).

**`guidelines/`** — Design-System-tab specimen cards (Colors, Type, Spacing, Brand).

**`components/`** — reusable React primitives (props in `.d.ts`, usage in `.prompt.md`)
- `core/` — **Button**, **Badge**, **Card** (+ CardTitle/Description/Footer)
- `forms/` — **Input**, **Textarea**, **Select**, **Field**
- `patterns/` — **Eyebrow**, **SectionHeading**, **Stat**, **ServiceCard**, **DoctorCard**

**`templates/`** — copyable starting folders for consuming projects
- `marketing/` — the public homepage recreation (hero, services, packages, specialists, HMO, contact)
- `patient-portal/` — patient sign-in + released-results dashboard
- `staff-portal/` — staff dashboard shell (sidebar nav, queue, stat cards)

Each template loads the system via its sibling `ds-base.js` — one `base` line
to edit when consuming.

**`assets/`** — `logo.png`, `hero-clinic.jpg`, `doctors/` (physician headshots),
`hmo/` (partner logos).

---

## Using the components

In a `@dsCard` HTML file, load the compiled bundle and read components off the
namespace (do **not** `<script src>` the `.jsx` directly):

```html
<link rel="stylesheet" href="styles.css" />
<script src="_ds_bundle.js"></script>
<script type="text/babel">
  const { Button, Card, SectionHeading } = window.DRMedDesignSystem_019df8;
</script>
```

For throwaway prototypes and slides, you can also just link `styles.css` and
use the tokens + `.drmed-*` utility classes directly — see the UI kits, which
are built that way for portability.

---

## ⚠️ Caveats / font note

- **Fonts** (Public Sans + Montserrat) are loaded from **Google Fonts**, not
  bundled as local binaries. They render correctly online. If you need a fully
  offline build, download the `.woff2` files and replace the `@import` in
  `tokens/fonts.css` with local `@font-face` rules. **Both are exact matches to
  the production app — no visual substitution was made.**
- Icon substitution (Lucide for the app's ad-hoc SVGs) is flagged above.
