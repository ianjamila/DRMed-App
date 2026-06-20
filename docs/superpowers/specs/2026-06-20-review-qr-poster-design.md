# Printed review QR + front-desk review poster — design

**Date:** 2026-06-20
**Branch/worktree:** `feat/review-qr-poster` (`.worktrees/review-qr-poster`, off `origin/main` @ `f331804`)
**Status:** approved, ready for implementation plan

## Goal

Make it effortless for a satisfied patient to leave a Google review at the
two physical/printed touchpoints we don't yet use: the **printed receipt**
they take home, and the **reception desk**. This is Tier-2 follow-on work to
the post-visit review CTA shipped in PR #93/#94 (result email + portal card).

All four review surfaces (receipt, poster, email, portal) route through one
brandable, trackable `drmed.ph/review` link so we can see which touchpoint
actually drives scans and change the destination in one place.

## Non-goals / guardrails

- **No incentive language** anywhere — Google's policies prohibit incentivized
  reviews. Copy stays neutral ("Happy with your visit?", "helps other families
  find us").
- **No DB schema change / no migration.** Scan tracking reuses the existing
  `audit_log` table (the same place IndexNow pings are recorded), via the
  `audit()` helper's `actor_type: "anonymous"` path.
- **No new dependency.** Reuses the existing `QrCode` component
  (`src/components/ui/qr-code.tsx`, wrapping `qrcode.react`) and the
  `GOOGLE_REVIEW` constant in `src/lib/marketing/site.ts`.
- Plain-language, patient-facing copy per the project convention.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Which receipts get the QR | **Both** single-visit and combined group receipts |
| Poster physical format | **A5 desk standee** (portrait, for an acrylic counter holder) |
| What the QR encodes | **A new `/review` redirect** on drmed.ph (not the raw g.page link) |
| Receipt CTA prominence | **Compact footer line + small QR**, not a framed box |
| Out-of-scope add-ons | **All three included** (see §4) |

## Components

### 1. `/review` redirect route — the single QR target

**File:** `src/app/review/route.ts`

- `export const dynamic = "force-dynamic";`
- `GET(request)`:
  1. Read `?src`, normalize via `reviewLinkSource()` (see helper below).
  2. Best-effort `audit({ actor_id: null, actor_type: "anonymous",
     action: "review.link.opened", metadata: { src }, ip_address, user_agent })`.
     `audit()` swallows its own errors and must never block the redirect.
     `ip_address` / `user_agent` read best-effort from request headers.
  3. Return a **302** redirect to `GOOGLE_REVIEW.url` with header
     `X-Robots-Tag: noindex`.

**Why a redirect instead of the raw g.page link:** brandable (`drmed.ph/review`),
future-proof if the GBP short link ever changes, and gives per-source scan
counts. Mirrors the established `…?src=poster` / `?src=staff_qr` convention
already used by `/register-poster`, registration, and appointments.

**Helper module:** `src/lib/seo/review.ts` (no `server-only` import, so it is
unit-testable):

```ts
export const REVIEW_PATH = "/review";
export type ReviewSource = "receipt" | "poster" | "portal" | "email" | "unknown";
export function reviewLinkSource(raw: string | null | undefined): ReviewSource;
export function reviewLink(src: Exclude<ReviewSource, "unknown">): string; // → "/review?src=receipt"
```

`reviewLinkSource` whitelists known sources and falls back to `"unknown"` for
anything missing/unexpected (defends the audit metadata against junk query
strings).

### 2. Receipt review CTA — both receipts

**New shared component:** `ReceiptReviewCta({ url }: { url: string })` at
`src/components/staff/receipt-review-cta.tsx` (shared, since the two receipts
live in different folders). Presentational; renders `QrCode` (client) inside.
The receipt pages are server components, which is fine.

Layout: a compact block near the existing thank-you footer:
> *"Happy with your visit? Scan to review us on Google ★★★★★"* + ~88px QR +
> the display URL (host without scheme).

- Wrap with `print:break-inside-avoid` and keep vertical rhythm tight so a
  single-visit receipt still fits **one A5 page** (the existing
  `@page receipt { size: A5; margin: 10mm }` constraint in `globals.css`).
- Add to **both**:
  - `src/app/(staff)/staff/(dashboard)/visits/[id]/receipt/page.tsx`
  - `src/app/(staff)/staff/(dashboard)/visits/group/[groupId]/receipt/page.tsx`
- Each page computes the absolute URL from the request host (mirroring
  `/register-poster`): `${proto}://${host}${reviewLink("receipt")}`. Pages are
  already dynamic, so adding `headers()` is cheap.

### 3. `/review-poster` — A5 desk standee

Mirrors `/register-poster` exactly (standalone route outside marketing chrome,
**noindex**, print-optimized, "Print" button hidden in print).

- `src/app/review-poster/page.tsx` — noindex metadata; builds
  `${proto}://${host}${reviewLink("poster")}` from the request host.
- `src/app/review-poster/poster.tsx` — `ReviewPoster` client component:
  - Logo + tagline.
  - Headline *"Happy with your visit?"*.
  - Subhead about helping other patients find trustworthy, affordable care.
  - Framed ~280px `QrCode`.
  - Display URL.
  - 3 steps: *Scan the QR · Tap the stars · Share a few words*.
  - Gentle no-pressure note.
  - Contact footer (NAP from `CONTACT`).
  - `@page { size: A5; margin: 0 }` so it prints A5 portrait by default for a
    desk holder; `@media print { .no-print { display: none } }`.

## 4. Add-ons (all included)

### 4a. Unify the existing email + portal CTAs through `/review`

- **Result email** (`src/lib/notifications/notify-released.ts`): replace both
  uses of `GOOGLE_REVIEW.url` (the plain-text body line and the
  `emailReviewCta(...)` call) with an absolute `${SITE.url}${reviewLink("email")}`
  (i.e. `https://drmed.ph/review?src=email`). `SITE` is already imported.
- **Portal card** (`src/app/(patient)/portal/(authenticated)/page.tsx`): change
  `href={GOOGLE_REVIEW.url}` to `reviewLink("portal")` (relative
  `/review?src=portal`, same domain, still `target="_blank"`).
- Net effect: one trackable link across all four surfaces, one place
  (`GOOGLE_REVIEW.url`) to change the destination.

### 4b. Admin SEO page: staff entry point + scan stats

`src/app/(staff)/staff/(dashboard)/admin/seo/page.tsx` (already admin-gated,
already uses `createAdminClient`). Add a "Reviews" section:

- A **"Print review poster"** link → `/review-poster` (opens in a new tab).
- A **scan-count mini-stat**: counts of `audit_log` rows with
  `action = "review.link.opened"`, grouped by `metadata->>src`
  (receipt / poster / portal / email) plus a total. Implemented with a small
  number of `count: "exact", head: true` queries (one per source + total)
  filtered via `.eq("action", …)` and `.filter("metadata->>src", "eq", …)`.
  Volume is clinic-scale, so exact counts are cheap. If there are zero rows,
  show a friendly "No review scans recorded yet" empty state.

### 4c. Reception chrome discoverability

Add a "Print review poster" link next to the existing register-poster entry
points so reception can find it the same way:

- `src/app/(staff)/staff/(dashboard)/registration/registration-panel.tsx`
- `src/components/staff/registration-link-button.tsx`

Match the existing `href="/register-poster"` styling/placement.

## Error handling

- Redirect is resilient: audit write is best-effort; a failed audit insert is
  logged by `audit()` and the redirect still happens.
- Unknown / missing `?src` → `"unknown"`, still redirects normally.
- QR rendering is local vector SVG (no network), so no failure mode on print.

## Testing

- **Unit:** `src/lib/seo/review.test.ts` — `reviewLinkSource` whitelist,
  unknown fallback, and `reviewLink` output shape. (Pure module, no
  `server-only` import, so it runs under vitest.)
- **Gate:** `npm run lint`, `npm run typecheck`, `npm test` all green.
- **Manual:** print one single-visit receipt (must stay one A5 page) and the
  poster; confirm both QR codes resolve to the GBP review composer.
- **Optional smoke:** Playwright screenshot of `/review-poster` at A5, and an
  assertion that `GET /review?src=poster` returns 302 → `GOOGLE_REVIEW.url`.

## Files touched (summary)

New:
- `src/app/review/route.ts`
- `src/lib/seo/review.ts` + `src/lib/seo/review.test.ts`
- `src/app/review-poster/page.tsx`, `src/app/review-poster/poster.tsx`
- `src/components/staff/receipt-review-cta.tsx` (shared receipt CTA)

Edited:
- `visits/[id]/receipt/page.tsx`, `visits/group/[groupId]/receipt/page.tsx`
- `notify-released.ts`, portal `(authenticated)/page.tsx`
- `admin/seo/page.tsx`
- `registration-panel.tsx`, `registration-link-button.tsx`

No migrations. No new dependencies.
