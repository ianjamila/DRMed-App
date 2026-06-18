# Local-SEO enrichment — design (SEO/AEO Tier 2, feature 2 of 3)

**Date:** 2026-06-18
**Branch:** `feat/local-seo-enrichment` (worktree, off `origin/main` `1f2fdc3`)
**Status:** design approved; spec for review
**Context:** Tier 2 feature 1 (llms.txt + IndexNow audit) merged as #84 and live. This is
feature 2. Feature 3 (post-visit review collection → `aggregateRating`) is separate and
deliberately NOT in this build. See `project_seo_aeo_roadmap` / `project_seo_aeo_tier2`.

## Goal

Strengthen drmed.ph's **local** search + AI-answer presence for a *single* physical clinic
in Quezon City, via three pillars:

1. **NAP consistency** — make the clinic's Name / Address / Phone / hours come from one
   source so every page and every schema agree byte-for-byte.
2. **Richer LocalBusiness/geo structured data** — make the `MedicalClinic` JSON-LD a
   complete local entity (hours spec, contact points, areas served, payments, geo).
3. **One rich location page** — enrich the existing `/contact` into the canonical
   "Visit us / find us" page (map, directions, landmarks, areas served).

Non-negotiable framing: **no doorway pages.** DRMed is one location; programmatic
`[test]-in-[barangay]` pages are a Google-penalty risk and are explicitly out of scope.

## Decisions (resolved during brainstorm)

| Decision | Choice | Why |
|---|---|---|
| Area/landing pages | **One rich location page** (no per-area pages) | Single-location clinic → doorway-page penalty risk. |
| Where the location content lives | **Enrich existing `/contact`** (no new route) | Already in nav + sitemap; consolidates link equity; avoids a duplicate location page. |
| Map | **Click-to-load Google Maps embed** | Useful local signal + directions, but no Google cookies on initial load (RA 10173-friendly). No API key needed. |
| Reviews / `aggregateRating` | **Out of scope** (Feature 3) | Never fabricate ratings; real review flow is its own feature. |

## Architecture overview

Three pure/data layers feed the marketing UI; the page components only consume them:

```
site.ts        (DATA: SITE, CONTACT, GEO, SOCIAL, + new HOURS, + new AREAS_SERVED)
   │
   ├─► nap.ts            (DERIVATIONS: formatted address/hours strings, tel:/maps/waze/apple hrefs, isOpenNow)  ← NEW, pure, unit-tested
   │       └─► marketing UI components (Contact, HowItWorks, Hero, OpenNowPill, /contact, /physicians, booking-form, branded-email)
   │
   └─► structured-data.ts (SCHEMA: clinicNode + new fields; faqPageLd; physicianLd fix; breadcrumbLd)  ← pure, unit-tested
           └─► page JSON-LD (<JsonLd>) on /contact (+ breadcrumbs on /about, /packages, /all-services index)
```

**Key boundary rule:** `site.ts` stays pure data (no functions beyond `as const`).
Derivations (formatting, href building, open-now math) live in `nap.ts`. Schema lives in
`structured-data.ts`. Components import display strings/hrefs from `nap.ts`, never hardcode.

## Pillar A — NAP single source of truth

### A1. Structured hours
Add `HOURS` to `site.ts` as the single source for opening hours:

```ts
export const HOURS = {
  days: ["Mo", "Tu", "We", "Th", "Fr", "Sa"], // schema.org dayOfWeek 2-letter
  opens: "08:00",
  closes: "17:00",
  lastRegistration: "16:30", // matches the booking form copy
  timezone: "Asia/Manila",
} as const;
```

Today hours exist in **three** un-linked forms — free-text `CONTACT.hours`, `OpenNowPill`'s
baked-in `8–17 Mon–Sat` JS, and `"Mo-Sa 08:00-17:00"` in `structured-data.ts`. All three
will derive from `HOURS`.

### A2. `nap.ts` derivation helpers (NEW, pure, tested)
- `addressOneLine()` / `addressMultiLine()` — canonical address strings (kills the
  hardcoded `"4/F Northridge Plaza…"` literals **and** `branded-email.ts`'s reconstructed
  `"4/F "` prefix).
- `hoursLabel()` → e.g. `"Monday – Saturday, 8:00 AM – 5:00 PM"`.
- `telHref(which)` → `tel:` link for mobile/landline; `phoneDisplay(which)`.
- `directionsHrefs()` → `{ google, waze, apple }` map/directions URLs from `GEO`/address.
- `isOpenNow(date)` → boolean, computed in `Asia/Manila` from `HOURS`. Pure (date passed in).

### A3. Replace hardcoded NAP literals
Replace every hardcoded literal found in the audit with `nap.ts`/`CONTACT`/`HOURS`:

| File | What's hardcoded → replace with |
|---|---|
| `src/components/marketing/home/Contact.tsx` (L74, 76, 102) | address, city/region, hours → `nap` helpers |
| `src/components/marketing/home/HowItWorks.tsx` (L17, 23) | hours ref, address → `nap` helpers |
| `src/components/marketing/home/Hero.tsx` (L90, 154) | "Quezon City" eyebrow, alt text → `CONTACT`/`SITE` |
| `src/components/marketing/home/OpenNowPill.tsx` (L29–31) | baked 8–17 Mon–Sat logic → `isOpenNow()` from `HOURS` |
| `src/app/(marketing)/physicians/page.tsx` (L107, 140, 144, 147) | address sub-nav + phone numbers → `nap`/`CONTACT` |
| `src/app/(marketing)/schedule/booking-form.tsx` (L1054, 1058) | hours, address → `nap` helpers |
| `src/app/(marketing)/contact/page.tsx` (L12, 36) | metadata desc + address prop → `nap`/`HOURS` |
| `src/lib/notifications/branded-email.ts` (L98) | `"4/F " + line2` → `addressOneLine()` |

Staff `new-appointment-sheet.tsx` (L488) is internal and lower priority; fix it too for
consistency since it's the same one-line change.

**Acceptance:** changing address/phone/hours in `site.ts`/`HOURS` once changes them
everywhere (UI + schema + email) with zero remaining string literals. Grep for
`Northridge`, `Congressional`, `8 AM`, `0916 604`, `355 3517` outside `site.ts` returns only
intentional prose, not NAP data.

**Name literals:** the brand name is *also* hardcoded in ~16 spots (page metadata, register
emails, gallery alt text, email templates). The 2026-06-18 name standardization already
swapped these `&`→`and` in place (see decision #6); during this build, consolidate them to
`SITE.name` (interpolated) so the name can't drift again — same single-source principle as
the address/phone/hours.

## Pillar B — richer LocalBusiness / geo structured data

Enhance `clinicNode()` in `structured-data.ts` (pure → unit-tested). New/changed fields:

- `openingHoursSpecification` — structured array from `HOURS` (alongside the existing
  `openingHours` string for back-compat).
- `contactPoint[]` — **both** mobile + landline, each with `contactType`
  (`"customer service"` / `"reservations"`), plus the Messenger URL as a contact channel.
- `areaServed` — expand from `[Quezon City, Metro Manila]` to the **real** adjacent QC areas
  (see `AREAS_SERVED` below) as `Place`/`City` nodes. Truthful, owner-confirmed.
- `image` — array of multiple clinic photos (currently single).
- `paymentAccepted: "Cash, GCash, Maya, Credit Card, HMO"`, `currenciesAccepted: "PHP"`.
- `knowsLanguage: ["en", "fil"]`.
- `sameAs` — add the **Google Maps place URL** (entity reconciliation to the GBP) alongside
  FB + IG.
- `potentialAction` — `ReserveAction` → `${SITE.url}/schedule` (book intent / AI agents).
- `amenityFeature[]` — `LocationFeatureSpecification` for wheelchair access + parking
  **(emitted only once owner-confirmed; see Owner-confirmation items).**
- keep existing `geo` / `hasMap`.

Wire schema onto pages currently missing it:
- **`/contact`** → full `medicalClinicLd()` + `breadcrumbLd()` (primary local page).
- Breadcrumbs (`breadcrumbLd`) on `/about`, `/packages`, and `/all-services` index.

`AREAS_SERVED` (new `site.ts` const, owner-confirmable list of genuine nearby QC areas):
Project 8, Project 6, Bahay Toro, Veterans Village, Sangandaan, Balintawak, Mindanao Avenue,
Tandang Sora, Culiat, Baesa, Apolonio Samson, Congressional Avenue. Used by both the schema
`areaServed` and the on-page "Areas we serve" section (one source).

## Pillar C — enriched `/contact` location page

Rebuild `/contact` (server component) into the canonical location page. Sections:

1. **Heading** — "Visit DRMed Clinic & Laboratory in Quezon City".
2. **NAP block** — address (multi-line), mobile + landline `tel:` links, email, hours +
   reused **`OpenNowPill`** (now `HOURS`-driven).
3. **Map** — new **`MapEmbed.tsx`** client component: cookie-free styled placeholder
   (pin + "View interactive map" button) that swaps in the Google Maps `…&output=embed`
   iframe only on click. No API key; no Google cookies until the user opts in.
4. **Get directions** — buttons for Google Maps + Waze + Apple Maps (`directionsHrefs()`).
5. **How to find us** — 4/F Northridge Plaza, landmark context (off Congressional Ave,
   Project 8), parking note *(owner-confirm)*.
6. **Areas we serve** — render `AREAS_SERVED` + a "we also bring the lab to you" home-service
   note linking the home-service path.
7. **FAQ** — accordion of the confirmed Q&As (Pillar D), feeding `FAQPage` schema.
8. **CTAs** — "Book an appointment" → `/schedule`, "Call now" → `tel:`.

Reuse existing marketing component patterns (`home/Contact.tsx`, `OpenNowPill`). Mobile-first
(verify 390×844 + desktop). `/contact` stays in sitemap/nav unchanged (no route change).

## Pillar D — folded-in extras (approved)

- **`physicianLd` `specialtyLabels` fix** — latent bug: the function accepts the field but
  no caller passes it, so every doctor's schema drops secondary specialties. Select
  `group_label` (and any secondary specialty) in `physicians/[slug]/page.tsx` and pass it.
- **`/contact` FAQ + `FAQPage` schema** — see Pillar D FAQ content below.
- **Breadcrumbs** on `/about`, `/packages`, `/all-services` index (cheap rich-result win).
- (Pillar B already folds in `sameAs`→Maps, `ReserveAction`, Messenger contactPoint, Apple
  Maps link, `knowsLanguage`, `paymentAccepted`.)

### Pillar D — FAQ content (drafted from in-app facts)

Schema-ready now (facts already live on the site / in data):

- **Do I need an appointment, or can I walk in?** — Walk-ins are welcome; booking online is
  optional and just saves time. (booking always optional — confirmed.)
- **How soon are my results ready?** — Most tests within 24 hours; many same-day.
  (matches existing TRUST_BAR / HERO_STATS copy.)
- **Do you accept HMOs?** — Yes — we accept 10 major HMO providers; present your card or LOA
  at reception. (general; exact provider list = owner-confirm before naming names.)
- **Do you offer home service?** — Yes — home sample collection and a mobile clinic for
  groups/companies. (from SERVICE_HIGHLIGHTS — confirmed.)

Confirm-first (rendered + added to schema only after owner confirmation — NOT emitted with
guesses):

- **Is there parking?** — *owner-confirm.*
- **Do I need to fast before blood tests?** — standard guidance (8–12h for FBS/lipids);
  *clinical confirm before publishing as fact.*
- **Exact HMO provider list** — *owner-confirm.*

## Out of scope / explicitly skipped (with reason)

- Programmatic `[test]-in-[area]` pages — doorway-penalty risk for a single location.
- `aggregateRating` / review widgets — Feature 3; never fabricate.
- `department` sub-entities, `OfferCatalog`, holiday/special-hours schema, `hreflang`,
  per-page OG images, Speed Insights — low/zero ranking ROI or scope creep.
- `MedicalTest`/`MedicalProcedure` schema refactor on service pages — better medical markup,
  but it's Tier-1 service-page work, not local SEO; defer to its own pass.

## Non-code companion (optional deliverable, not blocking)

A ready-to-paste **NAP card** + a 4-column **citation tracking sheet** the owner can use for
the user-side tasks (Apple Business Connect, Bing Places, Waze, Facebook, Foursquare, PH
directories, HMO provider listings) and GBP depth (photos, Posts, Q&A, attributes, review
short-link). Generated on request — does not block the code.

## Testing

- **Unit (vitest, pure — no `server-only` imports):**
  - `nap.ts`: `addressOneLine/MultiLine`, `hoursLabel`, `telHref`, `directionsHrefs`,
    `isOpenNow` (boundary cases: 07:59 closed, 08:00 open, 16:59 open, 17:00 closed, Sunday
    closed) — computed in `Asia/Manila`.
  - `structured-data.ts`: `clinicNode` now includes `openingHoursSpecification`,
    `contactPoint[]` (both phones), expanded `areaServed`, `paymentAccepted`,
    `potentialAction`; `sameAs` includes the Maps URL; `physicianLd` carries
    `specialtyLabels`; `faqPageLd` shape for the confirmed FAQs.
- **Gate:** `npm run typecheck` + `npm run lint` (0 errors) + `npm test` + `npm run build`.
- **Manual smoke (optional):** Playwright `/contact` at 390×844 + desktop — map placeholder
  renders, click loads iframe, directions links resolve; validate emitted JSON-LD in Google
  Rich Results Test post-deploy.

## Guardrails & risks

- **No migration. No new route** (enriching `/contact`) → sitemap unchanged.
- Prices stay in the `services` table — the page links out to `/packages`/`/all-services`;
  no hardcoded prices.
- Marketing-only; no new trackers. Click-to-load map = no Google cookies until user opts in.
- `areaServed` + parking/wheelchair/HMO-list claims must be **truthful** → gated on
  owner-confirmation; ship only confirmed facts to schema.
- Risk: over-stuffed schema → keep additions to verifiable facts; validate in Rich Results
  Test before/after.

## Files touched (map)

**New:** `src/lib/marketing/nap.ts`, `src/lib/marketing/nap.test.ts`,
`src/components/marketing/MapEmbed.tsx` (+ a `/contact` FAQ component or inline accordion).
**Edited:** `src/lib/marketing/site.ts` (HOURS, AREAS_SERVED),
`src/lib/marketing/structured-data.ts` (+ `structured-data.test.ts`),
`src/app/(marketing)/contact/page.tsx` (rebuild),
`src/components/marketing/home/{Contact,HowItWorks,Hero,OpenNowPill}.tsx`,
`src/app/(marketing)/physicians/page.tsx`, `src/app/(marketing)/physicians/[slug]/page.tsx`
(specialtyLabels), `src/app/(marketing)/schedule/booking-form.tsx`,
`src/lib/notifications/branded-email.ts`, `src/app/(marketing)/about/page.tsx`,
`src/app/(marketing)/packages/page.tsx`, `src/app/(marketing)/all-services/page.tsx`
(breadcrumbs), and `src/app/(staff)/staff/(dashboard)/appointments/new-appointment-sheet.tsx`
(NAP literal).

## Owner-confirmation items (collect during/after build; do not block schema-ready work)

1. Parking availability/details.
2. Exact HMO provider names (to name them on the FAQ).
3. Fasting guidance wording (clinical sign-off).
4. `AREAS_SERVED` list — prune/confirm the nearby QC areas.
5. Wheelchair accessibility (for `amenityFeature`).
6. **Canonical business name — RESOLVED 2026-06-18:** standardized to **"DRMed Clinic and
   Laboratory"** (matches the verified Google pin). Applied across the codebase (`&`→`and` in
   `site.ts` + ~16 hardcoded literals; typecheck + 316 tests green). Remaining user action:
   rename the **Facebook** page ("drmedcliniclab") to match.
