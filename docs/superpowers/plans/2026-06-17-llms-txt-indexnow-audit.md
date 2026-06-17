# llms.txt / llms-full.txt + IndexNow Ping Audit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve `/llms.txt` + `/llms-full.txt` (AEO machine-readable site summaries) from existing marketing data, and make on-publish IndexNow pings verifiable in-app by audit-logging every ping (success + failure) and surfacing them on `/staff/admin/seo`.

**Architecture:** Mirror the codebase's pure-core/server-wrapper split (`indexnow-core.ts` ↔ `indexnow.ts`): a pure, vitest-tested `llms-core.ts` assembles markdown from plain data; a `server-only` `llms.ts` fetches via existing loaders and calls it; two route handlers serve the text (mirroring `indexnow-key.txt/route.ts`). IndexNow auditing is added at the single chokepoint `submitToIndexNow`, with an optional `actor` threaded from the 6 call sites; a pure `buildPingAuditMetadata` shapes the row and a pure `readPingAuditMetadata` reads it for the admin panel.

**Tech Stack:** Next.js 16 (App Router route handlers + RSC), TypeScript strict, Supabase (anon SSR client for reads, service-role for audit), vitest.

**Notes / decisions:**
- **No DB migration.** `audit_log.action` is free text (`src/lib/audit/log.ts` inserts arbitrary strings).
- **Dropped from spec:** the `robots.txt` "llms hint comment" — `MetadataRoute.Robots` cannot carry comment lines, and LLM crawlers locate `/llms.txt` by convention, not via robots. Negligible value, skipped.
- **RA 10173 guardrail:** both text files use only public marketing data (`services`, `physicians`, static site config, FAQ). No `patients`/`visits`/`results` reads.
- Run all commands from the worktree: `/Users/jamila/Claude/DRMed/.worktrees/llms-txt-indexnow-audit`.

---

### Task 1: Pure markdown core (`llms-core.ts`) + tests

**Files:**
- Create: `src/lib/seo/llms-core.ts`
- Test: `src/lib/seo/llms-core.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/seo/llms-core.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { formatPhp } from "@/lib/marketing/format";
import { buildLlmsTxt, buildLlmsFullTxt, type LlmsData } from "./llms-core";

const DATA: LlmsData = {
  site: {
    name: "DRMed Clinic & Laboratory",
    url: "https://drmed.ph",
    summary: "Clinic & lab in Quezon City.",
    address: "123 Test St, Quezon City, Metro Manila 1106, PH",
    phoneMobile: "0916 604 3208",
    phoneLandline: "(02) 8 355 3517",
    email: "drmedhealthcare@gmail.com",
    hours: "Monday – Saturday, 8 AM – 5 PM",
    mapUrl: "https://maps.app.goo.gl/abc",
    geo: { lat: 14.6705639, lng: 121.0389717 },
    social: { facebook: "https://facebook.com/drmed" },
  },
  services: [
    {
      code: "CBC",
      name: "Complete Blood Count",
      description: "Measures   red and white\ncells and platelets.",
      price_php: 350,
      hmo_price_php: 300,
      senior_discount_php: 70,
      turnaround_hours: 24,
      section: "hematology",
      fasting_required: false,
    },
  ],
  packages: [
    {
      code: "ROUTINE_PACKAGE",
      name: "Routine Package",
      price_php: 1299,
      group: "Basic & Routine",
      inclusions: ["CBC", "Urinalysis", "FBS"],
    },
  ],
  physicians: [
    {
      slug: "dr-jane-cruz",
      full_name: "Dr. Jane Cruz",
      specialty: "Internal Medicine",
      group_label: "Consultants",
      bio: "Board-certified internist with 10 years of experience.",
    },
  ],
  faq: [{ question: "Do I need to fast?", answer: "Only for FBS and lipids." }],
};

describe("buildLlmsTxt", () => {
  const out = buildLlmsTxt(DATA);

  it("starts with the H1 and a blockquote summary", () => {
    expect(out.startsWith("# DRMed Clinic & Laboratory\n")).toBe(true);
    expect(out).toContain("> Clinic & lab in Quezon City.");
  });

  it("includes contact, services, packages and physicians sections", () => {
    expect(out).toContain("## Visit & contact");
    expect(out).toContain("## Services");
    expect(out).toContain("## Health packages");
    expect(out).toContain("## Physicians");
  });

  it("renders absolute links and formatted prices", () => {
    expect(out).toContain("[Complete Blood Count](https://drmed.ph/all-services/cbc)");
    expect(out).toContain(formatPhp(350));
    expect(out).toContain("[Routine Package](https://drmed.ph/all-services/routine_package)");
    expect(out).toContain("[Dr. Jane Cruz](https://drmed.ph/physicians/dr-jane-cruz): Internal Medicine");
  });

  it("collapses whitespace in service one-liners (no raw newlines mid-line)", () => {
    expect(out).toContain("Measures red and white cells and platelets.");
  });

  it("leaks no patient-style fields", () => {
    expect(out.toLowerCase()).not.toContain("drm-");
    expect(out.toLowerCase()).not.toContain("pin");
    expect(out.toLowerCase()).not.toContain("patient");
  });
});

describe("buildLlmsFullTxt", () => {
  const out = buildLlmsFullTxt(DATA);

  it("includes the clinic profile with email, hours and geo", () => {
    expect(out).toContain("## Clinic profile");
    expect(out).toContain("drmedhealthcare@gmail.com");
    expect(out).toContain("Monday – Saturday, 8 AM – 5 PM");
    expect(out).toContain("14.6705639, 121.0389717");
  });

  it("renders full service detail with HMO/senior prices and turnaround", () => {
    expect(out).toContain("#### Complete Blood Count");
    expect(out).toContain(`HMO price: ${formatPhp(300)}`);
    expect(out).toContain(`Senior/PWD discount: ${formatPhp(70)}`);
    expect(out).toContain("Turnaround: 24 hours");
    expect(out).toContain("Fasting required: No");
  });

  it("groups packages and lists inclusions", () => {
    expect(out).toContain("### Basic & Routine");
    expect(out).toContain("Includes: CBC, Urinalysis, FBS");
  });

  it("renders physician bios and the FAQ", () => {
    expect(out).toContain("### Consultants");
    expect(out).toContain("Board-certified internist with 10 years of experience.");
    expect(out).toContain("## Frequently asked questions");
    expect(out).toContain("### Do I need to fast?");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/seo/llms-core.test.ts`
Expected: FAIL — `Failed to resolve import "./llms-core"` / module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/lib/seo/llms-core.ts`:

```ts
// Pure llms.txt / llms-full.txt builders — no `server-only` so vitest can
// import them. All data fetching lives in the server wrapper llms.ts.
import { formatPhp } from "@/lib/marketing/format";

export interface LlmsService {
  code: string;
  name: string;
  description: string | null;
  price_php: number;
  hmo_price_php: number | null;
  senior_discount_php: number | null;
  turnaround_hours: number | null;
  section: string | null;
  fasting_required: boolean;
}

export interface LlmsPackage {
  code: string;
  name: string;
  price_php: number;
  group: string;
  inclusions: string[];
}

export interface LlmsPhysician {
  slug: string;
  full_name: string;
  specialty: string;
  group_label: string | null;
  bio: string | null;
}

export interface LlmsFaq {
  question: string;
  answer: string;
}

export interface LlmsSite {
  name: string;
  url: string; // already trimmed (no trailing slash)
  summary: string;
  address: string;
  phoneMobile: string;
  phoneLandline: string;
  email: string;
  hours: string;
  mapUrl: string;
  geo: { lat: number; lng: number };
  social: { facebook?: string; instagram?: string; messenger?: string };
}

export interface LlmsData {
  site: LlmsSite;
  services: LlmsService[]; // non-package services only
  packages: LlmsPackage[];
  physicians: LlmsPhysician[];
  faq: LlmsFaq[];
}

/** Collapse all runs of whitespace (incl. newlines) into single spaces. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Single-line, length-capped form for the concise index. */
function oneLine(text: string | null, max = 140): string {
  if (!text) return "";
  const c = collapse(text);
  return c.length > max ? `${c.slice(0, max - 1).trimEnd()}…` : c;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const arr = map.get(k);
    if (arr) arr.push(item);
    else map.set(k, [item]);
  }
  return map;
}

const SECTION_LABELS: Record<string, string> = {
  chemistry: "Clinical Chemistry",
  hematology: "Hematology",
  immunology: "Immunology & Serology",
  urinalysis: "Urinalysis & Fecalysis",
  microbiology: "Microbiology",
  imaging_xray: "X-ray",
  imaging_ultrasound: "Ultrasound",
  imaging_ecg: "ECG",
  vaccine: "Vaccines",
  send_out: "Send-out tests",
  consultation: "Consultations",
  procedure: "Procedures",
  home_service: "Home service",
  package: "Packages",
  other: "Other services",
};

function humanizeSection(section: string): string {
  return (
    SECTION_LABELS[section] ??
    section.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

export function buildLlmsTxt(data: LlmsData): string {
  const { site } = data;
  const lines: string[] = [];

  lines.push(`# ${site.name}`, "");
  lines.push(`> ${site.summary}`, "");

  lines.push("## Visit & contact");
  lines.push(`- Address: ${site.address}`);
  lines.push(`- Phone: ${site.phoneMobile} / ${site.phoneLandline}`);
  lines.push(`- Hours: ${site.hours}`);
  lines.push(`- Book an appointment: ${site.url}/schedule`);
  lines.push(`- Map: ${site.mapUrl}`, "");

  lines.push("## Main pages");
  lines.push(`- [Services](${site.url}/all-services): full diagnostic & consultation menu`);
  lines.push(`- [Health packages](${site.url}/packages): bundled lab panels`);
  lines.push(`- [Physicians](${site.url}/physicians): doctors & specialties`);
  lines.push(`- [About](${site.url}/about)`);
  lines.push(`- [Contact](${site.url}/contact)`, "");

  if (data.services.length) {
    lines.push("## Services");
    for (const s of data.services) {
      const desc = oneLine(s.description) || s.name;
      lines.push(
        `- [${s.name}](${site.url}/all-services/${s.code.toLowerCase()}): ${desc} — ${formatPhp(s.price_php)}`,
      );
    }
    lines.push("");
  }

  if (data.packages.length) {
    lines.push("## Health packages");
    for (const p of data.packages) {
      const summary = p.inclusions.length ? p.inclusions.join(", ") : "bundled lab panel";
      lines.push(
        `- [${p.name}](${site.url}/all-services/${p.code.toLowerCase()}): ${summary} — ${formatPhp(p.price_php)}`,
      );
    }
    lines.push("");
  }

  if (data.physicians.length) {
    lines.push("## Physicians");
    for (const d of data.physicians) {
      lines.push(`- [${d.full_name}](${site.url}/physicians/${d.slug}): ${d.specialty}`);
    }
    lines.push("");
  }

  lines.push("## Optional");
  lines.push(`- [Privacy policy](${site.url}/privacy)`);
  lines.push(`- [Terms](${site.url}/terms)`, "");

  return lines.join("\n");
}

export function buildLlmsFullTxt(data: LlmsData): string {
  const { site } = data;
  const lines: string[] = [];

  lines.push(`# ${site.name} — Full reference`, "");
  lines.push(`> ${site.summary}`, "");

  lines.push("## Clinic profile");
  lines.push(`- Name: ${site.name}`);
  lines.push(`- Website: ${site.url}`);
  lines.push(`- Address: ${site.address}`);
  lines.push(`- Phone (mobile): ${site.phoneMobile}`);
  lines.push(`- Phone (landline): ${site.phoneLandline}`);
  lines.push(`- Email: ${site.email}`);
  lines.push(`- Hours: ${site.hours}`);
  lines.push(`- Location: ${site.geo.lat}, ${site.geo.lng} (${site.mapUrl})`);
  lines.push(`- Book an appointment: ${site.url}/schedule`);
  const socials = [
    site.social.facebook && `Facebook: ${site.social.facebook}`,
    site.social.instagram && `Instagram: ${site.social.instagram}`,
    site.social.messenger && `Messenger: ${site.social.messenger}`,
  ].filter(Boolean);
  if (socials.length) lines.push(`- Social: ${socials.join(" · ")}`);
  lines.push("");

  if (data.services.length) {
    lines.push("## Services", "");
    for (const [section, items] of groupBy(data.services, (s) => s.section ?? "other")) {
      lines.push(`### ${humanizeSection(section)}`);
      for (const s of items) {
        lines.push("", `#### ${s.name}`);
        lines.push(`- URL: ${site.url}/all-services/${s.code.toLowerCase()}`);
        lines.push(`- Price: ${formatPhp(s.price_php)}`);
        if (s.hmo_price_php != null) lines.push(`- HMO price: ${formatPhp(s.hmo_price_php)}`);
        if (s.senior_discount_php != null)
          lines.push(`- Senior/PWD discount: ${formatPhp(s.senior_discount_php)}`);
        if (s.turnaround_hours != null) lines.push(`- Turnaround: ${s.turnaround_hours} hours`);
        lines.push(`- Fasting required: ${s.fasting_required ? "Yes" : "No"}`);
        if (s.description) lines.push("", collapse(s.description));
      }
      lines.push("");
    }
  }

  if (data.packages.length) {
    lines.push("## Health packages", "");
    for (const [group, items] of groupBy(data.packages, (p) => p.group)) {
      lines.push(`### ${group}`);
      for (const p of items) {
        lines.push("", `#### ${p.name} — ${formatPhp(p.price_php)}`);
        lines.push(`- URL: ${site.url}/all-services/${p.code.toLowerCase()}`);
        if (p.inclusions.length) lines.push(`- Includes: ${p.inclusions.join(", ")}`);
      }
      lines.push("");
    }
  }

  if (data.physicians.length) {
    lines.push("## Physicians", "");
    for (const [group, items] of groupBy(data.physicians, (d) => d.group_label ?? "Physicians")) {
      lines.push(`### ${group}`);
      for (const d of items) {
        lines.push("", `#### ${d.full_name} — ${d.specialty}`);
        lines.push(`- URL: ${site.url}/physicians/${d.slug}`);
        if (d.bio) lines.push("", collapse(d.bio));
      }
      lines.push("");
    }
  }

  if (data.faq.length) {
    lines.push("## Frequently asked questions");
    for (const f of data.faq) {
      lines.push("", `### ${f.question}`, collapse(f.answer));
    }
    lines.push("");
  }

  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/seo/llms-core.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/seo/llms-core.ts src/lib/seo/llms-core.test.ts
git commit -m "feat(seo): pure llms.txt / llms-full.txt markdown builders"
```

---

### Task 2: Detailed physician loader + server wrapper (`llms.ts`)

**Files:**
- Modify: `src/lib/marketing/physicians.ts` (append a detailed loader)
- Create: `src/lib/seo/llms.ts`

No pure unit test (both are thin DB-fetching wrappers; verified by typecheck + build in Task 9 and the route smoke). The markdown logic they feed is already covered by Task 1.

- [ ] **Step 1: Add `listActivePhysiciansDetailed` to `physicians.ts`**

Append to `src/lib/marketing/physicians.ts` (after `listActivePhysicians`):

```ts
export interface PublicPhysicianDetail {
  slug: string;
  full_name: string;
  specialty: string;
  group_label: string | null;
  bio: string | null;
}

/** Active physicians with bio/specialty — for llms-full.txt. Public-readable per RLS. */
export async function listActivePhysiciansDetailed(): Promise<PublicPhysicianDetail[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("physicians")
    .select("slug, full_name, specialty, group_label, bio")
    .eq("is_active", true)
    .order("display_order", { ascending: true })
    .order("full_name", { ascending: true });
  if (error) {
    console.error("listActivePhysiciansDetailed failed", error);
    return [];
  }
  return data ?? [];
}
```

- [ ] **Step 2: Create the server wrapper `src/lib/seo/llms.ts`**

```ts
import "server-only";
import { SITE, CONTACT, GEO, SOCIAL } from "@/lib/marketing/site";
import { listActiveServices, listActivePackages } from "@/lib/marketing/services";
import { listActivePhysiciansDetailed } from "@/lib/marketing/physicians";
import { FAQ_ITEMS } from "@/lib/marketing/faq";
import { buildLlmsTxt, buildLlmsFullTxt, type LlmsData } from "./llms-core";

const SUMMARY =
  "Medical clinic & diagnostic laboratory in Quezon City, Metro Manila. Doctor consultations, lab tests, imaging, vaccines, and health packages. Patients book online and view released lab results in a secure portal.";

async function loadLlmsData(): Promise<LlmsData> {
  const base = SITE.url.replace(/\/$/, "");
  const [allServices, packages, physicians] = await Promise.all([
    listActiveServices(),
    listActivePackages(),
    listActivePhysiciansDetailed(),
  ]);

  return {
    site: {
      name: SITE.name,
      url: base,
      summary: SUMMARY,
      address: CONTACT.address.full,
      phoneMobile: CONTACT.phone.mobile,
      phoneLandline: CONTACT.phone.landline,
      email: CONTACT.email,
      hours: CONTACT.hours,
      mapUrl: GEO.mapUrl,
      geo: { lat: GEO.lat, lng: GEO.lng },
      social: {
        facebook: SOCIAL.facebook,
        instagram: SOCIAL.instagram,
        messenger: SOCIAL.messenger,
      },
    },
    // Packages are listed in their own section; exclude them from the flat service list.
    services: allServices
      .filter((s) => s.kind !== "lab_package")
      .map((s) => ({
        code: s.code,
        name: s.name,
        description: s.description,
        price_php: s.price_php,
        hmo_price_php: s.hmo_price_php,
        senior_discount_php: s.senior_discount_php,
        turnaround_hours: s.turnaround_hours,
        section: s.section,
        fasting_required: s.fasting_required,
      })),
    packages: packages.map((p) => ({
      code: p.code,
      name: p.name,
      price_php: p.price_php,
      group: p.group,
      inclusions: p.inclusions,
    })),
    physicians: physicians.map((d) => ({
      slug: d.slug,
      full_name: d.full_name,
      specialty: d.specialty,
      group_label: d.group_label,
      bio: d.bio,
    })),
    faq: FAQ_ITEMS.map((f) => ({ question: f.question, answer: f.answer })),
  };
}

export async function renderLlmsTxt(): Promise<string> {
  return buildLlmsTxt(await loadLlmsData());
}

export async function renderLlmsFullTxt(): Promise<string> {
  return buildLlmsFullTxt(await loadLlmsData());
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS (no errors). If `SOCIAL` keys differ from `facebook/instagram/messenger`, adjust the `social` mapping to match `src/lib/marketing/site.ts`.

- [ ] **Step 4: Commit**

```bash
git add src/lib/marketing/physicians.ts src/lib/seo/llms.ts
git commit -m "feat(seo): detailed physician loader + llms.txt server wrapper"
```

---

### Task 3: Route handlers for `/llms.txt` and `/llms-full.txt`

**Files:**
- Create: `src/app/llms.txt/route.ts`
- Create: `src/app/llms-full.txt/route.ts`

- [ ] **Step 1: Create `src/app/llms.txt/route.ts`** (mirrors `indexnow-key.txt/route.ts`)

```ts
import { renderLlmsTxt } from "@/lib/seo/llms";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const body = await renderLlmsTxt();
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
```

- [ ] **Step 2: Create `src/app/llms-full.txt/route.ts`**

```ts
import { renderLlmsFullTxt } from "@/lib/seo/llms";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const body = await renderLlmsFullTxt();
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
```

- [ ] **Step 3: Verify routes build**

Run: `npm run typecheck`
Expected: PASS. (Full runtime smoke happens in Task 9.)

- [ ] **Step 4: Commit**

```bash
git add "src/app/llms.txt/route.ts" "src/app/llms-full.txt/route.ts"
git commit -m "feat(seo): serve /llms.txt and /llms-full.txt route handlers"
```

---

### Task 4: Pure IndexNow audit metadata helpers + tests

**Files:**
- Modify: `src/lib/seo/indexnow-core.ts` (append two pure helpers)
- Modify: `src/lib/seo/indexnow-core.test.ts` (append cases)

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/seo/indexnow-core.test.ts`:

```ts
import { buildPingAuditMetadata, readPingAuditMetadata } from "./indexnow-core";

describe("buildPingAuditMetadata", () => {
  const urls = Array.from({ length: 25 }, (_, i) => `https://drmed.ph/p/${i}`);

  it("captures trigger, ok, submitted, urlCount and caps sampleUrls at 20", () => {
    const meta = buildPingAuditMetadata(
      { ok: true, submitted: 25 },
      { trigger: "physician.updated", payloadUrls: urls },
    );
    expect(meta).toEqual({
      trigger: "physician.updated",
      ok: true,
      submitted: 25,
      urlCount: 25,
      sampleUrls: urls.slice(0, 20),
    });
  });

  it("records failures", () => {
    const meta = buildPingAuditMetadata(
      { ok: false, submitted: 0 },
      { trigger: "manual.full", payloadUrls: ["https://drmed.ph/"] },
    );
    expect(meta).toMatchObject({ trigger: "manual.full", ok: false, submitted: 0, urlCount: 1 });
  });
});

describe("readPingAuditMetadata", () => {
  it("reads a well-formed row", () => {
    expect(
      readPingAuditMetadata({ trigger: "service.created", ok: true, urlCount: 3 }),
    ).toEqual({ trigger: "service.created", ok: true, urlCount: 3 });
  });

  it("defaults safely on missing/garbage metadata", () => {
    expect(readPingAuditMetadata(null)).toEqual({ trigger: "unknown", ok: false, urlCount: 0 });
    expect(readPingAuditMetadata("nope")).toEqual({ trigger: "unknown", ok: false, urlCount: 0 });
    expect(readPingAuditMetadata({ ok: "yes" })).toEqual({ trigger: "unknown", ok: false, urlCount: 0 });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/seo/indexnow-core.test.ts`
Expected: FAIL — `buildPingAuditMetadata`/`readPingAuditMetadata` are not exported.

- [ ] **Step 3: Append the helpers to `src/lib/seo/indexnow-core.ts`**

Add at the end of the file:

```ts
import type { Json } from "@/types/database";

const PING_SAMPLE_CAP = 20;

/** Shape the audit_log.metadata for one IndexNow ping. Pure. */
export function buildPingAuditMetadata(
  result: { ok: boolean; submitted: number },
  input: { trigger: string; payloadUrls: string[] },
): Json {
  return {
    trigger: input.trigger,
    ok: result.ok,
    submitted: result.submitted,
    urlCount: input.payloadUrls.length,
    sampleUrls: input.payloadUrls.slice(0, PING_SAMPLE_CAP),
  };
}

export interface PingAuditDisplay {
  trigger: string;
  ok: boolean;
  urlCount: number;
}

/** Read an IndexNow ping audit row's metadata for display. Defensive: JSON of unknown shape. */
export function readPingAuditMetadata(meta: unknown): PingAuditDisplay {
  // audit_log.metadata is Json; narrow defensively (it's display-only).
  const m = (meta && typeof meta === "object" ? meta : {}) as Record<string, unknown>;
  return {
    trigger: typeof m.trigger === "string" ? m.trigger : "unknown",
    ok: m.ok === true,
    urlCount: typeof m.urlCount === "number" ? m.urlCount : 0,
  };
}
```

> Note: `import type { Json }` is type-only (erased at runtime), so the pure module stays vitest-importable.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/seo/indexnow-core.test.ts`
Expected: PASS (existing cases + new cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/seo/indexnow-core.ts src/lib/seo/indexnow-core.test.ts
git commit -m "feat(seo): pure IndexNow ping audit metadata build/read helpers"
```

---

### Task 5: Audit every ping inside `submitToIndexNow`

**Files:**
- Modify: `src/lib/seo/indexnow.ts`

Verified by typecheck + build (Task 9); the row shape is unit-tested in Task 4.

- [ ] **Step 1: Update imports + signature in `src/lib/seo/indexnow.ts`**

Replace the import block (lines 1–9) and `IndexNowResult` + function signature. New top of file:

```ts
import "server-only";
import { SITE } from "@/lib/marketing/site";
import { reportError } from "@/lib/observability/report-error";
import { audit } from "@/lib/audit/log";
import {
  INDEXNOW_ENDPOINT,
  buildIndexNowPayload,
  buildPingAuditMetadata,
  indexNowEnabled,
} from "./indexnow-core";
import { buildSitemapEntries } from "./sitemap-entries";

export interface IndexNowResult {
  ok: boolean;
  submitted: number;
  skipped?: "disabled" | "no-urls";
}

export interface IndexNowActor {
  id: string;
  ip: string | null;
  ua: string | null;
}
```

- [ ] **Step 2: Replace the body of `submitToIndexNow` to thread `actor` and audit after a real attempt**

Replace the whole function (currently lines 22–68) with:

```ts
/**
 * Best-effort IndexNow submission. Never throws; failures go to reportError.
 * MUST be awaited by callers — Vercel can freeze the function before a
 * fire-and-forget request completes.
 *
 * After any real POST attempt (success OR failure) writes one
 * `seo.indexnow.ping` audit row so auto-pings are verifiable in-app. The
 * disabled (non-production) path writes nothing — no ping actually fires.
 */
export async function submitToIndexNow(
  urls: string[],
  opts: { trigger: string; actor?: IndexNowActor },
): Promise<IndexNowResult> {
  if (!indexNowEnabled(process.env as { VERCEL_ENV?: string; INDEXNOW_KEY?: string })) {
    return { ok: true, submitted: 0, skipped: "disabled" };
  }

  const base = SITE.url.replace(/\/$/, "");
  let host: string;
  try {
    host = new URL(base).host;
  } catch (error) {
    await reportError({ scope: "seo/indexnow", error, metadata: { trigger: opts.trigger, base } });
    return { ok: false, submitted: 0 };
  }

  // Non-null: indexNowEnabled() guarantees a non-empty key.
  const key = process.env.INDEXNOW_KEY as string;
  const keyLocation = `${base}/indexnow-key.txt`;
  const payload = buildIndexNowPayload({ urls, key, host, keyLocation });
  if (!payload) return { ok: true, submitted: 0, skipped: "no-urls" };

  const recordPing = async (result: IndexNowResult): Promise<void> => {
    await audit({
      actor_id: opts.actor?.id ?? null,
      actor_type: opts.actor ? "staff" : "system",
      action: "seo.indexnow.ping",
      resource_type: "seo",
      metadata: buildPingAuditMetadata(result, {
        trigger: opts.trigger,
        payloadUrls: payload.urlList,
      }),
      ip_address: opts.actor?.ip ?? null,
      user_agent: opts.actor?.ua ?? null,
    });
  };

  try {
    const res = await fetch(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      await reportError({
        scope: "seo/indexnow",
        error: new Error(`IndexNow responded ${res.status}`),
        metadata: { trigger: opts.trigger, count: payload.urlList.length, status: res.status },
      });
      const result: IndexNowResult = { ok: false, submitted: 0 };
      await recordPing(result);
      return result;
    }
    const result: IndexNowResult = { ok: true, submitted: payload.urlList.length };
    await recordPing(result);
    return result;
  } catch (error) {
    await reportError({
      scope: "seo/indexnow",
      error,
      metadata: { trigger: opts.trigger, count: payload.urlList.length },
    });
    const result: IndexNowResult = { ok: false, submitted: 0 };
    await recordPing(result);
    return result;
  }
}
```

(Leave `allSiteUrls()` unchanged.)

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/seo/indexnow.ts
git commit -m "feat(seo): audit every IndexNow ping (success + failure) at the chokepoint"
```

---

### Task 6: Thread the staff actor at the per-entity call sites

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/admin/physicians/actions.ts` (4 call sites)
- Modify: `src/app/(staff)/staff/(dashboard)/services/actions.ts` (2 call sites)

- [ ] **Step 1: Physicians — `createPhysicianAction`**

Replace:

```ts
  await submitToIndexNow(physicianPageUrls(SITE.url, created.slug), {
    trigger: "physician.created",
  });
```

with:

```ts
  await submitToIndexNow(physicianPageUrls(SITE.url, created.slug), {
    trigger: "physician.created",
    actor: { id: session.user_id, ip, ua },
  });
```

- [ ] **Step 2: Physicians — `updatePhysicianAction`**

Replace:

```ts
  await submitToIndexNow(
    [...slugs].flatMap((s) => physicianPageUrls(SITE.url, s)),
    { trigger: "physician.updated" },
  );
```

with:

```ts
  await submitToIndexNow(
    [...slugs].flatMap((s) => physicianPageUrls(SITE.url, s)),
    { trigger: "physician.updated", actor: { id: session.user_id, ip, ua } },
  );
```

- [ ] **Step 3: Physicians — `uploadPhotoAction`**

Replace:

```ts
  await submitToIndexNow(physicianPageUrls(SITE.url, physician.slug), {
    trigger: "physician.photo_updated",
  });
```

with:

```ts
  await submitToIndexNow(physicianPageUrls(SITE.url, physician.slug), {
    trigger: "physician.photo_updated",
    actor: { id: session.user_id, ip, ua },
  });
```

- [ ] **Step 4: Physicians — `deletePhysicianAction`**

Replace:

```ts
  await submitToIndexNow(physicianPageUrls(SITE.url, physician.slug), {
    trigger: "physician.deleted",
  });
```

with:

```ts
  await submitToIndexNow(physicianPageUrls(SITE.url, physician.slug), {
    trigger: "physician.deleted",
    actor: { id: session.user_id, ip, ua },
  });
```

- [ ] **Step 5: Services — `createServiceAction`**

The `h` (headers) and `session` are in scope. Replace:

```ts
  await submitToIndexNow(servicePageUrls(SITE.url, data.code), {
    trigger: "service.created",
  });
```

with:

```ts
  await submitToIndexNow(servicePageUrls(SITE.url, data.code), {
    trigger: "service.created",
    actor: {
      id: session.user_id,
      ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      ua: h.get("user-agent"),
    },
  });
```

- [ ] **Step 6: Services — `updateServiceAction`**

`h` is declared at the audit block above the submit (`const h = await headers();`) and `session` is in scope. Replace:

```ts
  await submitToIndexNow(
    [...codes].flatMap((c) => servicePageUrls(SITE.url, c)),
    { trigger: "service.updated" },
  );
```

with:

```ts
  await submitToIndexNow(
    [...codes].flatMap((c) => servicePageUrls(SITE.url, c)),
    {
      trigger: "service.updated",
      actor: {
        id: session.user_id,
        ip: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
        ua: h.get("user-agent"),
      },
    },
  );
```

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add "src/app/(staff)/staff/(dashboard)/admin/physicians/actions.ts" "src/app/(staff)/staff/(dashboard)/services/actions.ts"
git commit -m "feat(seo): attribute on-publish IndexNow pings to the staff actor"
```

---

### Task 7: Manual full-submit — pass actor, drop the redundant audit

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/admin/seo/actions.ts`

The unified `seo.indexnow.ping` row now covers the manual full-submit (`trigger: "manual.full"`), so the bespoke `seo.indexnow.full_submit` audit here is redundant. Remove it and pass the actor.

- [ ] **Step 1: Replace the file body**

Replace the whole of `resubmitAllToIndexNowAction` and drop the now-unused `audit` import. New file content:

```ts
"use server";

import { requireAdminStaff } from "@/lib/auth/require-admin";
import { ipAndAgent } from "@/lib/server/action-helpers";
import { reportError } from "@/lib/observability/report-error";
import { allSiteUrls, submitToIndexNow } from "@/lib/seo/indexnow";

export type ResubmitResult =
  | { ok: true; data: { submitted: number; total: number; skipped: string | null } }
  | { ok: false; error: string };

export async function resubmitAllToIndexNowAction(): Promise<ResubmitResult> {
  const session = await requireAdminStaff();

  let urls: string[];
  try {
    urls = await allSiteUrls();
  } catch (error) {
    await reportError({ scope: "seo/indexnow", error, metadata: { trigger: "manual.full" } });
    return { ok: false, error: "Could not build the page list. Check the server logs." };
  }

  // submitToIndexNow writes the `seo.indexnow.ping` audit row itself (trigger
  // "manual.full"), so no separate audit() call is needed here.
  const { ip, ua } = await ipAndAgent();
  const res = await submitToIndexNow(urls, {
    trigger: "manual.full",
    actor: { id: session.user_id, ip, ua },
  });

  if (!res.ok) {
    return { ok: false, error: "IndexNow submission failed. Check the server logs." };
  }
  return {
    ok: true,
    data: { submitted: res.submitted, total: urls.length, skipped: res.skipped ?? null },
  };
}
```

- [ ] **Step 2: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS (no unused-import error for `audit`).

```bash
git add "src/app/(staff)/staff/(dashboard)/admin/seo/actions.ts"
git commit -m "refactor(seo): manual full-submit uses unified ping audit (drop duplicate row)"
```

---

### Task 8: "Recent IndexNow submissions" panel on `/staff/admin/seo`

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/admin/seo/page.tsx`

- [ ] **Step 1: Add imports**

At the top of `page.tsx`, add to the existing imports:

```ts
import { createAdminClient } from "@/lib/supabase/admin";
import { indexNowEnabled, readPingAuditMetadata } from "@/lib/seo/indexnow-core";
```

(Replace the existing `import { indexNowEnabled } from "@/lib/seo/indexnow-core";` line with the combined import above.)

- [ ] **Step 2: Fetch recent pings + a Manila time formatter**

After `const urls = await allSiteUrls();` add:

```ts
  const admin = createAdminClient();
  const { data: recentPings } = await admin
    .from("audit_log")
    .select("id, created_at, metadata")
    .eq("action", "seo.indexnow.ping")
    .order("created_at", { ascending: false })
    .limit(25);

  const fmtManila = (iso: string) =>
    new Intl.DateTimeFormat("en-PH", {
      timeZone: "Asia/Manila",
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
```

- [ ] **Step 3: Render the panel**

Replace the closing of the component — the trailing note paragraph and `</div>`:

```tsx
      <p className="mt-4 text-xs text-[color:var(--color-brand-text-soft)]">
        Use this once after setting the key, or to re-seed every page (for
        example after a content update). Every full submit is recorded in the
        audit log.
      </p>
    </div>
  );
}
```

with:

```tsx
      <p className="mt-4 text-xs text-[color:var(--color-brand-text-soft)]">
        Use this once after setting the key, or to re-seed every page (for
        example after a content update). Every full submit is recorded in the
        audit log.
      </p>

      <section className="mt-8">
        <h2 className="font-heading text-lg font-bold text-[color:var(--color-brand-navy)]">
          Recent IndexNow submissions
        </h2>
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          Every automatic ping (when a doctor or service is added or changed) and
          every full submit is recorded here.
        </p>
        {recentPings && recentPings.length > 0 ? (
          <div className="mt-3 overflow-x-auto rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white">
            <table className="w-full min-w-[32rem] text-sm">
              <thead>
                <tr className="border-b border-[color:var(--color-brand-bg-mid)] text-left text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                  <th className="px-3 py-2 font-semibold">Time</th>
                  <th className="px-3 py-2 font-semibold">Trigger</th>
                  <th className="px-3 py-2 font-semibold">URLs</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody>
                {recentPings.map((row) => {
                  const m = readPingAuditMetadata(row.metadata);
                  return (
                    <tr
                      key={row.id}
                      className="border-b border-[color:var(--color-brand-bg-mid)] last:border-0"
                    >
                      <td className="whitespace-nowrap px-3 py-2">{fmtManila(row.created_at)}</td>
                      <td className="px-3 py-2 font-mono text-xs">{m.trigger}</td>
                      <td className="px-3 py-2">{m.urlCount}</td>
                      <td className="px-3 py-2">
                        <span
                          className={
                            m.ok ? "font-semibold text-green-700" : "font-semibold text-red-700"
                          }
                        >
                          {m.ok ? "OK" : "Failed"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 rounded-lg border border-dashed border-[color:var(--color-brand-bg-mid)] p-4 text-sm text-[color:var(--color-brand-text-soft)]">
            No IndexNow pings recorded yet.
          </p>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS. (`row.created_at` is `string`; `row.metadata` is `Json`, accepted by `readPingAuditMetadata(meta: unknown)`.)

```bash
git add "src/app/(staff)/staff/(dashboard)/admin/seo/page.tsx"
git commit -m "feat(seo): show recent IndexNow submissions on the SEO admin page"
```

---

### Task 9: Full gate + route smoke + final verification

**Files:** none (verification only)

- [ ] **Step 1: Lint + typecheck + unit tests**

Run: `npm run typecheck && npm run lint && npm test`
Expected: typecheck clean, lint clean, all tests pass (303 existing + new llms-core + indexnow-core ping cases).

- [ ] **Step 2: Production build**

Run: `npm run build`
Expected: build succeeds; `/llms.txt` and `/llms-full.txt` appear as routes (dynamic `ƒ`), no type/route errors.

- [ ] **Step 3: Runtime smoke of the two routes**

Start dev server in the background and curl both routes:

```bash
npm run dev &
sleep 8
curl -s -i http://localhost:3000/llms.txt | head -20
echo "----- FULL -----"
curl -s http://localhost:3000/llms-full.txt | head -40
kill %1
```

Expected: `200`, `Content-Type: text/plain; charset=utf-8`, the `# DRMed Clinic & Laboratory` H1, the contact block, real services/packages/physicians with `₱` prices, and (full) the clinic profile + FAQ. Confirm **no** patient data appears.

> If `.env.local` points at remote Supabase, the routes render real data. If the dev server can't reach the DB, the loaders return `[]` and the files still render the static header/contact sections — that's acceptable for the smoke; the data path is covered by the Task 1 unit tests.

- [ ] **Step 4: Self-review the diff**

Run: `git diff origin/main --stat` and skim `git diff origin/main`.
Confirm: only the intended files changed; no stray `console.log`; no service-role key usage outside `admin.ts`; no patient data in the text builders.

- [ ] **Step 5: Final no-op commit check**

Run: `git status` — working tree clean, all work committed across Tasks 1–8.

---

## Self-Review (plan vs spec)

**Spec coverage:**
- llms.txt + llms-full.txt files → Tasks 1–3. ✅
- Comprehensive llms-full content (services w/ prices+prep+turnaround, packages w/ inclusions, physician bios, FAQ, NAP/geo) → Task 1 `buildLlmsFullTxt` + Task 2 wrapper. ✅
- Pure-core/server-wrapper split + route pattern → Tasks 1/2/3. ✅
- Audit successful pings at chokepoint + actor rule (present⇒staff / absent⇒system) → Task 5. ✅
- Failures audited too (kept in Sentry) → Task 5. ✅
- Skip audit on `disabled` → Task 5. ✅
- De-dupe manual full-submit → Task 7. ✅
- Per-entity call sites pass actor → Task 6. ✅
- "Recent IndexNow submissions" panel → Task 8. ✅
- RA 10173 zero-patient-data + no migration → enforced in Task 1/2 design + Task 9 review. ✅
- Tests for llms-core + ping metadata → Tasks 1 & 4. ✅
- Dropped: robots.txt hint (documented in Notes). ✅

**Type consistency:** `LlmsData`/`LlmsSite`/`LlmsService`/`LlmsPackage`/`LlmsPhysician`/`LlmsFaq` defined in Task 1, consumed identically in Task 2. `IndexNowActor` defined in Task 5, used identically in Tasks 6–7. `buildPingAuditMetadata(result, input)` / `readPingAuditMetadata(meta)` / `PingAuditDisplay` defined in Task 4, used in Tasks 5 & 8. `submitToIndexNow(urls, { trigger, actor? })` signature consistent across Tasks 5–7.

**Placeholder scan:** none — every code step is complete.
