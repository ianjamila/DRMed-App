# Local-SEO Enrichment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strengthen drmed.ph's local search + AI-answer presence via NAP single-source-of-truth, richer LocalBusiness/geo structured data, and a rebuilt `/contact` location page.

**Architecture:** A pure data layer (`site.ts`: `HOURS`, `AREAS_SERVED`, atomic address) feeds a pure derivation layer (`nap.ts`: formatted strings, map/`tel:` hrefs, `isOpenNow`) and a pure schema layer (`structured-data.ts`: enriched `MedicalClinic` node). Marketing components consume those layers instead of hardcoding NAP. `/contact` becomes the canonical single location page with a click-to-load map. No migration, no new route.

**Tech Stack:** Next.js 16 (App Router, Server Components), TypeScript strict, Tailwind v4 CSS-vars, lucide-react, vitest (pure-logic unit tests), schema.org JSON-LD.

**Spec:** `docs/superpowers/specs/2026-06-18-local-seo-enrichment-design.md`

**Pre-done in this branch:** clinic name standardized to "DRMed Clinic and Laboratory" (commit `68dde20`).

---

## Deviation from spec (decided during planning — flag for user)

The spec folded in a **`physicianLd` `specialtyLabels` fix**. On inspection the function *already*
handles `specialtyLabels` (and is unit-tested for it); the only un-passed data at the call site is
`group_label`, which is a **display grouping** ("Pediatric Specialists", fallback "Other
Specialists") — NOT a medical specialty. Passing it into `medicalSpecialty` would emit noise like
`["Pediatrics","Pediatric Specialists"]`. The other candidate, `bio`, is NULL for all physicians.
**Decision: do NOT change physician schema in this PR** (no real data to add; would degrade, not
improve, the markup). Documented here; revisit in a Tier-1 service/physician-schema pass when bios
and secondary specialties have real values. No task implements it.

---

## File Structure

**New files**
- `src/lib/marketing/nap.ts` — pure NAP derivations (address/hours strings, `tel:`/maps/Waze/Apple hrefs, map-embed src, `isOpenNow`). No `server-only`.
- `src/lib/marketing/nap.test.ts` — vitest unit tests for `nap.ts`.
- `src/components/marketing/map-embed.tsx` — `"use client"` click-to-load Google Maps embed.

**Modified files**
- `src/lib/marketing/site.ts` — add `HOURS`, `AREAS_SERVED`, `address.floor`; widen `hours` to "8:00 AM".
- `src/lib/marketing/structured-data.ts` — enrich `clinicNode()`.
- `src/lib/marketing/structured-data.test.ts` — assert the new clinic-node fields.
- `src/components/marketing/home/OpenNowPill.tsx` — derive open/closed from `nap.isOpenNow`.
- `src/components/marketing/home/Contact.tsx` — NAP via helpers.
- `src/components/marketing/home/HowItWorks.tsx` — NAP via constants.
- `src/app/(marketing)/physicians/page.tsx` — NAP via `CONTACT`/`nap`.
- `src/app/(marketing)/schedule/booking-form.tsx` — NAP via helpers (L1054/L1058).
- `src/lib/notifications/branded-email.ts` — kill the `"4/F "` magic string (L98).
- `src/app/(marketing)/contact/page.tsx` — **rebuilt** as the location page.
- `src/app/(marketing)/about/page.tsx`, `packages/page.tsx`, `all-services/page.tsx` — breadcrumb JSON-LD.

---

## Task 1: Add `HOURS`, `AREAS_SERVED`, atomic address `floor` to `site.ts`

**Files:**
- Modify: `src/lib/marketing/site.ts`

- [ ] **Step 1: Add `floor` to the address block**

In `CONTACT.address`, add a `floor` field (the "4/F" prefix used by the email footer, now single-sourced). Change the object so it reads:

```ts
  address: {
    floor: "4/F",
    line1: "4/F DRMed Clinic and Laboratory",
    line2: "Northridge Plaza, Congressional Avenue",
    city: "Quezon City",
    region: "Metro Manila",
    country: "PH",
    postalCode: "1106",
    full: "4/F DRMed Clinic and Laboratory, Northridge Plaza, Congressional Avenue, Quezon City",
  },
```

- [ ] **Step 2: Widen the `hours` display string to include minutes**

Change `hours` in `CONTACT` from `"Monday – Saturday, 8 AM – 5 PM"` to:

```ts
  hours: "Monday – Saturday, 8:00 AM – 5:00 PM",
```

- [ ] **Step 3: Add the `HOURS` structured constant**

After the `GEO` block (or directly after `CONTACT`), add:

```ts
// Structured opening hours — the single source for schema openingHoursSpecification
// and the OpenNowPill computation. Asia/Manila, no DST. lastRegistration is the
// reception cut-off shown on the booking form.
export const HOURS = {
  days: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
  opens: "08:00",
  closes: "17:00",
  lastRegistration: "16:30",
  timezone: "Asia/Manila",
} as const;
```

- [ ] **Step 4: Add the `AREAS_SERVED` constant**

Add (truthful nearby Quezon City areas — see spec owner-confirmation item #4):

```ts
// Genuine adjacent Quezon City areas the clinic serves (walk-in + home service).
// Used by both the areaServed schema and the /contact "Areas we serve" section.
// Owner-confirmable — prune to match reality.
export const AREAS_SERVED = [
  "Project 8", "Project 6", "Bahay Toro", "Veterans Village", "Sangandaan",
  "Balintawak", "Mindanao Avenue", "Tandang Sora", "Culiat", "Baesa",
  "Apolonio Samson", "Congressional Avenue",
] as const;
```

- [ ] **Step 5: Verify typecheck + existing tests still pass**

Run: `npm run typecheck && npm test`
Expected: tsc clean; 316 tests pass (no behavior change yet).

- [ ] **Step 6: Commit**

```bash
git add src/lib/marketing/site.ts
git commit -m "feat(seo): add HOURS, AREAS_SERVED, atomic address.floor to site.ts"
```

---

## Task 2: Create `nap.ts` pure helpers (TDD)

**Files:**
- Create: `src/lib/marketing/nap.ts`
- Test: `src/lib/marketing/nap.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/marketing/nap.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  to12h, hoursLabel, hoursWithLastRegistration, addressLines, streetAddressLine,
  telHref, directionsHrefs, mapEmbedSrc, isOpenNow,
} from "./nap";
import { CONTACT } from "./site";

describe("to12h", () => {
  it("formats 24h HH:mm as 12h with meridiem", () => {
    expect(to12h("08:00")).toBe("8:00 AM");
    expect(to12h("16:30")).toBe("4:30 PM");
    expect(to12h("17:00")).toBe("5:00 PM");
    expect(to12h("00:00")).toBe("12:00 AM");
    expect(to12h("12:00")).toBe("12:00 PM");
  });
});

describe("hours strings", () => {
  it("hoursLabel matches the canonical CONTACT.hours", () => {
    expect(hoursLabel()).toBe(CONTACT.hours);
    expect(hoursLabel()).toContain("8:00 AM");
  });
  it("hoursWithLastRegistration appends the reception cut-off", () => {
    expect(hoursWithLastRegistration()).toBe(
      "Monday – Saturday, 8:00 AM – 5:00 PM (last registration 4:30 PM)",
    );
  });
});

describe("address helpers", () => {
  it("addressLines returns [occupant line, street+city line]", () => {
    const [top, bottom] = addressLines();
    expect(top).toBe("4/F DRMed Clinic and Laboratory");
    expect(bottom).toBe("Northridge Plaza, Congressional Avenue, Quezon City");
  });
  it("streetAddressLine is the name-less mailing line with the floor", () => {
    expect(streetAddressLine()).toBe(
      "4/F Northridge Plaza, Congressional Avenue, Quezon City",
    );
  });
});

describe("hrefs", () => {
  it("telHref builds tel: links from E164 numbers", () => {
    expect(telHref("mobile")).toBe("tel:+639166043208");
    expect(telHref("landline")).toBe("tel:+63283553517");
  });
  it("directionsHrefs returns google/waze/apple deep links", () => {
    const d = directionsHrefs();
    expect(d.google).toMatch(/^https?:\/\//);
    expect(d.waze).toContain("waze.com");
    expect(d.apple).toContain("maps.apple.com");
  });
  it("mapEmbedSrc is a cookie-free output=embed url", () => {
    expect(mapEmbedSrc()).toContain("output=embed");
  });
});

describe("isOpenNow (Asia/Manila, Mon–Sat 08:00–17:00)", () => {
  it("open during business hours on a weekday", () => {
    // 2026-06-18 is a Thursday. 01:00Z = 09:00 Manila.
    expect(isOpenNow(new Date("2026-06-18T01:00:00Z"))).toBe(true);
    // 00:30Z = 08:30 Manila (just opened)
    expect(isOpenNow(new Date("2026-06-18T00:30:00Z"))).toBe(true);
  });
  it("closed before opening and after closing", () => {
    // 23:30Z Wed = 07:30 Manila Thu (before open)
    expect(isOpenNow(new Date("2026-06-17T23:30:00Z"))).toBe(false);
    // 09:30Z = 17:30 Manila (after close)
    expect(isOpenNow(new Date("2026-06-18T09:30:00Z"))).toBe(false);
  });
  it("closed all day Sunday", () => {
    // 2026-06-21 is a Sunday. 03:00Z = 11:00 Manila Sun.
    expect(isOpenNow(new Date("2026-06-21T03:00:00Z"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/marketing/nap.test.ts`
Expected: FAIL — "Failed to resolve import ./nap".

- [ ] **Step 3: Implement `nap.ts`**

Create `src/lib/marketing/nap.ts`:

```ts
// Pure NAP (name/address/phone) derivations. Single source for the formatted
// strings + map/tel hrefs used across the marketing site, so address/phone/hours
// only ever change in site.ts. No `server-only` — unit-tested.

import { CONTACT, HOURS, GEO, SITE } from "./site";

/** "08:00" -> "8:00 AM", "16:30" -> "4:30 PM". */
export function to12h(hhmm: string): string {
  const [h, m] = hhmm.split(":").map((n) => parseInt(n, 10));
  const mer = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${mer}`;
}

/** Canonical clinic-hours display string. */
export function hoursLabel(): string {
  return CONTACT.hours;
}

/** Hours + the reception cut-off, for the booking form. */
export function hoursWithLastRegistration(): string {
  return `${CONTACT.hours} (last registration ${to12h(HOURS.lastRegistration)})`;
}

/** Two-line address block: [occupant line, "street, city"]. */
export function addressLines(): [string, string] {
  return [CONTACT.address.line1, `${CONTACT.address.line2}, ${CONTACT.address.city}`];
}

/** Name-less mailing line with floor — for places that show the clinic name separately. */
export function streetAddressLine(): string {
  return `${CONTACT.address.floor} ${CONTACT.address.line2}, ${CONTACT.address.city}`;
}

/** tel: link from the E164 numbers. */
export function telHref(which: "mobile" | "landline"): string {
  return `tel:${which === "mobile" ? CONTACT.phone.mobileE164 : CONTACT.phone.landlineE164}`;
}

function latLng(): string | null {
  return GEO.lat != null && GEO.lng != null ? `${GEO.lat},${GEO.lng}` : null;
}

/** Google / Waze / Apple directions deep links. Prefers the verified pin/coords. */
export function directionsHrefs(): { google: string; waze: string; apple: string } {
  const q = encodeURIComponent(CONTACT.address.full);
  const ll = latLng();
  return {
    google: GEO.mapUrl || `https://www.google.com/maps/search/?api=1&query=${q}`,
    waze: ll ? `https://waze.com/ul?ll=${ll}&navigate=yes` : `https://waze.com/ul?q=${q}`,
    apple: ll
      ? `https://maps.apple.com/?ll=${ll}&q=${encodeURIComponent(SITE.name)}`
      : `https://maps.apple.com/?q=${q}`,
  };
}

/** Cookie-free Google Maps iframe src — loaded only on user click (see MapEmbed). */
export function mapEmbedSrc(): string {
  const target = latLng() ?? CONTACT.address.full;
  return `https://maps.google.com/maps?q=${encodeURIComponent(target)}&z=16&output=embed`;
}

/** Is the clinic open at `now`? Computed in Asia/Manila from HOURS. Pure (date passed in). */
export function isOpenNow(now: Date): boolean {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: HOURS.timezone,
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const weekday = parts.find((p) => p.type === "weekday")?.value ?? "";
  const hour = parseInt(parts.find((p) => p.type === "hour")?.value ?? "0", 10);
  const minute = parseInt(parts.find((p) => p.type === "minute")?.value ?? "0", 10);
  const open = parseInt(HOURS.opens.split(":")[0], 10) * 60 + parseInt(HOURS.opens.split(":")[1], 10);
  const close = parseInt(HOURS.closes.split(":")[0], 10) * 60 + parseInt(HOURS.closes.split(":")[1], 10);
  const mins = hour * 60 + minute;
  return (HOURS.days as readonly string[]).includes(weekday) && mins >= open && mins < close;
}
```

> Note: `Intl.DateTimeFormat` `hour: "2-digit"` with `hour12:false` can emit `"24"` at midnight in some runtimes; the boundary tests above (08:30/07:30/17:30) avoid that edge, and clinic hours never touch midnight.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/marketing/nap.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/marketing/nap.ts src/lib/marketing/nap.test.ts
git commit -m "feat(seo): nap.ts NAP/hours/directions helpers + isOpenNow (tested)"
```

---

## Task 3: Enrich `clinicNode()` structured data (TDD)

**Files:**
- Modify: `src/lib/marketing/structured-data.ts:23-49` (the `clinicNode` function)
- Test: `src/lib/marketing/structured-data.test.ts`

- [ ] **Step 1: Add failing assertions to the existing test**

In `src/lib/marketing/structured-data.test.ts`, inside `describe("medicalClinicLd", ...)`, add a new `it` block after the existing geo test (before the closing `});` of the describe):

```ts
  it("is a complete local entity: hours spec, both phones, areas, payments, languages, reserve action, maps sameAs", () => {
    const ld = medicalClinicLd();
    // openingHoursSpecification (structured), in addition to the openingHours string
    const ohs = ld.openingHoursSpecification as Record<string, unknown>;
    expect(ohs["@type"]).toBe("OpeningHoursSpecification");
    expect(ohs.opens).toBe("08:00");
    expect(ohs.closes).toBe("17:00");
    expect(ohs.dayOfWeek).toContain("Saturday");
    expect(ohs.dayOfWeek).not.toContain("Sunday");
    // contactPoint carries BOTH phones
    const cps = ld.contactPoint as Array<Record<string, unknown>>;
    expect(cps).toHaveLength(2);
    const tels = cps.map((c) => c.telephone);
    expect(tels).toContain("+639166043208");
    expect(tels).toContain("+63283553517");
    // areaServed expanded beyond just QC + Metro Manila
    expect((ld.areaServed as unknown[]).length).toBeGreaterThan(2);
    // payments + currency + languages
    expect(ld.paymentAccepted).toContain("HMO");
    expect(ld.currenciesAccepted).toBe("PHP");
    expect(ld.knowsLanguage).toContain("fil");
    // image is an array of place photos
    expect(Array.isArray(ld.image)).toBe(true);
    // sameAs includes the Google Maps place URL + Messenger
    expect(ld.sameAs).toContain("https://maps.app.goo.gl/Qrb5WYwmA5RVuBkN9");
    expect(ld.sameAs).toContain("https://m.me/drmed.ph");
    // ReserveAction -> /schedule
    const action = ld.potentialAction as Record<string, unknown>;
    expect(action["@type"]).toBe("ReserveAction");
    expect((action.target as Record<string, unknown>).urlTemplate).toBe(`${SITE.url}/schedule`);
  });
```

- [ ] **Step 2: Run to verify the new assertions fail**

Run: `npx vitest run src/lib/marketing/structured-data.test.ts`
Expected: FAIL — `openingHoursSpecification`/`contactPoint`/etc. are undefined.

- [ ] **Step 3: Update imports + `clinicNode()`**

In `src/lib/marketing/structured-data.ts`, change the top import (line 1) to also pull `HOURS`, `AREAS_SERVED`:

```ts
import { SITE, CONTACT, SOCIAL, GEO, HOURS, AREAS_SERVED } from "./site";
```

Replace the `clinicNode()` function body (currently lines ~23-49) with:

```ts
function clinicNode(): SchemaObject {
  const node: SchemaObject = {
    "@type": "MedicalClinic",
    "@id": CLINIC_ID,
    name: SITE.name,
    url: SITE.url,
    logo: `${SITE.url}${SITE.logo}`,
    image: [
      `${SITE.url}${SITE.ogImage}`,
      `${SITE.url}/photos/reception.jpg`,
      `${SITE.url}/photos/lab-chemistry.jpg`,
      `${SITE.url}/photos/waiting-area.jpg`,
    ],
    description: SITE.description,
    email: CONTACT.email,
    telephone: CONTACT.phone.mobileE164,
    priceRange: SITE.priceRange,
    currenciesAccepted: "PHP",
    paymentAccepted: "Cash, GCash, Maya, Credit Card, HMO",
    knowsLanguage: ["en", "fil"],
    address: postalAddress(),
    areaServed: [
      { "@type": "City", name: "Quezon City" },
      { "@type": "AdministrativeArea", name: "Metro Manila" },
      ...AREAS_SERVED.map((a) => ({ "@type": "Place", name: `${a}, Quezon City` })),
    ],
    contactPoint: [
      {
        "@type": "ContactPoint",
        telephone: CONTACT.phone.mobileE164,
        contactType: "customer service",
        areaServed: "PH",
        availableLanguage: ["en", "fil"],
      },
      {
        "@type": "ContactPoint",
        telephone: CONTACT.phone.landlineE164,
        contactType: "reservations",
        areaServed: "PH",
        availableLanguage: ["en", "fil"],
      },
    ],
    openingHours: "Mo-Sa 08:00-17:00",
    openingHoursSpecification: {
      "@type": "OpeningHoursSpecification",
      dayOfWeek: [...HOURS.days],
      opens: HOURS.opens,
      closes: HOURS.closes,
    },
    medicalSpecialty: ["Diagnostic", "ClinicalLaboratory", "Radiology"],
    sameAs: [SOCIAL.facebook, SOCIAL.instagram, SOCIAL.messenger, GEO.mapUrl].filter(Boolean),
    potentialAction: {
      "@type": "ReserveAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${SITE.url}/schedule`,
        actionPlatform: [
          "http://schema.org/DesktopWebPlatform",
          "http://schema.org/MobileWebPlatform",
        ],
      },
      result: { "@type": "Reservation", name: "Clinic or laboratory appointment" },
    },
  };
  if (GEO.lat != null && GEO.lng != null) {
    node.geo = { "@type": "GeoCoordinates", latitude: GEO.lat, longitude: GEO.lng };
    if (GEO.mapUrl) node.hasMap = GEO.mapUrl;
  }
  return node;
}
```

> `amenityFeature` (wheelchair/parking) is intentionally NOT emitted — unconfirmed (spec owner-confirmation items #1/#5). Add it later only once the facts are confirmed.

- [ ] **Step 4: Run the full structured-data test**

Run: `npx vitest run src/lib/marketing/structured-data.test.ts`
Expected: PASS — including the existing `worksFor`/`provider` embed tests (image is still truthy as an array).

- [ ] **Step 5: Commit**

```bash
git add src/lib/marketing/structured-data.ts src/lib/marketing/structured-data.test.ts
git commit -m "feat(seo): enrich MedicalClinic node (hours spec, contactPoints, areas, payments, ReserveAction, maps sameAs)"
```

---

## Task 4: Consolidate hardcoded NAP in shared components

No new tests (covered by `nap.test.ts` + typecheck/build). Each step is an exact edit.

**Files:**
- Modify: `src/components/marketing/home/OpenNowPill.tsx`
- Modify: `src/components/marketing/home/Contact.tsx`
- Modify: `src/components/marketing/home/HowItWorks.tsx`
- Modify: `src/app/(marketing)/physicians/page.tsx`
- Modify: `src/app/(marketing)/schedule/booking-form.tsx`
- Modify: `src/lib/notifications/branded-email.ts`

- [ ] **Step 1: `OpenNowPill.tsx` — derive open/closed from `nap.isOpenNow`**

Replace the `useEffect` body (lines 16-38) so the Manila-time math comes from `nap`:

```tsx
  useEffect(() => {
    // One-shot after mount to avoid hydration mismatch (Manila time is client-only).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setStatus(isOpenNow(new Date()) ? "open" : "closed");
  }, []);
```

Add the import at the top (after the React import):

```tsx
import { isOpenNow } from "@/lib/marketing/nap";
```

- [ ] **Step 2: `Contact.tsx` (home) — address, hours, maps href via helpers**

Replace the local `mapsHref` const (line 11) with an import-based value. Change the import line 9 and the const line 11:

```tsx
import { CONTACT, SOCIAL } from "@/lib/marketing/site";
import { addressLines, hoursLabel, directionsHrefs } from "@/lib/marketing/nap";

const mapsHref = directionsHrefs().google;
const [addrTop, addrBottom] = addressLines();
```

Replace the hardcoded address (lines 74-77):

```tsx
                  <p className="mt-1 text-[14.5px] leading-relaxed text-white/[.82]">
                    {addrTop}
                    <br />
                    {addrBottom}
                  </p>
```

Replace the hardcoded hours line (line 102):

```tsx
                    {hoursLabel()}
                    <OpenNowPill />
```

- [ ] **Step 3: `HowItWorks.tsx` — address + hours via constants**

Add an import:

```tsx
import { CONTACT } from "@/lib/marketing/site";
import { streetAddressLine } from "@/lib/marketing/nap";
```

Change step 02 `body` (line 23) to interpolate the address (keep the rest of the sentence):

```ts
    body: `${CONTACT.address.line2}, ${CONTACT.address.city}. Present your ID and HMO card — our staff handles the rest.`,
```

> (Step 01's "Monday to Saturday" stays as natural prose — it's not structured NAP data and reads fine; no change.)

- [ ] **Step 4: `physicians/page.tsx` — meta strip + schedule-change phones via `CONTACT`**

Add imports (after line 13):

```tsx
import { CONTACT } from "@/lib/marketing/site";
```

Replace the hardcoded location (line 107):

```tsx
              {CONTACT.address.line2.split(",")[0]} · {CONTACT.address.city}
```

Replace the two hardcoded phone anchors (lines 136-148) so href + text come from `CONTACT`:

```tsx
              <a
                href={`tel:${CONTACT.phone.mobileE164}`}
                className="font-bold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan-text)]"
              >
                {CONTACT.phone.mobile}
              </a>{" "}
              or{" "}
              <a
                href={`tel:${CONTACT.phone.landlineE164}`}
                className="font-bold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan-text)]"
              >
                {CONTACT.phone.landline}
              </a>{" "}
```

> This also fixes a real NAP bug: the page previously showed the landline as `8355 3517`, inconsistent with the canonical `(02) 8 355 3517`.

- [ ] **Step 5: `schedule/booking-form.tsx` — hours + address via helpers (L1054/L1058)**

Read the two lines first to get exact surrounding text:

Run: `sed -n '1050,1060p' "src/app/(marketing)/schedule/booking-form.tsx"`

Add (or extend) the imports near the top of the file:

```tsx
import { hoursWithLastRegistration, streetAddressLine } from "@/lib/marketing/nap";
```

Replace the hardcoded hours string (the `"Monday – Saturday, 8:00 AM – 5:00 PM (last registration 4:30 PM)."` literal at ~L1054) with `{hoursWithLastRegistration()}.` and the hardcoded address (`"4/F Northridge Plaza, Congressional Avenue, Quezon City."` at ~L1058) with `{streetAddressLine()}.` — preserving the surrounding JSX/punctuation shown by the `sed` output.

- [ ] **Step 6: `branded-email.ts` — kill the `"4/F "` magic string (L98)**

Add the import (after line 12):

```ts
import { streetAddressLine } from "@/lib/marketing/nap";
```

Replace line 98:

```ts
  const address = streetAddressLine();
```

- [ ] **Step 7: Verify the swap is complete + green**

Run:
```bash
grep -rn "Northridge\|Congressional\|0916 604\|355 3517\|8 AM\|8:00 AM – 5:00 PM" src --include=*.tsx --include=*.ts | grep -v "site.ts\|/nap.ts\|\.test\."
npm run typecheck && npm test && npm run lint
```
Expected: the grep returns only intentional prose (e.g. About-page mission copy), NOT NAP data in the touched files; tsc clean; 322 tests pass (316 + 6 new from Tasks 2-3); lint 0 errors.

- [ ] **Step 8: Commit**

```bash
git add src/components/marketing/home/OpenNowPill.tsx src/components/marketing/home/Contact.tsx src/components/marketing/home/HowItWorks.tsx "src/app/(marketing)/physicians/page.tsx" "src/app/(marketing)/schedule/booking-form.tsx" src/lib/notifications/branded-email.ts
git commit -m "refactor(seo): consume nap helpers instead of hardcoded NAP across marketing components"
```

---

## Task 5: Click-to-load `MapEmbed` component

**Files:**
- Create: `src/components/marketing/map-embed.tsx`

- [ ] **Step 1: Implement the component**

Create `src/components/marketing/map-embed.tsx`:

```tsx
"use client";

import { useState } from "react";
import { MapPin } from "lucide-react";

/**
 * Privacy-respecting map: shows a static styled placeholder; the Google Maps
 * iframe (which sets Google cookies) loads only after the user clicks. No API
 * key — uses the cookie-free `output=embed` URL from nap.mapEmbedSrc().
 */
export function MapEmbed({ src, title }: { src: string; title: string }) {
  const [loaded, setLoaded] = useState(false);

  if (loaded) {
    return (
      <iframe
        src={src}
        title={title}
        loading="lazy"
        referrerPolicy="no-referrer-when-downgrade"
        className="h-[360px] w-full rounded-[20px] border border-[color:var(--color-warm-line-soft)]"
        allowFullScreen
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setLoaded(true)}
      className="group relative flex h-[360px] w-full items-center justify-center overflow-hidden rounded-[20px] border border-[color:var(--color-warm-line-soft)] bg-[color:var(--color-warm-bg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-cyan)]"
      aria-label={`Load interactive map: ${title}`}
    >
      {/* Subtle map-ish grid backdrop */}
      <span
        aria-hidden="true"
        className="absolute inset-0 opacity-[0.5] [background:linear-gradient(0deg,transparent_24px,rgba(8,168,226,0.10)_25px),linear-gradient(90deg,transparent_24px,rgba(8,168,226,0.10)_25px)] [background-size:25px_25px]"
      />
      <span className="relative z-10 flex flex-col items-center gap-2 text-[color:var(--color-brand-navy)]">
        <span className="grid h-12 w-12 place-items-center rounded-full bg-white shadow-[var(--shadow-warm-sm)]">
          <MapPin className="h-6 w-6 text-[color:var(--color-brand-cyan)]" aria-hidden="true" />
        </span>
        <span className="text-sm font-bold">View interactive map</span>
        <span className="text-xs text-[color:var(--color-ink-soft)]">
          Loads Google Maps · no tracking until you click
        </span>
      </span>
    </button>
  );
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: tsc clean.

- [ ] **Step 3: Commit**

```bash
git add src/components/marketing/map-embed.tsx
git commit -m "feat(seo): click-to-load MapEmbed (no Google cookies until user opts in)"
```

---

## Task 6: Rebuild `/contact` as the canonical location page

**Files:**
- Modify (full rewrite): `src/app/(marketing)/contact/page.tsx`

- [ ] **Step 1: Replace the page with the location-page build**

Overwrite `src/app/(marketing)/contact/page.tsx` with:

```tsx
import { MapPin, Clock, Phone, Mail, Navigation, Car, HelpCircle, ExternalLink } from "lucide-react";
import { PageHero } from "@/components/marketing/page-hero";
import { SectionHeading, PillLink } from "@/components/marketing/ui";
import { Reveal } from "@/components/marketing/motion";
import { CONTACT, SOCIAL, AREAS_SERVED } from "@/lib/marketing/site";
import { addressLines, hoursLabel, telHref, directionsHrefs, mapEmbedSrc } from "@/lib/marketing/nap";
import { ContactForm } from "./contact-form";
import { MapEmbed } from "@/components/marketing/map-embed";
import { OpenNowPill } from "@/components/marketing/home/OpenNowPill";
import { JsonLd } from "@/components/marketing/json-ld";
import { medicalClinicLd, breadcrumbLd, faqPageLd } from "@/lib/marketing/structured-data";
import { pageMetadata } from "@/lib/marketing/metadata";
import type { FaqItem } from "@/lib/marketing/faq";

export const metadata = pageMetadata({
  title: "Contact & Location",
  description:
    "Visit DRMed Clinic and Laboratory in Quezon City — address, directions, map, phone, and clinic hours. Open Monday to Saturday, 8:00 AM–5:00 PM.",
  path: "/contact",
});

// Confirmed facts only (already true on the site). Parking, exact HMO list, and
// fasting guidance are owner-confirm (spec) — add them here once confirmed so they
// also flow into FAQPage schema. Do NOT publish unconfirmed answers.
const FAQS: FaqItem[] = [
  {
    question: "Do I need an appointment, or can I walk in?",
    answer:
      "Walk-ins are welcome for packages and most lab tests. Booking online is optional and simply saves you time at reception.",
  },
  {
    question: "How soon are my results ready?",
    answer:
      "Most tests are ready within 24 hours, and many are released the same day. You can view and download released results anytime through the patient portal.",
  },
  {
    question: "Do you accept HMOs?",
    answer:
      "Yes — we accept 10 major HMO providers. Present your HMO card or letter of authorization (LOA) at reception.",
  },
  {
    question: "Do you offer home service?",
    answer:
      "Yes — we offer home sample collection and a mobile clinic for groups and companies. Contact us to arrange a visit.",
  },
];

const dir = directionsHrefs();

function DetailRow({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-[14px]">
      <span
        className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[rgba(8,168,226,0.10)] text-[color:var(--color-brand-cyan)]"
        aria-hidden="true"
      >
        {icon}
      </span>
      <div>
        <p className="text-[11px] font-bold uppercase tracking-[0.12em] text-[color:var(--color-brand-cyan-text)]">
          {label}
        </p>
        {children}
      </div>
    </div>
  );
}

export default function ContactPage() {
  const [addrTop, addrBottom] = addressLines();

  return (
    <>
      <JsonLd
        data={[
          medicalClinicLd(),
          breadcrumbLd([
            { name: "Home", path: "/" },
            { name: "Contact & Location", path: "/contact" },
          ]),
          faqPageLd(FAQS),
        ]}
      />

      <PageHero
        eyebrow="Visit Us"
        title="Find DRMed in Quezon City."
        description="Address, directions, clinic hours, and a quick way to reach us. Walk in during operating hours or send a message to book ahead."
      />

      {/* Details + form */}
      <section className="py-16 sm:py-20">
        <div className="mx-auto grid max-w-7xl gap-12 px-4 sm:px-6 lg:px-8 md:grid-cols-2">
          <Reveal>
            <div>
              <SectionHeading eyebrow="Visit, call, or email" title="We are easy" accent="to find." />
              <div className="mt-8 space-y-6">
                <DetailRow icon={<MapPin className="h-5 w-5" />} label="Address">
                  <p className="mt-1 text-[14.5px] leading-relaxed text-[color:var(--color-ink-mid)]">
                    {addrTop}
                    <br />
                    {addrBottom}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <a href={dir.google} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-full bg-[rgba(8,168,226,0.10)] px-3 py-1 text-[12px] font-bold text-[color:var(--color-brand-cyan-text)] hover:bg-[rgba(8,168,226,0.18)]">
                      <Navigation className="h-3.5 w-3.5" aria-hidden="true" /> Google Maps
                    </a>
                    <a href={dir.waze} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-full bg-[rgba(8,168,226,0.10)] px-3 py-1 text-[12px] font-bold text-[color:var(--color-brand-cyan-text)] hover:bg-[rgba(8,168,226,0.18)]">
                      <Navigation className="h-3.5 w-3.5" aria-hidden="true" /> Waze
                    </a>
                    <a href={dir.apple} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 rounded-full bg-[rgba(8,168,226,0.10)] px-3 py-1 text-[12px] font-bold text-[color:var(--color-brand-cyan-text)] hover:bg-[rgba(8,168,226,0.18)]">
                      <Navigation className="h-3.5 w-3.5" aria-hidden="true" /> Apple Maps
                    </a>
                  </div>
                </DetailRow>

                <DetailRow icon={<Clock className="h-5 w-5" />} label="Clinic Hours">
                  <p className="mt-1 text-[14.5px] leading-relaxed text-[color:var(--color-ink-mid)]">
                    {hoursLabel()}
                    <OpenNowPill />
                  </p>
                </DetailRow>

                <DetailRow icon={<Phone className="h-5 w-5" />} label="Phone">
                  <p className="mt-1 text-[14.5px] leading-relaxed">
                    <a href={telHref("mobile")} className="text-[color:var(--color-ink-mid)] hover:text-[color:var(--color-brand-navy)]">
                      {CONTACT.phone.mobile}
                    </a>
                    {" · "}
                    <a href={telHref("landline")} className="text-[color:var(--color-ink-mid)] hover:text-[color:var(--color-brand-navy)]">
                      {CONTACT.phone.landline}
                    </a>
                  </p>
                </DetailRow>

                <DetailRow icon={<Mail className="h-5 w-5" />} label="Email">
                  <p className="mt-1 text-[14.5px] leading-relaxed">
                    <a href={`mailto:${CONTACT.email}`} className="text-[color:var(--color-ink-mid)] hover:text-[color:var(--color-brand-navy)]">
                      {CONTACT.email}
                    </a>
                  </p>
                </DetailRow>

                <DetailRow icon={<ExternalLink className="h-5 w-5" />} label="Connect With Us">
                  <div className="mt-1 flex items-center gap-[14px] text-[14.5px]">
                    <a href={SOCIAL.facebook} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-[7px] text-[color:var(--color-ink-mid)] hover:text-[color:var(--color-brand-navy)]" aria-label="DRMed on Facebook (opens in new tab)">
                      <ExternalLink className="h-4 w-4" aria-hidden="true" /> Facebook
                    </a>
                    <a href={SOCIAL.instagram} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-[7px] text-[color:var(--color-ink-mid)] hover:text-[color:var(--color-brand-navy)]" aria-label="DRMed on Instagram (opens in new tab)">
                      <ExternalLink className="h-4 w-4" aria-hidden="true" /> Instagram
                    </a>
                    <a href={SOCIAL.messenger} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-[7px] text-[color:var(--color-ink-mid)] hover:text-[color:var(--color-brand-navy)]" aria-label="DRMed on Messenger (opens in new tab)">
                      <ExternalLink className="h-4 w-4" aria-hidden="true" /> Messenger
                    </a>
                  </div>
                </DetailRow>
              </div>
            </div>
          </Reveal>

          <Reveal delay={0.1}>
            <div className="rounded-[24px] border border-[color:var(--color-warm-line-soft)] bg-white p-8 shadow-[var(--shadow-warm-sm)]">
              <SectionHeading eyebrow="Inquire / Book" title="Send us a message." />
              <p className="mt-1.5 mb-6 text-[13px] text-[color:var(--color-ink-soft)]">
                For appointments, corporate packages, or general inquiries.
              </p>
              <ContactForm />
            </div>
          </Reveal>
        </div>
      </section>

      {/* Map + how to find us */}
      <section className="bg-[color:var(--color-warm-bg)] py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <SectionHeading eyebrow="Getting Here" title="How to" accent="find us." className="mb-8" />
          <div className="grid gap-8 lg:grid-cols-2">
            <Reveal>
              <MapEmbed src={mapEmbedSrc()} title="DRMed Clinic and Laboratory, Quezon City" />
            </Reveal>
            <Reveal delay={0.08}>
              <div className="space-y-5">
                <DetailRow icon={<MapPin className="h-5 w-5" />} label="Landmark">
                  <p className="mt-1 text-[14.5px] leading-relaxed text-[color:var(--color-ink-mid)]">
                    We are on the 4th floor of Northridge Plaza along Congressional Avenue, Project 8,
                    Quezon City. Look for the building entrance and take the lift to the 4th floor.
                  </p>
                </DetailRow>
                <DetailRow icon={<Car className="h-5 w-5" />} label="Parking & Transit">
                  {/* OWNER-CONFIRM (spec item #1): replace with exact parking + jeepney/bus details. */}
                  <p className="mt-1 text-[14.5px] leading-relaxed text-[color:var(--color-ink-mid)]">
                    Accessible via Congressional Avenue, with public-transport routes along the avenue.
                    Call us if you need directions for your specific route.
                  </p>
                </DetailRow>
                <PillLink href={dir.google} variant="navy" size="md">
                  Get directions <Navigation className="h-4 w-4" aria-hidden="true" />
                </PillLink>
              </div>
            </Reveal>
          </div>
        </div>
      </section>

      {/* Areas served */}
      <section className="py-16 sm:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <SectionHeading eyebrow="Service Area" title="Serving Quezon City" accent="and nearby areas." className="mb-6" />
          <p className="max-w-2xl text-[14.5px] leading-relaxed text-[color:var(--color-ink-mid)]">
            Patients visit us from across Quezon City. We also bring the lab to you with home sample
            collection and a mobile clinic for groups and companies.
          </p>
          <div className="mt-6 flex flex-wrap gap-2">
            {AREAS_SERVED.map((area) => (
              <span key={area} className="rounded-full border border-[color:var(--color-warm-line-soft)] bg-white px-3 py-1 text-[13px] text-[color:var(--color-ink-mid)] shadow-[var(--shadow-warm-sm)]">
                {area}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="bg-[color:var(--color-warm-sand)] py-16 sm:py-20">
        <div className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8">
          <SectionHeading eyebrow="Good to Know" title="Frequently asked" accent="questions." className="mb-8" />
          <div className="space-y-3">
            {FAQS.map((f) => (
              <details key={f.question} className="group rounded-[16px] border border-[color:var(--color-warm-line-soft)] bg-white px-5 py-4 shadow-[var(--shadow-warm-sm)]">
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 text-[15px] font-bold text-[color:var(--color-brand-navy)]">
                  <span className="flex items-center gap-2.5">
                    <HelpCircle className="h-4 w-4 shrink-0 text-[color:var(--color-brand-cyan)]" aria-hidden="true" />
                    {f.question}
                  </span>
                  <span className="shrink-0 text-[color:var(--color-brand-cyan)] transition-transform group-open:rotate-45" aria-hidden="true">+</span>
                </summary>
                <p className="mt-3 text-[14px] leading-relaxed text-[color:var(--color-ink-mid)]">{f.answer}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* CTA band */}
      <section className="bg-[color:var(--color-brand-navy)] py-14 text-white">
        <div className="mx-auto flex max-w-7xl flex-col items-start gap-4 px-4 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <div>
            <h2 className="font-[family-name:var(--font-display)] text-2xl font-normal">Ready to visit?</h2>
            <p className="mt-1 text-sm text-white/75">Book ahead online or just walk in during clinic hours.</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <PillLink href="/schedule" variant="cyan" size="md">Book an appointment</PillLink>
            <PillLink href={telHref("mobile")} variant="lineOnDark" size="md">Call now</PillLink>
          </div>
        </div>
      </section>
    </>
  );
}
```

- [ ] **Step 2: Verify build + types**

Run: `npm run typecheck && npm run lint && npm run build`
Expected: tsc clean; lint 0 errors; build succeeds (the `/contact` route compiles; `MapEmbed` is the only client island).

- [ ] **Step 3: Commit**

```bash
git add "src/app/(marketing)/contact/page.tsx"
git commit -m "feat(seo): rebuild /contact as the canonical location page (map, directions, areas, FAQ, LocalBusiness JSON-LD)"
```

---

## Task 7: Breadcrumb JSON-LD on `/about`, `/packages`, `/all-services` index

**Files:**
- Modify: `src/app/(marketing)/about/page.tsx`
- Modify: `src/app/(marketing)/packages/page.tsx`
- Modify: `src/app/(marketing)/all-services/page.tsx`

- [ ] **Step 1: `/about` — add the breadcrumb**

Add imports (after the existing `pageMetadata` import, line 5):

```tsx
import { JsonLd } from "@/components/marketing/json-ld";
import { breadcrumbLd } from "@/lib/marketing/structured-data";
```

Immediately inside the returned fragment (right after `<>` at the start of `AboutPage`'s return, line 43), add:

```tsx
      <JsonLd data={breadcrumbLd([{ name: "Home", path: "/" }, { name: "About", path: "/about" }])} />
```

- [ ] **Step 2: `/packages` — add the breadcrumb**

Read the file's return opener first:

Run: `grep -n "export default function\|return (\|<>" "src/app/(marketing)/packages/page.tsx" | head`

Add the same two imports (after its `pageMetadata` import). Insert, right after the opening `<>` of the default export's return:

```tsx
      <JsonLd data={breadcrumbLd([{ name: "Home", path: "/" }, { name: "Packages", path: "/packages" }])} />
```

- [ ] **Step 3: `/all-services` index — add the breadcrumb**

Read the file's return opener first:

Run: `grep -n "export default function\|return (\|<>" "src/app/(marketing)/all-services/page.tsx" | head`

Add the same two imports. Insert, right after the opening `<>` of the default export's return:

```tsx
      <JsonLd data={breadcrumbLd([{ name: "Home", path: "/" }, { name: "All Services", path: "/all-services" }])} />
```

> If a page's default export returns a single element rather than a fragment, wrap it in `<>…</>` so the `<JsonLd>` can sit alongside it.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint`
Expected: tsc clean; lint 0 errors.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(marketing)/about/page.tsx" "src/app/(marketing)/packages/page.tsx" "src/app/(marketing)/all-services/page.tsx"
git commit -m "feat(seo): breadcrumb JSON-LD on /about, /packages, /all-services"
```

---

## Task 8: Full gate + optional smoke

**Files:** none (verification)

- [ ] **Step 1: Run the full gate**

Run: `npm run typecheck && npm run lint && npm test && npm run build`
Expected: tsc clean; lint 0 errors; **322 tests pass** (316 baseline + 6 new); build succeeds.

- [ ] **Step 2 (optional): Playwright smoke of `/contact`**

If a dev server is available, load `/contact` at 390×844 and desktop: confirm the map placeholder renders, clicking it swaps in the iframe, directions links resolve, the FAQ `<details>` expand, and `OpenNowPill` shows. Validate the emitted JSON-LD with Google's Rich Results Test post-deploy (MedicalClinic + BreadcrumbList + FAQPage, 0 errors).

- [ ] **Step 3: Commit (only if smoke required fixes)**

```bash
git add -A && git commit -m "test(seo): smoke fixes for /contact location page"
```

---

## Task 9: Finish the branch

- [ ] **Step 1:** Use the **superpowers:finishing-a-development-branch** skill to open the PR (base `main`). Title: `feat(seo): local-SEO enrichment — NAP single source, richer LocalBusiness schema, /contact location page (Tier 2 feat 2)`. Include the spec link, the "no migration / no new route" note, and the owner-confirmation follow-ups (parking, exact HMO list, fasting wording, areas-served list, wheelchair, GBP photos/citations).

---

## Self-Review

**Spec coverage**
- Pillar A (NAP source of truth): Task 1 (HOURS/AREAS_SERVED/floor) + Task 2 (nap.ts) + Task 4 (consolidation incl. branded-email 4/F + OpenNowPill hours). ✓
- Pillar B (richer LocalBusiness/geo schema): Task 3 (clinicNode enrichment) + JSON-LD on /contact (Task 6) + breadcrumbs (Task 7). ✓
- Pillar C (enriched /contact): Task 5 (MapEmbed) + Task 6 (rebuild). ✓
- Folded-in extras: sameAs→Maps, ReserveAction, Messenger contactPoint, Apple Maps link, FAQ+schema, breadcrumbs — all covered. The `physicianLd specialtyLabels` item is intentionally dropped with documented rationale (see Deviation). ✓
- Testing: nap.test.ts (Task 2), structured-data.test.ts additions (Task 3), full gate (Task 8). ✓
- Guardrails: no migration, no new route, no hardcoded prices (page links out), click-to-load map (no cookies on load), areaServed truthful + owner-confirmable. ✓

**Placeholder scan:** the only "OWNER-CONFIRM" markers are deliberate, documented content gates (parking/transit copy) with safe defaults shipped — not code placeholders. No TODO/TBD in code.

**Type consistency:** `nap.ts` exports (`to12h`, `hoursLabel`, `hoursWithLastRegistration`, `addressLines`, `streetAddressLine`, `telHref`, `directionsHrefs`, `mapEmbedSrc`, `isOpenNow`) are referenced with identical names in Tasks 4/6. `MedicalClinic` node additions in Task 3 match the assertions in the same task's test. `FaqItem` is imported from `@/lib/marketing/faq` (existing type used by `faqPageLd`). `MapEmbed` prop shape `{ src, title }` matches its call site in Task 6.

**Test count:** baseline 316 → +5 `nap.test.ts` describe-cases (counts as multiple `it`s; ~10 assertions across 6 `it`s) + 1 new `structured-data` `it`. Expected total reported by vitest ≈ **322 tests** (exact number may differ by a couple depending on how the new `it` blocks count — the gate just requires all green, no regressions).
