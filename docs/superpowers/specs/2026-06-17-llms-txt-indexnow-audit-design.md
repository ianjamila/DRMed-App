# llms.txt / llms-full.txt + IndexNow ping audit — Design

**Date:** 2026-06-17
**Status:** Approved (brainstorm) — pending spec review
**Branch:** `feat/llms-txt-indexnow-audit` (off `origin/main` @ `db44fdd`)
**Tier:** SEO/AEO Tier 2, feature 1 of 3 (see `project_seo_aeo_roadmap`)

## Goal

Two independent-but-related deliverables, shipped in one PR:

1. **`/llms.txt` + `/llms-full.txt`** — machine-readable, markdown summaries of the
   public site, following the [llmstxt.org](https://llmstxt.org) convention, so AI
   answer engines (ChatGPT, Perplexity, Claude, Gemini) can describe DRMed
   accurately. Reuses existing `SITE`/services/physicians data and the
   `src/lib/seo` helpers.
2. **Audit-log successful IndexNow pings** — today only *failures* are recorded
   (to Sentry via `reportError`), so on-publish auto-pings are invisible in-app.
   Record every ping (success **and** failure) as an `audit_log` row and surface a
   "Recent IndexNow submissions" panel on `/staff/admin/seo`, so staff can verify
   auto-pings are firing.

**Non-goals:** no DB migration, no auth/RLS/payment changes, no changes to the
IndexNow *trigger* logic (when/where pings fire is already correct from #81/#83).

## Context (existing surfaces reused)

- **`src/lib/marketing/site.ts`** — `SITE` (name/url/locale), `CONTACT` (NAP,
  phones, email, hours), `GEO` (lat/lng/mapUrl), `SOCIAL`. Single source of truth.
- **`src/lib/marketing/services.ts`** — `listActiveServices()` →
  `PublicService[]` (code, name, description, price_php, hmo_price_php,
  senior_discount_php, turnaround_hours, kind, section, fasting_required, …);
  `listActivePackages()` → `PackageWithGroup[]` (adds `group` + derived
  `inclusions[]`).
- **`src/lib/marketing/physicians.ts`** — `listActivePhysicians()` returns only
  slug/full_name/updated_at. The `physicians` table also has `specialty`,
  `group_label`, `bio` (used by `/physicians/[slug]`). A **new**
  `listActivePhysiciansDetailed()` will select these (public-readable per RLS).
- **`src/lib/marketing/faq.ts`** — marketing FAQ items (already feed `faqPageLd`).
- **`src/lib/seo/sitemap-entries.ts`** — `buildSitemapEntries()`, the canonical
  public URL set (shared by `sitemap.ts` + IndexNow full-submit).
- **`src/lib/seo/indexnow.ts`** — `submitToIndexNow(urls, { trigger })`. Failures
  → `reportError` (Sentry). Successes → silent return `{ ok, submitted }`. The
  single chokepoint all callers funnel through.
- **`src/lib/seo/indexnow-core.ts`** — pure helpers (vitest-imported).
- **`src/lib/audit/log.ts`** — `audit(entry)`; `audit_log.action` is a free-text
  string (no enum/migration needed). `actor_type: 'staff' | 'system' | …`.
- **`src/app/indexnow-key.txt/route.ts`** — proven pattern for a plaintext route
  (directory named `*.txt` + `route.ts` exporting `GET` → raw `Response`).
- **`src/app/(staff)/staff/(dashboard)/admin/seo/`** — `page.tsx`
  (`force-dynamic`) + `actions.ts` (`resubmitAllToIndexNowAction`, which already
  audits `seo.indexnow.full_submit`).
- IndexNow ping call sites: `admin/physicians/actions.ts` (create/update/
  uploadPhoto/delete), `services/actions.ts` (create/update), `admin/seo/
  actions.ts` (manual full). All already have `session` + IP/UA in scope.

## A. llms.txt / llms-full.txt

### Files

| File | Purpose |
|---|---|
| `src/lib/seo/llms-core.ts` | **Pure**, no `server-only`. `buildLlmsTxt(data)` + `buildLlmsFullTxt(data)` take plain data objects → return markdown strings. Vitest-testable. |
| `src/lib/seo/llms.ts` | **`server-only`** wrapper. Fetches data via existing loaders + `listActivePhysiciansDetailed()`, calls the core. `renderLlmsTxt()` / `renderLlmsFullTxt()`. |
| `src/app/llms.txt/route.ts` | `GET` → `text/plain; charset=utf-8`, cached header. Mirrors `indexnow-key.txt`. |
| `src/app/llms-full.txt/route.ts` | Same, full variant. |
| `src/lib/marketing/physicians.ts` | Add `listActivePhysiciansDetailed()` (slug, full_name, specialty, group_label, bio). |

The pure-core / server-wrapper split mirrors `indexnow-core.ts` ↔ `indexnow.ts`.

### Rendering & caching

Match `sitemap.ts`: reuse the existing cookie-based marketing loaders (route
renders dynamically) and cache at the CDN via headers:
`Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400`. Simpler than
an anon-ISR client and consistent with the sitemap; fine for two low-traffic
files. **Not** `noindex` — these files are *meant* to be crawled by LLMs.

All links are **absolute** URLs (`SITE.url` + path), per the llmstxt.org spec.

### `llms.txt` (concise index)

```
# DRMed Clinic & Laboratory

> Medical clinic & diagnostic laboratory in Quezon City, Metro Manila.
> Doctor consultations, lab tests, imaging, vaccines, and health packages.
> Patients book online and view released lab results in a secure portal.

## Visit & contact
- Address: <CONTACT.address.full>
- Phone: <mobile> / <landline>
- Hours: <CONTACT.hours>
- Book an appointment: <SITE.url>/schedule
- Map: <GEO.mapUrl>

## Main pages
- [Services](<url>/all-services): full diagnostic & consultation menu
- [Health packages](<url>/packages): bundled lab panels
- [Physicians](<url>/physicians): doctors & specialties
- [About](<url>/about)
- [Contact](<url>/contact)

## Services
- [<name>](<url>/all-services/<code>): <one-line desc> — ₱<price>
  … (all active non-package services)

## Health packages
- [<name>](<url>/all-services/<code>): <inclusions summary> — ₱<price>

## Physicians
- [<full_name>](<url>/physicians/<slug>): <specialty>

## Optional
- [Privacy policy](<url>/privacy)
- [Terms](<url>/terms)
```

### `llms-full.txt` (comprehensive)

Same skeleton, expanded (approved: "Everything"):

- **Clinic profile** — full NAP, hours, geo coordinates + map, social links.
- **Services** — grouped by `section`, each with full description, regular / HMO /
  senior price, fasting requirement, turnaround hours.
- **Packages** — grouped by `group`, each with full inclusion list + price.
- **Physicians** — grouped by `group_label`, each with specialty + full bio.
- **FAQ** — the marketing FAQ as Q&A.

**RA 10173 guardrail:** both files contain **public marketing data only — zero
patient data**. Sources are `services` / `physicians` (public-readable) + static
site config; no `patients`, `visits`, `results`, or `audit_log` reads.

## B. IndexNow ping audit

### Architecture (chosen: single chokepoint)

Extend `submitToIndexNow` with an optional actor and audit inside it:

```ts
submitToIndexNow(
  urls: string[],
  opts: { trigger: string; actor?: { id: string; ip: string | null; ua: string | null } },
): Promise<IndexNowResult>
```

`actor` present ⇒ a staff-triggered ping (`actor_type: 'staff'`, `id` required);
`actor` absent ⇒ system-triggered (`actor_type: 'system'`, `actor_id: null`).

After a **real POST attempt** (enabled + non-empty payload), write exactly one
`audit_log` row:

- `actor_id`: `opts.actor?.id ?? null`
- `actor_type`: `opts.actor ? 'staff' : 'system'`
- `action`: `'seo.indexnow.ping'`
- `resource_type`: `'seo'`
- `metadata`: `{ trigger, ok, submitted, urlCount, sampleUrls }` (sampleUrls =
  first ~20 of the payload's deduped list)
- `ip_address` / `user_agent`: from `opts.actor`

Rules:
- **Successes** → audit row (`ok: true`). *(new behavior — the headline change)*
- **Failures** → keep `reportError`/Sentry **and** add the audit row (`ok: false`),
  so failures are visible both in Sentry and in-app.
- **`skipped: "disabled"`** (preview/local, no real ping) → **no** audit row
  (avoids noise off-production).
- **`skipped: "no-urls"`** (enabled but payload empty) → no audit row (nothing
  happened).

The metadata shape is built by a small **pure** helper
`buildPingAuditMetadata(result, { trigger, payloadUrls })` in `indexnow-core.ts`
(or a sibling) so it is unit-testable without a DB.

### Call-site updates

- `admin/physicians/actions.ts` (×4), `services/actions.ts` (×2): pass
  `actor: { id: session.user_id, ip, ua }` (already in scope via `ipAndAgent()` /
  `headers()`).
- `admin/seo/actions.ts` (`resubmitAllToIndexNowAction`): pass the staff actor and
  **remove** its now-redundant bespoke `seo.indexnow.full_submit` audit — the
  unified `seo.indexnow.ping` row with `trigger: 'manual.full'` replaces it
  (prevents double-logging; the trigger preserves the distinction).

No migration: `audit_log.action` is free text.

## C. Verifiable-in-app panel

On `/staff/admin/seo/page.tsx`, add a **"Recent IndexNow submissions"** section:

- Server-side query `audit_log` where `action = 'seo.indexnow.ping'`, order by
  `created_at` desc, limit ~25 (via the admin/service-role client already used on
  staff pages, or the server client — match the page's existing data access).
- Render a table reusing the page's existing card/table styling:
  **Time (Manila, via `manila.ts` helpers) · Trigger · URLs (urlCount) · Status**
  (ok = green badge / failed = red badge).
- Empty state: "No IndexNow pings recorded yet."

## D. Testing & verification

- **Vitest — `llms-core.ts`** (pure): asserts H1 + blockquote + each section
  header present; a representative service / package / physician / FAQ entry
  renders; prices formatted (`₱` + grouping); link URLs are absolute; **no
  patient-style fields** appear. Both `buildLlmsTxt` and `buildLlmsFullTxt`.
- **Vitest — `buildPingAuditMetadata`** (pure): success / failure / shape +
  sampleUrls cap.
- Existing `indexnow-core.test.ts` stays green.
- **Full gate:** `npm run typecheck` + `npm run lint` + `npm test` +
  `npm run build`.
- **Manual smoke:** `curl localhost:3000/llms.txt` and `/llms-full.txt` against
  `npm run dev`; eyeball structure + that prices/bios render. (DB-runtime smoke of
  the audit panel is optional — the audit write path is exercised by the pure
  metadata test; the panel is a read of existing rows.)

## E. Also worth doing (cheap; in this PR unless pruned)

- Add a `# llms.txt` / `# llms-full.txt` hint comment to `robots.txt` for
  discoverability (LLM crawlers + humans inspecting robots).

Deferred / out of scope: adding the `.txt` files to the sitemap (unconventional);
a per-page "ping now" button (already covered by the manual full-submit).

## File inventory

**New:**
- `src/lib/seo/llms-core.ts`
- `src/lib/seo/llms.ts`
- `src/lib/seo/llms-core.test.ts`
- `src/app/llms.txt/route.ts`
- `src/app/llms-full.txt/route.ts`

**Modified:**
- `src/lib/marketing/physicians.ts` (+ `listActivePhysiciansDetailed`)
- `src/lib/seo/indexnow.ts` (audit on ping; `actor` opt)
- `src/lib/seo/indexnow-core.ts` (+ `buildPingAuditMetadata`)
- `src/lib/seo/indexnow-core.test.ts` (+ metadata cases) — or new test file
- `src/app/(staff)/staff/(dashboard)/admin/physicians/actions.ts` (pass actor)
- `src/app/(staff)/staff/(dashboard)/services/actions.ts` (pass actor)
- `src/app/(staff)/staff/(dashboard)/admin/seo/actions.ts` (pass actor; drop bespoke audit)
- `src/app/(staff)/staff/(dashboard)/admin/seo/page.tsx` (+ recent-submissions panel)
- `src/app/robots.ts` (llms hint comment)
