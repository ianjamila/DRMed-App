# Tier-1 SEO / AEO — Design Spec

**Date:** 2026-06-16
**Branch:** `feat/seo-aeo-tier1` (worktree `.worktrees/seo-aeo-tier1`, off `origin/main`)
**Status:** Approved design → ready for implementation plan

## Goal

drmed.ph went live on Vercel (Shopify cutover, 2026-06-16). The canonical host
now flows from `NEXT_PUBLIC_SITE_URL=https://drmed.ph` → `SITE.url`. This is the
first SEO/AEO build after cutover: per-doctor pages, full structured data, a
complete sitemap, per-page metadata, and a booking conversion event — to win
both classic search and AI-search (answer engines).

Guardrails (non-negotiable):

- **Prices always come from the `services` table**, never hardcoded.
- **No analytics/trackers on `/portal` or `/staff`** (RA 10173).
- Match existing `src/components/marketing/*` patterns and `SITE`/`CONTACT`/`SOCIAL`.

## Decisions (locked with user, 2026-06-16)

1. **Per-doctor content:** bio + specialty only for now (the `physicians` table
   has **no `credentials`/`PRC` columns** — only nullable `bio` + free-text
   `specialty` + a `physician_specialties → specialty_codes` join). Structured
   credentials/PRC = explicit future enhancement, not built here.
2. **Booking CTA:** deep-links to `/schedule?doctor=<slug>`, preselecting the
   Doctor-appointment branch + that physician (additive props into the booking
   form — no refactor of `booking-form.tsx`).
3. **Geo:** I geocode the clinic address; **user verifies the exact pin from the
   Google Business Profile before merge.** The MedicalClinic builder omits
   `geo`/`hasMap` when coordinates are unset, so an un-verified merge is safe.
4. **Analytics scope:** move `<Analytics/>` out of the **root** layout into the
   **marketing** layout group, so Vercel Web Analytics no longer fires pageviews
   (which carry patient/visit IDs in the path) on `/portal` + `/staff`.

## Premise corrections (from codebase exploration)

- Every marketing page **already** has a `title`+`description` metadata export
  **except the homepage**. None set `alternates.canonical` or per-page
  Open Graph/Twitter. So item #4 = add canonical + OG/Twitter (+ a homepage
  metadata export), and tighten thin titles — *not* write titles from scratch.
- There is **no shared JSON-LD helper** today; the only structured data is one
  inline `MedicalBusiness` block on the homepage (`page.tsx`, inline `<script>`).
- `/physicians` is missing from the sitemap; there is no `[slug]` route yet.
- `site.ts` has **no `legalName`, `postalCode`, or geo coordinates**; logo is
  `/public/logo.png` (not referenced in any metadata/JSON-LD).

## Architecture — new shared infrastructure

| File | Purpose | Tested by |
|---|---|---|
| `src/lib/marketing/structured-data.ts` | **Pure** builder fns returning plain JSON-LD objects. No `server-only`, no DB. Prices passed in. | vitest |
| `src/components/marketing/json-ld.tsx` | `<JsonLd data={obj \| obj[]} />` → renders `<script type="application/ld+json">`. | — |
| `src/lib/marketing/faq.ts` | Lift `FAQ_ITEMS` out of `Faq.tsx`; component + FAQPage JSON-LD share one source. | — |
| `src/lib/marketing/metadata.ts` | `pageMetadata({title, description, path, image?, absoluteTitle?})` → `Metadata` with canonical + OG/Twitter. | vitest (optional) |
| `src/lib/marketing/physicians.ts` | `listActivePhysicians()` (server-only, mirrors `listActiveServices`) → `{slug, full_name, updated_at}[]` for the sitemap. | — |
| `src/app/(marketing)/physicians/[slug]/page.tsx` | New per-doctor route. | build + visual |

`site.ts` additions: `CONTACT.address.postalCode = "1106"`; `GEO = { lat, lng, mapUrl }`
(candidate, verify before merge); `SITE.priceRange` (`"₱₱"`); `SITE.ogImage`
(`/hero-clinic.jpg`) and a `logo` const (`/logo.png`).

### Why pure builders + thin component

The builders are pure → unit-testable (matches the repo's "pure logic is
vitest-tested, modules under test must not `import "server-only"`" convention).
The component only renders. Service price is **passed in** from an
already-fetched `PublicService`, so the builder module never touches the DB and
never hardcodes a price.

## 1 · Per-doctor pages — `/physicians/[slug]`

- `export const revalidate = 300` (mirrors the directory page's ISR).
- `generateStaticParams()` → active physician slugs via `listActivePhysicians()`.
- Fetch by slug: physician row + `physician_specialties→specialty_codes` labels +
  `physician_schedules` (recurring) + upcoming `physician_schedule_overrides`.
  `notFound()` when no active physician matches.
- Reuse `physicianPhotoUrl`, `formatSchedule`, `DAY_NAMES`/`formatTime`, and the
  `schedule/page.tsx` blocks+overrides pattern.

**Layout** (follows the warm-card design system):

```
[Breadcrumb: Home › Physicians › Dr. Full Name]            ← BreadcrumbList JSON-LD
┌─ hero card ──────────────────────────────────────────┐
│  [3/4 PHOTO]   SPECIALTY (cyan eyebrow)               │
│               Dr. Full Name  (display font)           │
│               [group_label chip]                      │
│               bio paragraph (rendered only if present)│
│               [ Book an appointment → ]  → /schedule?doctor=<slug>
└──────────────────────────────────────────────────────┘
┌─ Clinic schedule ────────────────────────────────────┐
│  📅 Mon & Wed · 10:00 AM – 12:00 NN   (formatSchedule)│
│  └ "By appointment — reception confirms the slot" fallback
│  ⚠ Upcoming change: away Jun 20       (from overrides)│
└──────────────────────────────────────────────────────┘
┌─ Visit us (reused location mini-card) ───────────────┐
│  Address · Mon–Sat 8–5 · phone · [Get directions →]  │
└──────────────────────────────────────────────────────┘
        [ ← All specialists ]  → /physicians
```

- **Mobile-first:** verify at 390px (single column, photo stacks above text) and
  1440px. Reuse existing tokens/components; no new color/spacing primitives.
- **JSON-LD:** `Physician` + `BreadcrumbList`.

**Linking in:**
- `/physicians` directory: wrap each card `<article>` in a `<Link href={"/physicians/"+doc.slug}>` (slug already in scope). Keep hover treatment.
- Homepage `Specialists`: thread `slug` through `page.tsx`'s `specialists` map and the `Physician` interface in `Specialists.tsx`; link each card.

## 2 · Structured data

All emitted via `<JsonLd>` using the pure builders.

**Homepage** (replaces the inline `MedicalBusiness`):
- `medicalClinicLd()` — `@type: MedicalClinic`, `@id: <url>/#clinic`, name, url,
  logo, image (ogImage), email, telephone (E164), `priceRange`, `address`
  (PostalAddress incl. postalCode), `geo` (GeoCoordinates — **omitted if unset**),
  `hasMap` (Google Maps URL — omitted if unset), `areaServed`
  (`City: Quezon City` + `Metro Manila`), `openingHours: "Mo-Sa 08:00-17:00"`,
  `medicalSpecialty: ["Diagnostic","ClinicalLaboratory","Radiology"]`,
  `sameAs: [facebook, instagram]`.
- `websiteLd()` — `@type: WebSite` + `potentialAction: SearchAction` targeting
  `<url>/all-services?q={search_term_string}`. **Wire the all-services catalog to
  read an initial `?q=`** so the SearchAction is honest/functional (small
  additive change to `services-catalog.tsx` + its page reading `searchParams`).
- `faqPageLd(FAQ_ITEMS)` — `@type: FAQPage`, mainEntity Question/Answer from the
  shared `faq.ts`.

**Per-doctor page:** `physicianLd(doc, specialtyLabels)` (name, url, image,
`medicalSpecialty`, `worksFor` → clinic `@id`) + `breadcrumbLd(trail)`.

**`/physicians` directory:** `physiciansItemListLd(docs)` — `@type: ItemList` of
ListItem(url, name).

**`/all-services/[code]`:** `serviceOfferLd(service)` — `@type: Service`, name,
description, url, `provider` → clinic `@id`. **Priced `offers` (Offer, PHP,
InStock) ONLY when `service.kind === "lab_package"`** — mirrors the UI's
deliberate "show package prices only; individual = confirmed at reception"
policy, so JSON-LD never leaks prices the page hides. `breadcrumbLd` on the page.

## 3 · Sitemap

- Add `/physicians` to the static list.
- Add every `/physicians/<slug>` via `listActivePhysicians()` (mirrors the
  existing `listActiveServices()` block; `lastModified` = `updated_at`).
- **Coverage check (verified):** every package is a `lab_package` service →
  already enumerated under `/all-services/<code>`; the `/packages` overview page
  is already listed. No additional package routes needed.

## 4 · Per-page metadata

`pageMetadata()` applied to: `/` (NEW export, `absoluteTitle`), `/packages`,
`/about`, `/contact`, `/physicians`, `/all-services`, `/all-services/[code]`
(via `generateMetadata`, OG image = none/default; canonical = the code URL),
`/schedule`. Each gets a unique, tightened title/description, `alternates.canonical`,
and OG/Twitter (`summary_large_image`, default image = `SITE.ogImage`; per-doctor
pages use the doctor photo). The Next title template (`%s — drmed.ph`) stays;
child pages pass a plain string title (template-wrapped), home passes
`absoluteTitle`.

## 5 · Booking conversion event + analytics scoping

- **Deep-link:** `schedule/page.tsx` (already `force-dynamic`) reads
  `searchParams.doctor`, resolves slug → physician id among loaded physicians,
  passes optional `initialBranch="doctor_appointment"` + `initialPhysicianId`
  into `BookingForm`. These become the `useState` initial values (default =
  current behavior when absent). Unknown slug → ignored. **Additive only — the
  ~1,000-line `booking-form.tsx` is not refactored.**
- **Event:** on a successful booking (`submitBookingAction` returns `ok`), fire
  `track("booking_submitted", { branch, services: <count> })` via
  `import { track } from "@vercel/analytics"`. **No PII** (no name/email/phone).
  Guard against duplicate fires (fire once per success).
- **Scope `<Analytics/>`:** remove from `src/app/layout.tsx` (root); add to
  `src/app/(marketing)/layout.tsx`. Marketing routes keep analytics + the custom
  event; `/portal` + `/staff` get none. (Only `<Analytics/>` is in use — no
  Speed Insights.)

## Testing

- **vitest:** new `structured-data.test.ts` — asserts each builder's shape;
  Service offer present for `lab_package` and **absent** for other kinds; price
  comes from the passed-in value (never hardcoded); MedicalClinic omits `geo`
  when coords unset and includes it when set; FAQPage maps every item;
  Breadcrumb positions are 1-based. (Optional `metadata.test.ts` for canonical.)
- `npm run typecheck` + `npm test` + `npm run build` all green.
- **Visual pass @ 390px and 1440px:** new per-doctor page, the now-linked
  directory cards, and the homepage Specialists cards.
- **JSON-LD validation:** structurally validate emitted objects against
  schema.org shapes in code/tests; note the Google Rich Results Test URL for the
  user's own spot-check post-deploy.

## Out of scope (flagged, NOT built)

- Structured `credentials`/`PRC` columns + admin editor + backfill.
- AEO Tier-2 (`llms.txt`, local-SEO citations, review-collection flow).
- A bespoke 1200×630 OG image asset (we reuse `/hero-clinic.jpg`).
- Per-physician availability "next open slot" computation beyond
  `formatSchedule` + upcoming overrides.

## Pending user action before merge

- **Verify the clinic geo pin** (lat/lng + Google Maps URL) from the Google
  Business Profile and confirm/replace the candidate in `site.ts`. If left
  unconfirmed, the build ships valid MedicalClinic JSON-LD **without** geo/hasMap.

## File-by-file change list

**New:**
- `src/app/(marketing)/physicians/[slug]/page.tsx`
- `src/lib/marketing/structured-data.ts` (+ `structured-data.test.ts`)
- `src/components/marketing/json-ld.tsx`
- `src/lib/marketing/faq.ts`
- `src/lib/marketing/metadata.ts`
- `src/lib/marketing/physicians.ts`

**Modified:**
- `src/lib/marketing/site.ts` — postalCode, GEO, priceRange, ogImage/logo consts.
- `src/app/(marketing)/page.tsx` — swap inline MedicalBusiness for
  `medicalClinicLd` + `websiteLd` + `faqPageLd`; add homepage `metadata`.
- `src/components/marketing/home/Faq.tsx` — import `FAQ_ITEMS` from `faq.ts`.
- `src/components/marketing/home/Specialists.tsx` — add `slug`, link cards.
- `src/app/(marketing)/physicians/page.tsx` — link cards, add ItemList JSON-LD,
  add `pageMetadata`.
- `src/app/(marketing)/all-services/page.tsx` — `pageMetadata`; read `?q=`.
- `src/app/(marketing)/all-services/services-catalog.tsx` — accept initial query.
- `src/app/(marketing)/all-services/[code]/page.tsx` — `generateMetadata` via
  `pageMetadata`; add Service+Offer + Breadcrumb JSON-LD.
- `src/app/(marketing)/{packages,about,contact,schedule}/page.tsx` — `pageMetadata`.
- `src/app/sitemap.ts` — add `/physicians` + per-doctor entries.
- `src/app/(marketing)/schedule/page.tsx` — read `?doctor=`, pass initial props.
- `src/app/(marketing)/schedule/booking-form.tsx` — accept initial branch/physician
  props; fire `track()` on success (additive).
- `src/app/layout.tsx` — remove `<Analytics/>`.
- `src/app/(marketing)/layout.tsx` — add `<Analytics/>`.
