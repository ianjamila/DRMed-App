# Tier-1 SEO/AEO Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship per-doctor pages, full structured data, a complete sitemap, per-page metadata, and a booking conversion event for drmed.ph's marketing surface.

**Architecture:** New pure builder module (`structured-data.ts`) + a thin `<JsonLd>` renderer centralize all JSON-LD; a `pageMetadata()` helper DRYs per-page metadata; a `listActivePhysicians()` helper feeds a new `/physicians/[slug]` route and the sitemap. All prices flow from the `services` table; analytics is scoped to the marketing route group only.

**Tech Stack:** Next.js 16 (App Router, RSC), TypeScript strict, Supabase, Vitest, `@vercel/analytics`.

Spec: `docs/superpowers/specs/2026-06-16-seo-aeo-tier1-design.md`

**Conventions for every task:** run from the worktree root `/Users/jamila/Claude/DRMed/.worktrees/seo-aeo-tier1`. Prefix git/gh with `export PATH="/opt/homebrew/bin:$PATH"`. Commit messages use Conventional Commits and end with:
`Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

---

### Task 1: Add SEO constants to `site.ts`

**Files:**
- Modify: `src/lib/marketing/site.ts`

- [ ] **Step 1: Add `postalCode` to the address, plus `priceRange`/`ogImage`/`logo` on SITE and a new `GEO` export.**

In `SITE` (the `as const` object), add two fields:
```ts
  priceRange: "₱₱",
  ogImage: "/hero-clinic.jpg",
  logo: "/logo.png",
```

In `CONTACT.address`, add `postalCode` right after `country`:
```ts
    postalCode: "1106",
```

Add a new export after the `CONTACT` block (candidate geo — **user verifies the pin from the Google Business Profile before merge**; the MedicalClinic builder omits geo when `lat`/`lng` are `null`):
```ts
// Clinic geo — CANDIDATE coordinates for "Northridge Plaza, 12 Congressional
// Ave, Project 8, Quezon City 1106". VERIFY against the Google Business Profile
// pin before merge. Set lat/lng to null to ship MedicalClinic JSON-LD without geo.
export const GEO = {
  lat: 14.6557 as number | null,
  lng: 121.0334 as number | null,
  mapUrl:
    "https://www.google.com/maps/search/?api=1&query=Northridge+Plaza+Congressional+Avenue+Quezon+City",
} as const;
```

- [ ] **Step 2: Typecheck.**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 3: Commit.**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git add src/lib/marketing/site.ts
git commit -m "feat(seo): add geo/postalCode/priceRange/ogImage consts to site config

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Lift `FAQ_ITEMS` into a shared module

**Files:**
- Create: `src/lib/marketing/faq.ts`
- Modify: `src/components/marketing/home/Faq.tsx`

- [ ] **Step 1: Create `src/lib/marketing/faq.ts`** with the exact items currently in `Faq.tsx` (verbatim — do not reword; they are operational, not clinical claims):

```ts
export interface FaqItem {
  question: string;
  answer: string;
}

export const FAQ_ITEMS: readonly FaqItem[] = [
  {
    question: "Do I need to fast before my test?",
    answer:
      "Blood sugar (FBS) and lipid tests need 8–10 hours of fasting — water is fine. Most other tests don't require it. Unsure? Message us before your visit and we'll confirm.",
  },
  {
    question: "Can I use my HMO?",
    answer:
      "Yes — we're accredited with 10 major HMO providers. Bring your HMO card and a valid ID; reception processes your LOA and covered services are cashless.",
  },
  {
    question: "How do I get my results?",
    answer:
      "Most tests release within 24 hours. We email you when they're ready, and you can view and download the official signed PDF anytime in the patient portal using your DRM-ID and the Secure PIN on your receipt.",
  },
  {
    question: "Do you see children?",
    answer:
      "Yes — we have pediatricians on staff. Schedules can change, so kindly call or message us first to confirm availability before bringing your little one in.",
  },
  {
    question: "Can you come to my home or office?",
    answer:
      "Yes — our team comes to your home or office for lab sample collection (subject to availability). Consultations are done in the clinic, though some doctors offer online consultations by appointment. Book online or message us, and reception will call to confirm the schedule and fee.",
  },
] as const;
```

- [ ] **Step 2: Update `Faq.tsx`** to import the items instead of declaring them locally. Read the file, delete the local `FAQ_ITEMS` const, and add at the top:
```ts
import { FAQ_ITEMS } from "@/lib/marketing/faq";
```
Leave the rendering (the `<details>/<summary>` map) unchanged.

- [ ] **Step 3: Typecheck + test.**

Run: `npm run typecheck && npm test`
Expected: PASS, 260 tests still green.

- [ ] **Step 4: Commit.**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git add src/lib/marketing/faq.ts src/components/marketing/home/Faq.tsx
git commit -m "refactor(marketing): extract FAQ_ITEMS to shared faq module

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Structured-data builders (TDD)

**Files:**
- Create: `src/lib/marketing/structured-data.ts`
- Test: `src/lib/marketing/structured-data.test.ts`

- [ ] **Step 1: Write the failing test** `src/lib/marketing/structured-data.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { SITE } from "./site";
import {
  medicalClinicLd,
  websiteLd,
  faqPageLd,
  physicianLd,
  physiciansItemListLd,
  breadcrumbLd,
  serviceOfferLd,
} from "./structured-data";

describe("medicalClinicLd", () => {
  it("is a MedicalClinic with the clinic @id, address and price range", () => {
    const ld = medicalClinicLd();
    expect(ld["@type"]).toBe("MedicalClinic");
    expect(ld["@id"]).toBe(`${SITE.url}/#clinic`);
    expect((ld.address as Record<string, unknown>)["@type"]).toBe("PostalAddress");
    expect(ld.priceRange).toBeTruthy();
    expect(ld.sameAs).toContain("https://www.facebook.com/drmedcliniclab/");
  });
  it("includes geo + hasMap when coordinates are set (current config)", () => {
    const ld = medicalClinicLd();
    // GEO has candidate coords by default; if a maintainer nulls them, geo is omitted.
    if (ld.geo) {
      expect((ld.geo as Record<string, unknown>)["@type"]).toBe("GeoCoordinates");
      expect(ld.hasMap).toBeTruthy();
    }
  });
});

describe("websiteLd", () => {
  it("declares a SearchAction targeting all-services", () => {
    const ld = websiteLd();
    expect(ld["@type"]).toBe("WebSite");
    const action = ld.potentialAction as Record<string, unknown>;
    expect(action["@type"]).toBe("SearchAction");
    expect((action.target as Record<string, unknown>).urlTemplate).toContain(
      "/all-services?q={search_term_string}",
    );
  });
});

describe("faqPageLd", () => {
  it("maps each item to a Question/Answer", () => {
    const ld = faqPageLd([{ question: "Q1?", answer: "A1." }]);
    expect(ld["@type"]).toBe("FAQPage");
    const main = ld.mainEntity as Array<Record<string, unknown>>;
    expect(main).toHaveLength(1);
    expect(main[0]["@type"]).toBe("Question");
    expect((main[0].acceptedAnswer as Record<string, unknown>).text).toBe("A1.");
  });
});

describe("physicianLd", () => {
  it("builds a Physician linked to the clinic with deduped specialties", () => {
    const ld = physicianLd({
      slug: "dr-jane",
      fullName: "Dr. Jane Cruz",
      specialty: "Pediatrics",
      specialtyLabels: ["Pediatrics", "Internal Medicine"],
      photoUrl: "https://x/p.jpg",
    });
    expect(ld["@type"]).toBe("Physician");
    expect(ld["@id"]).toBe(`${SITE.url}/physicians/dr-jane#physician`);
    expect(ld.medicalSpecialty).toEqual(["Pediatrics", "Internal Medicine"]);
    expect((ld.worksFor as Record<string, unknown>)["@id"]).toBe(`${SITE.url}/#clinic`);
  });
});

describe("physiciansItemListLd", () => {
  it("numbers items from 1 with absolute urls", () => {
    const ld = physiciansItemListLd([
      { slug: "a", fullName: "A" },
      { slug: "b", fullName: "B" },
    ]);
    expect(ld["@type"]).toBe("ItemList");
    const items = ld.itemListElement as Array<Record<string, unknown>>;
    expect(items[0].position).toBe(1);
    expect(items[1].url).toBe(`${SITE.url}/physicians/b`);
  });
});

describe("breadcrumbLd", () => {
  it("builds 1-based positions with absolute item urls", () => {
    const ld = breadcrumbLd([
      { name: "Home", path: "/" },
      { name: "Physicians", path: "/physicians" },
    ]);
    const items = ld.itemListElement as Array<Record<string, unknown>>;
    expect(items[0].position).toBe(1);
    expect(items[1].item).toBe(`${SITE.url}/physicians`);
  });
});

describe("serviceOfferLd", () => {
  it("includes a priced PHP Offer ONLY for lab_package, from the passed-in price", () => {
    const pkg = serviceOfferLd({
      code: "ROUTINE",
      name: "Routine Package",
      description: null,
      kind: "lab_package",
      pricePhp: 1299,
    });
    expect(pkg["@type"]).toBe("Service");
    const offer = pkg.offers as Record<string, unknown>;
    expect(offer.price).toBe("1299");
    expect(offer.priceCurrency).toBe("PHP");

    const test = serviceOfferLd({
      code: "FBS",
      name: "Fasting Blood Sugar",
      description: "Blood sugar test.",
      kind: "lab_test",
      pricePhp: 150,
    });
    expect(test.offers).toBeUndefined(); // never leak prices the page hides
    expect(test.provider).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails.**

Run: `npx vitest run src/lib/marketing/structured-data.test.ts`
Expected: FAIL — cannot resolve `./structured-data`.

- [ ] **Step 3: Implement `src/lib/marketing/structured-data.ts`:**

```ts
import { SITE, CONTACT, SOCIAL, GEO } from "./site";
import type { FaqItem } from "./faq";

const CLINIC_ID = `${SITE.url}/#clinic`;
type SchemaObject = Record<string, unknown>;

function clinicRef(): SchemaObject {
  return { "@type": "MedicalClinic", "@id": CLINIC_ID, name: SITE.name };
}

function postalAddress(): SchemaObject {
  return {
    "@type": "PostalAddress",
    streetAddress: `${CONTACT.address.line1}, ${CONTACT.address.line2}`,
    addressLocality: CONTACT.address.city,
    addressRegion: CONTACT.address.region,
    postalCode: CONTACT.address.postalCode,
    addressCountry: CONTACT.address.country,
  };
}

export function medicalClinicLd(): SchemaObject {
  const ld: SchemaObject = {
    "@context": "https://schema.org",
    "@type": "MedicalClinic",
    "@id": CLINIC_ID,
    name: SITE.name,
    url: SITE.url,
    logo: `${SITE.url}${SITE.logo}`,
    image: `${SITE.url}${SITE.ogImage}`,
    description: SITE.description,
    email: CONTACT.email,
    telephone: CONTACT.phone.mobileE164,
    priceRange: SITE.priceRange,
    address: postalAddress(),
    areaServed: [
      { "@type": "City", name: "Quezon City" },
      { "@type": "AdministrativeArea", name: "Metro Manila" },
    ],
    openingHours: "Mo-Sa 08:00-17:00",
    medicalSpecialty: ["Diagnostic", "ClinicalLaboratory", "Radiology"],
    sameAs: [SOCIAL.facebook, SOCIAL.instagram],
  };
  if (GEO.lat != null && GEO.lng != null) {
    ld.geo = { "@type": "GeoCoordinates", latitude: GEO.lat, longitude: GEO.lng };
    if (GEO.mapUrl) ld.hasMap = GEO.mapUrl;
  }
  return ld;
}

export function websiteLd(): SchemaObject {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    "@id": `${SITE.url}/#website`,
    url: SITE.url,
    name: SITE.name,
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${SITE.url}/all-services?q={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
  };
}

export function faqPageLd(items: readonly FaqItem[]): SchemaObject {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((it) => ({
      "@type": "Question",
      name: it.question,
      acceptedAnswer: { "@type": "Answer", text: it.answer },
    })),
  };
}

export interface PhysicianLdInput {
  slug: string;
  fullName: string;
  specialty: string;
  specialtyLabels?: string[];
  photoUrl: string;
}

export function physicianLd(p: PhysicianLdInput): SchemaObject {
  const specialties = [p.specialty, ...(p.specialtyLabels ?? [])].filter(
    (v, i, a) => Boolean(v) && a.indexOf(v) === i,
  );
  return {
    "@context": "https://schema.org",
    "@type": "Physician",
    "@id": `${SITE.url}/physicians/${p.slug}#physician`,
    name: p.fullName,
    url: `${SITE.url}/physicians/${p.slug}`,
    image: p.photoUrl,
    medicalSpecialty: specialties,
    worksFor: clinicRef(),
  };
}

export interface PhysicianListItem {
  slug: string;
  fullName: string;
}

export function physiciansItemListLd(docs: readonly PhysicianListItem[]): SchemaObject {
  return {
    "@context": "https://schema.org",
    "@type": "ItemList",
    itemListElement: docs.map((d, i) => ({
      "@type": "ListItem",
      position: i + 1,
      url: `${SITE.url}/physicians/${d.slug}`,
      name: d.fullName,
    })),
  };
}

export interface BreadcrumbCrumb {
  name: string;
  path: string;
}

export function breadcrumbLd(trail: readonly BreadcrumbCrumb[]): SchemaObject {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: `${SITE.url}${c.path}`,
    })),
  };
}

export interface ServiceLdInput {
  code: string;
  name: string;
  description: string | null;
  kind: string;
  pricePhp: number;
}

export function serviceOfferLd(s: ServiceLdInput): SchemaObject {
  const url = `${SITE.url}/all-services/${s.code.toLowerCase()}`;
  const ld: SchemaObject = {
    "@context": "https://schema.org",
    "@type": "Service",
    name: s.name,
    description: s.description ?? `${s.name} at ${SITE.name}.`,
    url,
    provider: clinicRef(),
  };
  if (s.kind === "lab_package") {
    ld.offers = {
      "@type": "Offer",
      price: String(s.pricePhp),
      priceCurrency: "PHP",
      availability: "https://schema.org/InStock",
      url,
    };
  }
  return ld;
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `npx vitest run src/lib/marketing/structured-data.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit.**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git add src/lib/marketing/structured-data.ts src/lib/marketing/structured-data.test.ts
git commit -m "feat(seo): pure JSON-LD builders for clinic/website/faq/physician/service

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: `<JsonLd>` renderer component

**Files:**
- Create: `src/components/marketing/json-ld.tsx`

- [ ] **Step 1: Create the component** (server component — no `"use client"`):

```tsx
interface JsonLdProps {
  data: Record<string, unknown> | Record<string, unknown>[];
}

/**
 * Renders schema.org JSON-LD. Pass a single builder result or an array of them.
 * Matches the historical inline `<script type="application/ld+json">` pattern.
 */
export function JsonLd({ data }: JsonLdProps) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
```

- [ ] **Step 2: Typecheck.**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git add src/components/marketing/json-ld.tsx
git commit -m "feat(seo): shared JsonLd renderer component

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: `pageMetadata()` helper

**Files:**
- Create: `src/lib/marketing/metadata.ts`

- [ ] **Step 1: Create the helper:**

```ts
import type { Metadata } from "next";
import { SITE } from "./site";

export interface PageMetaInput {
  /** Short page title — wrapped by the root `%s — drmed.ph` template unless absoluteTitle. */
  title: string;
  description: string;
  /** Absolute path from the site root, e.g. "/about" or "/physicians/dr-jane". */
  path: string;
  /** Absolute OG/Twitter image URL or site-relative path; defaults to SITE.ogImage. */
  image?: string;
  /** Set the document <title> verbatim (used by the homepage). */
  absoluteTitle?: boolean;
}

export function pageMetadata({
  title,
  description,
  path,
  image,
  absoluteTitle,
}: PageMetaInput): Metadata {
  const canonical = `${SITE.url}${path}`;
  const ogImage = image ?? `${SITE.url}${SITE.ogImage}`;
  const ogTitle = absoluteTitle ? title : `${title} — ${SITE.name}`;
  return {
    title: absoluteTitle ? { absolute: title } : title,
    description,
    alternates: { canonical },
    openGraph: {
      type: "website",
      locale: "en_PH",
      siteName: SITE.shortName,
      url: canonical,
      title: ogTitle,
      description,
      images: [{ url: ogImage }],
    },
    twitter: {
      card: "summary_large_image",
      title: ogTitle,
      description,
      images: [ogImage],
    },
  };
}
```

- [ ] **Step 2: Typecheck.**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git add src/lib/marketing/metadata.ts
git commit -m "feat(seo): pageMetadata helper (canonical + OG/Twitter)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: `listActivePhysicians()` helper

**Files:**
- Create: `src/lib/marketing/physicians.ts`

- [ ] **Step 1: Create the helper** (mirrors `listActiveServices` in `services.ts`):

```ts
import "server-only";
import { createClient } from "@/lib/supabase/server";

export interface PublicPhysicianListItem {
  slug: string;
  full_name: string;
  updated_at: string;
}

/** Active physicians for the sitemap + per-doctor static params, ordered for display. */
export async function listActivePhysicians(): Promise<PublicPhysicianListItem[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("physicians")
    .select("slug, full_name, updated_at")
    .eq("is_active", true)
    .order("display_order", { ascending: true })
    .order("full_name", { ascending: true });
  if (error) {
    console.error("listActivePhysicians failed", error);
    return [];
  }
  return data ?? [];
}
```

- [ ] **Step 2: Typecheck.**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git add src/lib/marketing/physicians.ts
git commit -m "feat(seo): listActivePhysicians helper for sitemap + per-doctor pages

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Per-doctor page `/physicians/[slug]`

**Files:**
- Create: `src/app/(marketing)/physicians/[slug]/page.tsx`

Read these first for exact tokens/components to reuse: `src/app/(marketing)/physicians/page.tsx` (card classes, `DoctorAvatar`, `formatSchedule`, `Reveal`), `src/app/(marketing)/schedule/page.tsx` (blocks + upcoming-overrides query pattern), `src/lib/physicians/photo.ts`, `src/lib/physicians/format-schedule.ts`, `src/components/marketing/home/DoctorPhoto.tsx`.

- [ ] **Step 1: Create the route.** Server component; ISR; static params; `notFound()` on miss. Use `physicianPhotoUrl`, `formatSchedule`, the `pageMetadata`/`physicianLd`/`breadcrumbLd` builders, and `<JsonLd>`. Match the warm-card classes from the directory page.

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Calendar } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { SITE } from "@/lib/marketing/site";
import { pageMetadata } from "@/lib/marketing/metadata";
import { physicianLd, breadcrumbLd } from "@/lib/marketing/structured-data";
import { JsonLd } from "@/components/marketing/json-ld";
import { physicianPhotoUrl } from "@/lib/physicians/photo";
import { formatSchedule } from "@/lib/physicians/format-schedule";
import { listActivePhysicians } from "@/lib/marketing/physicians";
import { DoctorAvatar } from "@/components/marketing/doctor-avatar";
import { Reveal } from "@/components/marketing/reveal"; // confirm import path while reading directory page

export const revalidate = 300;

export async function generateStaticParams() {
  const docs = await listActivePhysicians();
  return docs.map((d) => ({ slug: d.slug }));
}

interface PageProps {
  params: Promise<{ slug: string }>;
}

interface PhysicianRow {
  id: string;
  slug: string;
  full_name: string;
  specialty: string;
  group_label: string | null;
  bio: string | null;
  photo_path: string | null;
}

async function loadPhysician(slug: string) {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("physicians")
    .select("id, slug, full_name, specialty, group_label, bio, photo_path")
    .eq("slug", slug)
    .eq("is_active", true)
    .maybeSingle();
  if (error || !data) return null;
  return data as PhysicianRow;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const doc = await loadPhysician(slug);
  if (!doc) return { title: "Physician" };
  const description =
    doc.bio?.slice(0, 155) ??
    `${doc.full_name}, ${doc.specialty} at ${SITE.name} in Quezon City. View clinic schedule and book a consultation.`;
  return pageMetadata({
    title: `${doc.full_name} — ${doc.specialty}`,
    description,
    path: `/physicians/${doc.slug}`,
    image: physicianPhotoUrl({ slug: doc.slug, photo_path: doc.photo_path }),
  });
}

export default async function PhysicianPage({ params }: PageProps) {
  const { slug } = await params;
  const doc = await loadPhysician(slug);
  if (!doc) notFound();

  const supabase = await createClient();
  const { data: scheduleRows } = await supabase
    .from("physician_schedules")
    .select("day_of_week, start_time, end_time")
    .eq("physician_id", doc.id);

  const blocks = (scheduleRows ?? []).map((r) => ({
    day_of_week: r.day_of_week,
    start_time: r.start_time,
    end_time: r.end_time,
  }));
  const scheduleLines = formatSchedule(blocks);
  const photoUrl = physicianPhotoUrl({ slug: doc.slug, photo_path: doc.photo_path });

  const ld = [
    physicianLd({
      slug: doc.slug,
      fullName: doc.full_name,
      specialty: doc.specialty,
      photoUrl,
    }),
    breadcrumbLd([
      { name: "Home", path: "/" },
      { name: "Physicians", path: "/physicians" },
      { name: doc.full_name, path: `/physicians/${doc.slug}` },
    ]),
  ];

  return (
    <>
      <JsonLd data={ld} />
      {/* Match the page chrome + warm-card tokens used in physicians/page.tsx.
          Breadcrumb (visual) → hero card (photo + specialty eyebrow + name +
          group chip + bio if present + Book CTA) → schedule card → location
          mini-card → back link. Mobile-first single column at 390px. */}
      {/* CTA: */}
      <Link href={`/schedule?doctor=${doc.slug}`}>Book an appointment</Link>
      {/* Schedule: render scheduleLines, else "By appointment — reception confirms the slot". */}
      {scheduleLines.length === 0 && <p>By appointment — reception confirms the slot.</p>}
      <Calendar aria-hidden="true" />
      <DoctorAvatar photoUrl={photoUrl} name={doc.full_name} />
      <Link href="/physicians">← All specialists</Link>
    </>
  );
}
```

Build out the JSX to the real design (hero card, schedule card with `Calendar` bullets, reused location mini-card, back link) using the exact class tokens from `physicians/page.tsx`. For the hero portrait, reuse `DoctorPhoto` (3/4 frame) rather than the round `DoctorAvatar` if it reads better at this size — your call while matching the system. Keep `bio` rendering conditional on `doc.bio`.

- [ ] **Step 2: Build to verify the route compiles and statically generates.**

Run: `npm run build 2>&1 | grep -E "physicians|error|Error" | head`
Expected: build succeeds; `/physicians/[slug]` appears in the route list.

- [ ] **Step 3: Visual check @ 390px and 1440px** (dev server): a real physician slug renders photo, specialty, name, schedule (or "By appointment"), and the Book CTA links to `/schedule?doctor=<slug>`. An unknown slug 404s.

- [ ] **Step 4: Commit.**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git add "src/app/(marketing)/physicians/[slug]/page.tsx"
git commit -m "feat(seo): per-doctor page /physicians/[slug] with Physician + Breadcrumb JSON-LD

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Link directory cards + ItemList JSON-LD + metadata

**Files:**
- Modify: `src/app/(marketing)/physicians/page.tsx`

- [ ] **Step 1: Wrap each card in a link.** Read the file; the card is the `<article>` at ~lines 190-216 inside the `physicians.map(...)`. Wrap the `<article>` in:
```tsx
<Link href={`/physicians/${doc.slug}`} className="block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-cyan)] rounded-[20px]">
  {/* existing <article> ... */}
</Link>
```
Add `import Link from "next/link";` if not present. Keep the hover lift on the `<article>`.

- [ ] **Step 2: Add ItemList JSON-LD.** Build from the already-fetched `physicians` array and render via `<JsonLd>` at the top of the returned tree:
```tsx
import { JsonLd } from "@/components/marketing/json-ld";
import { physiciansItemListLd } from "@/lib/marketing/structured-data";
// ...in the component, after physicians are loaded:
const itemList = physiciansItemListLd(
  physicians.map((d) => ({ slug: d.slug, fullName: d.full_name })),
);
// ...first child of the returned fragment:
<JsonLd data={itemList} />
```

- [ ] **Step 3: Replace the metadata export** with `pageMetadata`:
```tsx
import { pageMetadata } from "@/lib/marketing/metadata";

export const metadata = pageMetadata({
  title: "Our Physicians & Schedules",
  description:
    "Meet the doctors at DRMed Clinic & Laboratory in Quezon City and view their clinic schedules. Book a consultation online.",
  path: "/physicians",
});
```

- [ ] **Step 4: Typecheck + build.**

Run: `npm run typecheck && npm run build 2>&1 | tail -3`
Expected: PASS.

- [ ] **Step 5: Visual check** the directory cards are clickable (keyboard focus ring + pointer) and navigate to the right doctor.

- [ ] **Step 6: Commit.**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git add "src/app/(marketing)/physicians/page.tsx"
git commit -m "feat(seo): link directory cards to per-doctor pages + ItemList JSON-LD + metadata

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Homepage structured data, metadata, and linked Specialists

**Files:**
- Modify: `src/app/(marketing)/page.tsx`
- Modify: `src/components/marketing/home/Specialists.tsx`

- [ ] **Step 1: Replace the inline MedicalBusiness object.** Read `page.tsx`. Delete the `const jsonLd = {...}` (~lines 19-37) and its `<script ...>` injection (~lines 66-69). Add imports and render the three blocks via `<JsonLd>`:
```tsx
import { JsonLd } from "@/components/marketing/json-ld";
import { medicalClinicLd, websiteLd, faqPageLd } from "@/lib/marketing/structured-data";
import { FAQ_ITEMS } from "@/lib/marketing/faq";
// first child of the returned fragment:
<JsonLd data={[medicalClinicLd(), websiteLd(), faqPageLd(FAQ_ITEMS)]} />
```
Remove the now-unused `CONTACT`/`SOCIAL` imports if they become unused (typecheck will flag).

- [ ] **Step 2: Add homepage metadata** (it currently has none — relies on root defaults):
```tsx
import { pageMetadata } from "@/lib/marketing/metadata";

export const metadata = pageMetadata({
  title: `${SITE.name} — ${SITE.tagline}`,
  description: SITE.description,
  path: "/",
  absoluteTitle: true,
});
```
Ensure `SITE` is imported.

- [ ] **Step 3: Thread `slug` into Specialists.** In the `specialists` map (~lines 58-62) add `slug: doc.slug`:
```tsx
const specialists = (topPhysicians ?? []).map((doc) => ({
  name: doc.full_name,
  specialty: doc.specialty,
  slug: doc.slug,
  photoUrl: physicianPhotoUrl({ slug: doc.slug, photo_path: doc.photo_path }),
}));
```

- [ ] **Step 4: Update `Specialists.tsx`.** Read it. Add `slug: string;` to the `Physician` interface (~lines 7-11). Wrap each grid card (the `<div>` at ~lines 37-56) in:
```tsx
<Link href={`/physicians/${p.slug}`} className="block rounded-[20px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--color-brand-cyan)]">
  {/* existing card markup */}
</Link>
```
Add `import Link from "next/link";` if missing. Keep the existing `<PillLink href="/physicians">` section link.

- [ ] **Step 5: Typecheck + build.**

Run: `npm run typecheck && npm run build 2>&1 | tail -3`
Expected: PASS.

- [ ] **Step 6: Visual check** homepage: JSON-LD present in page source (view-source: search `MedicalClinic`, `FAQPage`, `SearchAction`); Specialists cards link to the right doctors at 390px + 1440px.

- [ ] **Step 7: Commit.**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git add "src/app/(marketing)/page.tsx" "src/components/marketing/home/Specialists.tsx"
git commit -m "feat(seo): homepage MedicalClinic+WebSite+FAQPage JSON-LD, metadata, linked specialists

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 10: all-services index — metadata + functional `?q=` (SearchAction target)

**Files:**
- Modify: `src/app/(marketing)/all-services/page.tsx`
- Modify: `src/app/(marketing)/all-services/services-catalog.tsx`

- [ ] **Step 1: Make the page read `?q=` and pass it down.** Read both files. The page is a server component rendering the client `ServicesCatalog`. Add a `searchParams` prop, await it, and pass an `initialQuery`:
```tsx
interface PageProps {
  searchParams: Promise<{ q?: string }>;
}

export default async function AllServicesPage({ searchParams }: PageProps) {
  const { q } = await searchParams;
  // ...existing service load...
  return <ServicesCatalog services={...} initialQuery={q ?? ""} />;
}
```

- [ ] **Step 2: Accept `initialQuery` in the catalog.** In `services-catalog.tsx`, add `initialQuery?: string` to its props and seed the search `useState` with it:
```tsx
const [query, setQuery] = useState(initialQuery ?? "");
```
(Match the existing state variable name for the search box.)

- [ ] **Step 3: Replace the metadata export** with `pageMetadata`:
```tsx
import { pageMetadata } from "@/lib/marketing/metadata";

export const metadata = pageMetadata({
  title: "All Services & Tests",
  description:
    "Browse every laboratory test, imaging service, and consultation at DRMed Clinic & Laboratory in Quezon City — up to 50% less than hospitals.",
  path: "/all-services",
});
```

- [ ] **Step 4: Typecheck + build.**

Run: `npm run typecheck && npm run build 2>&1 | tail -3`
Expected: PASS.

- [ ] **Step 5: Visual check** `/all-services?q=blood` pre-filters the catalog to matching services.

- [ ] **Step 6: Commit.**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git add "src/app/(marketing)/all-services/page.tsx" "src/app/(marketing)/all-services/services-catalog.tsx"
git commit -m "feat(seo): all-services metadata + functional ?q= search (SearchAction target)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 11: Service detail — metadata via helper + Service/Offer + Breadcrumb JSON-LD

**Files:**
- Modify: `src/app/(marketing)/all-services/[code]/page.tsx`

- [ ] **Step 1: Rewrite `generateMetadata`** to use `pageMetadata` (keeps title+desc, adds canonical + OG):
```tsx
import { pageMetadata } from "@/lib/marketing/metadata";

export async function generateMetadata({ params }: ServicePageProps): Promise<Metadata> {
  const { code } = await params;
  const service = await getServiceByCode(code);
  if (!service) return { title: "Service" };
  return pageMetadata({
    title: service.name,
    description:
      service.description ??
      `${service.name} — laboratory test at ${SITE.name}.`,
    path: `/all-services/${service.code.toLowerCase()}`,
  });
}
```
Ensure `SITE` is imported.

- [ ] **Step 2: Add Service+Offer + Breadcrumb JSON-LD** in the page component (the `service` is already loaded). Price flows from `service.price_php`; the builder gates the Offer to packages:
```tsx
import { JsonLd } from "@/components/marketing/json-ld";
import { serviceOfferLd, breadcrumbLd } from "@/lib/marketing/structured-data";
// in the component, after `service` is confirmed non-null:
const ld = [
  serviceOfferLd({
    code: service.code,
    name: service.name,
    description: service.description,
    kind: service.kind,
    pricePhp: service.price_php,
  }),
  breadcrumbLd([
    { name: "Home", path: "/" },
    { name: "All Services", path: "/all-services" },
    { name: service.name, path: `/all-services/${service.code.toLowerCase()}` },
  ]),
];
// first child of the returned tree:
<JsonLd data={ld} />
```

- [ ] **Step 3: Typecheck + build.**

Run: `npm run typecheck && npm run build 2>&1 | tail -3`
Expected: PASS.

- [ ] **Step 4: Visual check** view-source on a package URL shows an `offers` block with the DB price; a non-package service URL shows `Service` with **no** `offers`.

- [ ] **Step 5: Commit.**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git add "src/app/(marketing)/all-services/[code]/page.tsx"
git commit -m "feat(seo): service detail Service+Offer (packages only) + Breadcrumb + canonical/OG

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 12: Per-page metadata for packages / about / contact / schedule

**Files:**
- Modify: `src/app/(marketing)/packages/page.tsx`
- Modify: `src/app/(marketing)/about/page.tsx`
- Modify: `src/app/(marketing)/contact/page.tsx`
- Modify: `src/app/(marketing)/schedule/page.tsx`

- [ ] **Step 1: Replace each page's `metadata` export** with `pageMetadata(...)`. Read each file; add `import { pageMetadata } from "@/lib/marketing/metadata";` and swap the existing `export const metadata = {...}` for:

`packages/page.tsx`:
```tsx
export const metadata = pageMetadata({
  title: "Diagnostic Packages & Checkup Bundles",
  description:
    "Affordable lab packages and annual checkup bundles at DRMed Clinic & Laboratory in Quezon City — up to 50% less than hospitals.",
  path: "/packages",
});
```

`about/page.tsx`:
```tsx
export const metadata = pageMetadata({
  title: "About DRMed Clinic & Laboratory",
  description:
    "A family-focused clinic and laboratory in Quezon City offering consultations, lab tests, X-ray, ultrasound, ECG, and home service.",
  path: "/about",
});
```

`contact/page.tsx`:
```tsx
export const metadata = pageMetadata({
  title: "Contact & Location",
  description:
    "Visit DRMed Clinic & Laboratory in Quezon City. Address, phone, hours, and directions. Open Monday to Saturday, 8 AM–5 PM.",
  path: "/contact",
});
```

`schedule/page.tsx`:
```tsx
export const metadata = pageMetadata({
  title: "Book an Appointment",
  description:
    "Book a consultation, lab test, or home service at DRMed Clinic & Laboratory in Quezon City. See clinic hours and location.",
  path: "/schedule",
});
```
(Note: `schedule/page.tsx` is also edited in Task 14 — keep `export const dynamic`/`force-dynamic` and other exports intact.)

- [ ] **Step 2: Typecheck + build.**

Run: `npm run typecheck && npm run build 2>&1 | tail -3`
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git add "src/app/(marketing)/packages/page.tsx" "src/app/(marketing)/about/page.tsx" "src/app/(marketing)/contact/page.tsx" "src/app/(marketing)/schedule/page.tsx"
git commit -m "feat(seo): canonical + OG metadata for packages/about/contact/schedule

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 13: Sitemap — `/physicians` + per-doctor pages

**Files:**
- Modify: `src/app/sitemap.ts`

- [ ] **Step 1: Add `/physicians` to the static list and enumerate per-doctor pages.** Read the file. Add `"/physicians"` to the static paths array. Then add, mirroring the `services` block:
```ts
import { listActivePhysicians } from "@/lib/marketing/physicians";
// ...
const physicians = await listActivePhysicians();
const physicianEntries: MetadataRoute.Sitemap = physicians.map((p) => ({
  url: `${base}/physicians/${p.slug}`,
  lastModified: p.updated_at ? new Date(p.updated_at) : now,
  changeFrequency: "monthly",
  priority: 0.6,
}));

return [...staticEntries, ...serviceEntries, ...physicianEntries];
```

- [ ] **Step 2: Typecheck + build, and confirm the sitemap renders.**

Run: `npm run typecheck && npm run build 2>&1 | tail -3`
Expected: PASS.

- [ ] **Step 3: Visual/route check** `/sitemap.xml` contains `/physicians` and at least one `/physicians/<slug>` entry (dev server: `curl -s localhost:3000/sitemap.xml | grep physicians`).

- [ ] **Step 4: Commit.**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git add src/app/sitemap.ts
git commit -m "fix(seo): add /physicians + per-doctor pages to sitemap

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 14: Booking deep-link — preselect doctor from `?doctor=<slug>`

**Files:**
- Modify: `src/app/(marketing)/schedule/page.tsx`
- Modify: `src/app/(marketing)/schedule/booking-form.tsx`

**Do NOT refactor `booking-form.tsx`** — only additive props + initial state. Consult the `drmed-booking-and-intake` skill before editing this surface.

- [ ] **Step 1: Read `?doctor=` in the page and resolve slug → id.** Read `schedule/page.tsx`. Add a `searchParams` prop (await it). After the physicians are loaded into `bookablePhysicians` + `byAppointmentPhysicians`, resolve the slug to an id across both lists, and pass new props to `<BookingForm>`:
```tsx
interface PageProps {
  searchParams: Promise<{ doctor?: string }>;
}
// in the component:
const { doctor } = await searchParams;
const matchedPhysician = doctor
  ? [...bookablePhysicians, ...byAppointmentPhysicians].find((p) => p.slug === doctor)
  : undefined;
// pass to the form:
<BookingForm
  /* ...existing props... */
  initialBranch={matchedPhysician ? "doctor_appointment" : undefined}
  initialPhysicianId={matchedPhysician?.id}
/>
```
Confirm the loaded physician objects carry `slug` and `id` (the page already builds `photo_url` from slug — if `slug` isn't selected/mapped onto these objects, add it to the select + mapping).

- [ ] **Step 2: Accept the optional props in `BookingForm`.** Read `booking-form.tsx`. In the `Props` interface (~line 95) add:
```tsx
  initialBranch?: Branch;
  initialPhysicianId?: string;
```
Destructure them in the component signature (~line 152) and use them as the `useState` initial values:
- branch state (~line 163): `const [branch, setBranch] = useState<Branch>(initialBranch ?? "lab_request");`
- physician state (~line 184): `const [physicianId, setPhysicianId] = useState<string>(initialPhysicianId ?? "");`

- [ ] **Step 3: Typecheck + build.**

Run: `npm run typecheck && npm run build 2>&1 | tail -3`
Expected: PASS.

- [ ] **Step 4: Visual check** `/schedule?doctor=<real-slug>` opens with the Doctor-appointment branch active and that physician preselected; `/schedule` (no param) is unchanged; an unknown slug is ignored.

- [ ] **Step 5: Commit.**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git add "src/app/(marketing)/schedule/page.tsx" "src/app/(marketing)/schedule/booking-form.tsx"
git commit -m "feat(seo): preselect physician on /schedule?doctor=<slug>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 15: Booking conversion event

**Files:**
- Modify: `src/app/(marketing)/schedule/booking-form.tsx`

- [ ] **Step 1: Fire a non-PII Vercel Analytics event on a successful booking.** Read `booking-form.tsx` and locate where the submit result is observed (the `submitBookingAction` result / `useActionState` state, or the success-UI branch). Add the import:
```tsx
import { track } from "@vercel/analytics";
```
When the action result becomes a success, fire **once** (guard with a `useRef` so re-renders don't double-count):
```tsx
const trackedRef = useRef(false);
useEffect(() => {
  if (state?.ok && !trackedRef.current) {
    trackedRef.current = true;
    track("booking_submitted", {
      branch,
      services: selectedServiceCount, // the count of chosen services — no names/PII
    });
  }
}, [state, branch, selectedServiceCount]);
```
Use the form's actual success signal and service-count variable names. **No patient name, email, phone, DRM-ID, or free text** in the payload — branch + count only.

- [ ] **Step 2: Typecheck + build.**

Run: `npm run typecheck && npm run build 2>&1 | tail -3`
Expected: PASS.

- [ ] **Step 3: Visual check** in the browser network tab: completing a booking sends a `/_vercel/insights/event` request with `booking_submitted` and no PII fields. (Local dev may no-op without the Vercel env; verify the call is wired, payload shape correct.)

- [ ] **Step 4: Commit.**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git add "src/app/(marketing)/schedule/booking-form.tsx"
git commit -m "feat(seo): booking_submitted conversion event (no PII)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 16: Scope Vercel Analytics to marketing only

**Files:**
- Modify: `src/app/layout.tsx`
- Modify: `src/app/(marketing)/layout.tsx`

- [ ] **Step 1: Remove `<Analytics/>` from the root layout.** In `src/app/layout.tsx`, delete the import `import { Analytics } from "@vercel/analytics/next";` (line ~3) and the `<Analytics />` render (line ~75).

- [ ] **Step 2: Add it to the marketing layout.** In `src/app/(marketing)/layout.tsx`, add the import and render `<Analytics />` inside the returned tree (e.g., as the last child alongside the FAB/footer):
```tsx
import { Analytics } from "@vercel/analytics/next";
// ...in the returned JSX:
<Analytics />
```

- [ ] **Step 3: Typecheck + build.**

Run: `npm run typecheck && npm run build 2>&1 | tail -3`
Expected: PASS.

- [ ] **Step 4: Verify scoping** in built output / dev: marketing pages load `/_vercel/insights/script.js`; `/portal` and `/staff` pages do **not** include it (check page source).

- [ ] **Step 5: Commit.**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git add "src/app/layout.tsx" "src/app/(marketing)/layout.tsx"
git commit -m "fix(privacy): scope Vercel Analytics to marketing routes (off portal/staff, RA 10173)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 17: Full verification sweep

**Files:** none (verification only)

- [ ] **Step 1: Typecheck.** Run: `npm run typecheck` → Expected: PASS, 0 errors.
- [ ] **Step 2: Unit tests.** Run: `npm test` → Expected: PASS (≥ 267 tests; the 260 baseline + the new structured-data suite).
- [ ] **Step 3: Lint.** Run: `npm run lint` → Expected: clean (fix any new warnings introduced).
- [ ] **Step 4: Production build.** Run: `npm run build` → Expected: succeeds; `/physicians/[slug]` listed; no new build errors.
- [ ] **Step 5: JSON-LD structural validation.** With the dev server up, fetch each page type and confirm the expected `@type`s appear:
```bash
for u in / /physicians /all-services/routine /all-services/fbs; do echo "== $u =="; curl -s "localhost:3000$u" | grep -o '"@type":"[^"]*"' | sort -u; done
```
Expected: home → MedicalClinic, WebSite, FAQPage; a package → Service + Offer; a single test → Service (no Offer); a doctor page → Physician + BreadcrumbList. (Also note the Google Rich Results Test URL `https://search.google.com/test/rich-results` for the user's post-deploy spot-check.)
- [ ] **Step 6: Visual pass** @ 390px and 1440px: per-doctor page, linked directory + homepage specialist cards, `/schedule?doctor=<slug>` preselect.
- [ ] **Step 7: Confirm no analytics on gated surfaces** — `/portal` and `/staff` page source contains no `_vercel/insights`.

---

## Self-review notes

- **Spec coverage:** per-doctor pages (T6–T8), all JSON-LD types — MedicalClinic/WebSite/FAQPage (T9), Physician/Breadcrumb (T7), ItemList (T8), Service+Offer (T11) (T3 builders) — sitemap (T13), per-page metadata + homepage export (T8–T12), booking deep-link (T14) + conversion event (T15), analytics scoping (T16). All spec sections map to a task.
- **Prices:** only ever read from `service.price_php` and passed into the pure builder; Offer gated to `lab_package` (T3 test asserts both the present and absent cases).
- **No-PII:** conversion payload is `branch` + service count only (T15).
- **Names consistent:** `pageMetadata`, `medicalClinicLd`, `websiteLd`, `faqPageLd`, `physicianLd`, `physiciansItemListLd`, `breadcrumbLd`, `serviceOfferLd`, `listActivePhysicians`, `FAQ_ITEMS`, `JsonLd` used identically across tasks.
- **Pending user action:** verify the geo pin before merge (Task 1 candidate).
