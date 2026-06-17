# IndexNow — instant re-crawl for drmed.ph

**Date:** 2026-06-17
**Branch:** `feat/indexnow-instant-crawl`
**Status:** Design — awaiting user review

## Summary

Add [IndexNow](https://www.indexnow.org/) to drmed.ph so that when a physician
or service is published/updated through the staff portal, the affected public
URLs are pushed to participating search engines for near-instant re-crawl —
instead of waiting for the next scheduled crawl. A small admin page provides a
one-click "re-submit everything" action for first-time setup and content
re-seeding.

This is **Tier 2** of the accepted SEO/AEO roadmap (sits on top of the shipped
Tier 1: per-doctor pages, structured data, sitemap, metadata).

## Goals

- When admin content that maps to a public URL changes, ping IndexNow with just
  the affected URL(s) so engines re-crawl promptly.
- Serve the IndexNow verification key from a single source of truth (env var),
  with nothing secret committed to the repo.
- Provide an admin-triggered full-site re-submit for bootstrap and re-seeding.
- Be **best-effort**: an IndexNow failure must never break a staff save, and must
  never ping real engines from preview/local environments.

## Non-goals

- **No Google submission.** Google does not participate in IndexNow; it keeps
  receiving changes via `sitemap.xml` + Search Console, unchanged. This is noted
  in code/spec so the absence is not mistaken for a bug.
- **No diff-based cron.** Rejected: needs persistent state, adds up to a day of
  latency, and repeatedly re-submitting unchanged URLs on a schedule is contrary
  to IndexNow guidance. The on-publish hooks + manual button cover the realistic
  cases.
- **No auto-ping on deploy** (static-page content changes on deploy). Covered on
  demand by the manual full-submit button; a fully automatic version is listed
  under Future work because it needs a deploy-completion trigger.
- No new database tables, migrations, or RLS changes.

## Background: the IndexNow protocol

- Submission is a single `POST https://api.indexnow.org/indexnow` with a JSON
  body `{ host, key, keyLocation, urlList }`. That shared endpoint **fans the
  submission out to all participating engines** — Bing (which also powers
  **Microsoft Copilot** and **DuckDuckGo** results), Yandex, Seznam, Naver, Yep.
  We do **not** POST to each engine separately.
- Up to 10,000 URLs per request (we submit 1–3 at a time on publish; the full
  site is well under the cap).
- **Verification:** the engine fetches the key file and checks its content equals
  the submitted `key`. The key file must live at a URL path that is a *parent of
  every submitted URL*. Because all our public URLs are root-level
  (`/physicians/...`, `/all-services/...`, etc.), the key file must be served at
  **root** — not under `/.well-known/` or `/api/`.
- The IndexNow key is **public by design** (it travels in every request and sits
  at a public URL). "Secret" is not a concern; single-source-of-truth and easy
  rotation are.

## RA 10173 / privacy

IndexNow only ever receives **public marketing URLs** (physician pages, service
pages, static marketing pages — exactly the sitemap set). No PII, no portal/staff
URLs (those are `disallow`ed in `robots.ts` and never built into the URL list).
The key file contains only the public key. Nothing here touches patient data.

## Architecture

### Components

| Component | File | Responsibility |
|---|---|---|
| Pure core (tested) | `src/lib/seo/indexnow-core.ts` | Endpoint constant, URL builders, payload builder, gating predicate. **No `server-only`** so vitest can import it. |
| Server wrapper | `src/lib/seo/indexnow.ts` | `submitToIndexNow()` (fetch + `reportError`), `allSiteUrls()`. Imports `server-only`. |
| Shared sitemap source | `src/lib/seo/sitemap-entries.ts` | `buildSitemapEntries()` — the one source of truth for the site URL set. |
| Key file route | `src/app/indexnow-key.txt/route.ts` | Serves `INDEXNOW_KEY` as `text/plain` at `/indexnow-key.txt`. |
| Admin page | `src/app/(staff)/staff/(dashboard)/admin/seo/page.tsx` | Status + full re-submit button. |
| Admin action | `.../admin/seo/actions.ts` | `resubmitAllToIndexNowAction`. |
| Admin button | `.../admin/seo/resubmit-button.tsx` | Client button calling the action, shows result. |

> **Why split core vs wrapper:** `reportError` and `audit` both `import "server-only"`,
> and the repo's test rule is that unit-tested modules must not import `server-only`.
> Keeping the pure logic in `indexnow-core.ts` lets vitest cover it while the
> network/observability glue stays in the server-only `indexnow.ts`.

### `indexnow-core.ts` (pure, unit-tested)

- `INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow"`.
- `indexNowEnabled(env)` — returns true only when `env.VERCEL_ENV === "production"`
  **and** `env.INDEXNOW_KEY` is a non-empty string. Gating is a pure function of
  injected env so it can be tested both ways.
- `physicianPageUrls(base, slug)` → `["{base}/physicians/{slug}", "{base}/physicians"]`.
- `servicePageUrls(base, code)` → `["{base}/all-services/{code-lowercased}", "{base}/all-services", "{base}/packages"]`
  (matches the existing sitemap's `s.code.toLowerCase()` convention).
- `buildIndexNowPayload({ urls, key, host, keyLocation })` →
  `{ host, key, keyLocation, urlList }` after: dedupe, keep only `http(s)://{host}`
  URLs, trim, cap at 10,000. Returns `null` when the filtered list is empty.

### `indexnow.ts` (server-only wrapper)

- `submitToIndexNow(urls: string[], opts: { trigger: string }): Promise<{ ok: boolean; submitted: number; skipped?: string }>`
  1. Compute `base = SITE.url` (no trailing slash), `host`, `keyLocation = "{base}/indexnow-key.txt"`.
  2. If `!indexNowEnabled(process.env)` → return `{ ok: true, submitted: 0, skipped: "disabled" }` (no network).
  3. `buildIndexNowPayload(...)`; if `null` → return `{ ok: true, submitted: 0, skipped: "no-urls" }`.
  4. `await fetch(INDEXNOW_ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body })`.
     Treat non-2xx as failure.
  5. On any throw / non-2xx → `await reportError({ scope: "seo/indexnow", error, metadata: { trigger, count } })`,
     return `{ ok: false, submitted: 0 }`. **Never throws.**
  - Must be **awaited** by callers (Vercel serverless can freeze the function
    before a fire-and-forget request completes).
- `allSiteUrls(): Promise<string[]>` → `(await buildSitemapEntries()).map(e => e.url)`.

### `sitemap-entries.ts` (small refactor)

Move the body of `src/app/sitemap.ts` into
`buildSitemapEntries(): Promise<MetadataRoute.Sitemap>`. `sitemap.ts` becomes a
thin wrapper that returns `buildSitemapEntries()`. `allSiteUrls()` reuses the same
function, so the full-submit URL set cannot drift from the real sitemap.

### Key file route — `/indexnow-key.txt`

- `GET` returns `process.env.INDEXNOW_KEY` as `text/plain; charset=utf-8` with a
  `Cache-Control: public, max-age=3600` header.
- If the env var is unset/empty → `404` (never serve an empty key file).
- **Implementation note:** confirm Next 16 App Router accepts the dotted route
  segment folder `indexnow-key.txt/` (read the bundled docs in
  `node_modules/next/dist/docs/` per AGENTS.md before writing it). Fallback if a
  dotted segment is rejected: a guarded single-segment root route
  (`src/app/[seoKeyFile]/route.ts`) that returns the key only when the segment
  equals `indexnow-key.txt`, else `notFound()`.

## On-publish hooks (primary trigger)

A `await submitToIndexNow(...)` call is added after each successful write and
**before** the existing `redirect()` (the helper never throws, so it cannot
interfere with the redirect). Adds ~one fast round-trip of latency to a save in
production; no-ops instantly elsewhere.

**Physicians — `admin/physicians/actions.ts`:**
- `createPhysicianAction` → `physicianPageUrls(base, created.slug)`, trigger `physician.created`.
- `updatePhysicianAction` → **pre-read the prior slug** (one extra `select`); ping
  the new slug, plus the old slug if it changed (so the stale URL is re-crawled).
  Trigger `physician.updated`.
- `uploadPhotoAction` → `physicianPageUrls(base, physician.slug)` (slug already
  read), trigger `physician.photo_updated`.
- `deletePhysicianAction` → `physicianPageUrls(base, physician.slug)`, trigger
  `physician.deleted` (submitting a now-404 URL signals removal to engines).
- Deactivation via the Active toggle is an `update`, so it's covered by the update
  hook (engine re-crawls, gets a 404, drops the page).

**Services — `services/actions.ts`:**
- `createServiceAction` → `servicePageUrls(base, data.code)`, trigger `service.created`.
- `updateServiceAction` → extend the existing prior-read `select` to also fetch
  `code`; ping the new code, plus the old code if it changed. Trigger
  `service.updated`. (Covers the Active toggle; services have no delete action.)

The homepage (`/`) is **not** pinged on service/physician edits — its service/
package highlights are hardcoded in `SITE` config, not read from the DB.

## Manual full-submit — `/staff/admin/seo`

Admin-only page (`requireAdminStaff`) that shows:
- Whether `INDEXNOW_KEY` is configured.
- Whether submissions are live here (`VERCEL_ENV === "production"`) — on preview/
  local it shows "submissions are disabled outside production".
- The `keyLocation` URL (`{SITE.url}/indexnow-key.txt`) to copy into Bing
  Webmaster Tools during setup.
- The count of URLs a full submit would send.
- A **"Re-submit all pages now"** button.

`resubmitAllToIndexNowAction` (`requireAdminStaff`):
1. `const urls = await allSiteUrls();`
2. `const res = await submitToIndexNow(urls, { trigger: "manual.full" });`
3. `audit({ actor_type: "staff", actor_id, action: "seo.indexnow.full_submit", resource_type: "seo", metadata: { count: urls.length, ok: res.ok, skipped: res.skipped ?? null } })`.
4. Return `{ ok, data: { submitted, skipped } } | { ok: false, error }` per the
   Server Action return-shape convention.

**Nav:** add one item to the **Admin** section of
`src/components/staff/staff-nav-config.ts` — `{ href: "/staff/admin/seo", label:
"Search engines (IndexNow)", description: "Push new/changed pages to Bing,
Yandex & others for faster indexing.", roles: ["admin"] }`.

## Error handling & observability

- All IndexNow failures (publish hooks and manual) → `reportError({ scope:
  "seo/indexnow", ... })` (stdout + Sentry + a low-severity audit row in prod).
- The manual full-submit additionally writes a `seo.indexnow.full_submit` audit
  row (it's an explicit admin action).
- On-publish pings do **not** write a separate audit row — the publish event is
  already audited; failures still surface via `reportError`.

## Environment & ops setup

Add to `.env.example` (and Vercel **Production**):

```
# IndexNow — instant search-engine re-crawl (Bing, Yandex, etc.; not Google).
# Public verification key (NOT a secret). Generate once: openssl rand -hex 16
# Served at https://drmed.ph/indexnow-key.txt. Submissions only fire when
# VERCEL_ENV=production AND this is set; preview/local no-op.
INDEXNOW_KEY=
```

One-time operator steps (documented in the spec / PR body):
1. Generate a key, set `INDEXNOW_KEY` in Vercel Production, redeploy.
2. Confirm `https://drmed.ph/indexnow-key.txt` returns the key.
3. (Optional) Add the site + key in Bing Webmaster Tools using the `keyLocation`.
4. Open `/staff/admin/seo` and click "Re-submit all pages now" to seed engines.

## Testing

- `src/lib/seo/indexnow-core.test.ts` (vitest, pure):
  - `physicianPageUrls` / `servicePageUrls` shape, code lowercasing, no trailing
    slashes.
  - `buildIndexNowPayload`: dedupe, off-host filtering, empty → `null`, 10k cap,
    payload field shape.
  - `indexNowEnabled`: true only when prod + key present; false for missing key,
    non-prod env, empty key.
- `npm run typecheck`, `npm run lint`, `npm test` green.
- Manual smoke (production, post-deploy): edit a physician → confirm the engine
  ping fires (check Vercel runtime log / Bing Webmaster "IndexNow" tab); verify
  `/indexnow-key.txt` serves the key; click the admin full-submit and confirm the
  audit row.

## File inventory

**New**
- `src/lib/seo/indexnow-core.ts`
- `src/lib/seo/indexnow.ts`
- `src/lib/seo/sitemap-entries.ts`
- `src/lib/seo/indexnow-core.test.ts`
- `src/app/indexnow-key.txt/route.ts`
- `src/app/(staff)/staff/(dashboard)/admin/seo/page.tsx`
- `src/app/(staff)/staff/(dashboard)/admin/seo/actions.ts`
- `src/app/(staff)/staff/(dashboard)/admin/seo/resubmit-button.tsx`

**Modified**
- `src/app/sitemap.ts` (thin wrapper over `buildSitemapEntries`)
- `src/app/(staff)/staff/(dashboard)/admin/physicians/actions.ts` (4 hooks + old-slug pre-read)
- `src/app/(staff)/staff/(dashboard)/services/actions.ts` (2 hooks + `code` in prior-read)
- `src/components/staff/staff-nav-config.ts` (1 Admin nav item)
- `.env.example` (`INDEXNOW_KEY` block)

## Future work (out of scope)

- **Auto-ping on production deploy** for static/marketing pages — needs a
  deploy-completion trigger (e.g. a Vercel Deploy Hook calling a
  `CRON_SECRET`-protected route that runs `allSiteUrls()` + submit). The manual
  button covers this on demand today.
- **Tier 2 continuation** beyond IndexNow: `llms.txt`, local-SEO enrichments,
  review-collection flow (tracked separately on the SEO/AEO roadmap).

## Rollout

1. Land code (this branch) → PR → merge to `main` → deploy.
2. Operator sets `INDEXNOW_KEY` in Vercel Production + redeploys.
3. Verify `/indexnow-key.txt`, run the admin full-submit once.
4. Watch Vercel logs / Bing Webmaster for accepted submissions.
