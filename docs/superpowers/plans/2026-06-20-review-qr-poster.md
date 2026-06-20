# Printed Review QR + Front-Desk Review Poster Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Google-review QR to printed receipts and a printable A5 front-desk review poster, with all four review touchpoints (receipt, poster, result-email, portal card) routing through one brandable, per-source-trackable `drmed.ph/review` redirect.

**Architecture:** A tiny `/review` route handler 302-redirects to the existing `GOOGLE_REVIEW.url`, logging a privacy-safe `review.link.opened` row to `audit_log` (no migration — reuses the `audit()` `anonymous` path). A pure helper module builds/normalizes the `?src` links and is the only unit-tested piece. Receipts and the new poster render the existing `QrCode` component; the admin SEO page surfaces scan counts and a print link; reception chrome gets discoverability links.

**Tech Stack:** Next.js 16 (App Router, route handlers, server components), TypeScript strict, Tailwind v4 CSS vars, `qrcode.react` (via `@/components/ui/qr-code`), Supabase admin client + `audit()`, vitest.

**Worktree:** `.worktrees/review-qr-poster` on branch `feat/review-qr-poster` (off `origin/main` @ `f331804`).

**No migration. No new dependency.**

---

## File Structure

New:
- `src/lib/seo/review.ts` — pure link helpers + `?src` whitelist (no `server-only`).
- `src/lib/seo/review.test.ts` — vitest for the helpers.
- `src/app/review/route.ts` — `/review` 302 redirect + scan audit.
- `src/components/staff/receipt-review-cta.tsx` — shared compact receipt CTA (renders `QrCode`).
- `src/app/review-poster/page.tsx` — A5 poster route (noindex).
- `src/app/review-poster/poster.tsx` — `ReviewPoster` client component.

Modified:
- `src/app/(staff)/staff/(dashboard)/visits/[id]/receipt/page.tsx` — render CTA.
- `src/app/(staff)/staff/(dashboard)/visits/group/[groupId]/receipt/page.tsx` — render CTA.
- `src/lib/notifications/notify-released.ts` — email CTA → `/review?src=email`.
- `src/app/(patient)/portal/(authenticated)/page.tsx` — portal card → `/review?src=portal`.
- `src/app/(staff)/staff/(dashboard)/admin/seo/page.tsx` — print link + scan stats.
- `src/components/staff/registration-link-button.tsx` — review-poster link.
- `src/app/(staff)/staff/(dashboard)/registration/registration-panel.tsx` — review-poster link.

---

## Task 1: Review link helper module (pure, unit-tested)

**Files:**
- Create: `src/lib/seo/review.ts`
- Test: `src/lib/seo/review.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/lib/seo/review.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { REVIEW_PATH, reviewLink, reviewLinkAbsolute, reviewLinkSource } from "./review";

describe("reviewLinkSource", () => {
  it("passes through known sources", () => {
    expect(reviewLinkSource("receipt")).toBe("receipt");
    expect(reviewLinkSource("poster")).toBe("poster");
    expect(reviewLinkSource("portal")).toBe("portal");
    expect(reviewLinkSource("email")).toBe("email");
  });

  it("falls back to 'unknown' for missing or junk values", () => {
    expect(reviewLinkSource(null)).toBe("unknown");
    expect(reviewLinkSource(undefined)).toBe("unknown");
    expect(reviewLinkSource("")).toBe("unknown");
    expect(reviewLinkSource("RECEIPT")).toBe("unknown");
    expect(reviewLinkSource("../evil")).toBe("unknown");
  });
});

describe("reviewLink", () => {
  it("builds a relative tracked path", () => {
    expect(reviewLink("receipt")).toBe("/review?src=receipt");
    expect(reviewLink("portal")).toBe(`${REVIEW_PATH}?src=portal`);
  });
});

describe("reviewLinkAbsolute", () => {
  it("joins a base origin to the tracked path", () => {
    expect(reviewLinkAbsolute("https://drmed.ph", "email")).toBe(
      "https://drmed.ph/review?src=email",
    );
  });

  it("tolerates a trailing slash on the base", () => {
    expect(reviewLinkAbsolute("https://drmed.ph/", "poster")).toBe(
      "https://drmed.ph/review?src=poster",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/seo/review.test.ts`
Expected: FAIL — `Cannot find module './review'`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/seo/review.ts`:

```ts
// Single source of truth for the on-domain Google-review link.
// All four review touchpoints (receipt, poster, result email, portal card)
// point at /review?src=<surface>, which 302-redirects to the verified GBP
// review composer (see src/app/review/route.ts). Keeping it on-domain makes
// the link brandable, lets us change the destination in one place, and gives
// per-surface scan counts. This module is intentionally free of `server-only`
// imports so it stays unit-testable.

export const REVIEW_PATH = "/review";

export type ReviewSource = "receipt" | "poster" | "portal" | "email" | "unknown";

const KNOWN_SOURCES: ReadonlySet<string> = new Set([
  "receipt",
  "poster",
  "portal",
  "email",
]);

/** Whitelist an incoming ?src value; anything unexpected becomes "unknown". */
export function reviewLinkSource(raw: string | null | undefined): ReviewSource {
  return raw && KNOWN_SOURCES.has(raw) ? (raw as ReviewSource) : "unknown";
}

/** Relative tracked link, e.g. "/review?src=receipt". */
export function reviewLink(src: Exclude<ReviewSource, "unknown">): string {
  return `${REVIEW_PATH}?src=${src}`;
}

/** Absolute tracked link from an origin (handles a trailing slash). */
export function reviewLinkAbsolute(
  base: string,
  src: Exclude<ReviewSource, "unknown">,
): string {
  return `${base.replace(/\/$/, "")}${reviewLink(src)}`;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/lib/seo/review.test.ts`
Expected: PASS (3 describe blocks, all green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/seo/review.ts src/lib/seo/review.test.ts
git commit -m "feat(seo): review link helpers + ?src whitelist"
```

---

## Task 2: `/review` redirect route

**Files:**
- Create: `src/app/review/route.ts`

- [ ] **Step 1: Write the route handler**

Create `src/app/review/route.ts`:

```ts
import { NextResponse, type NextRequest } from "next/server";
import { GOOGLE_REVIEW } from "@/lib/marketing/site";
import { reviewLinkSource } from "@/lib/seo/review";
import { audit } from "@/lib/audit/log";

// Brandable on-domain hop to the verified Google Business Profile review
// composer. Records a privacy-safe, no-PII scan event so the clinic can see
// which touchpoint (receipt / poster / portal / email) drives reviews. The
// audit write is best-effort and never blocks the redirect.
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<Response> {
  const src = reviewLinkSource(request.nextUrl.searchParams.get("src"));

  await audit({
    actor_id: null,
    actor_type: "anonymous",
    action: "review.link.opened",
    metadata: { src },
    ip_address:
      request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: request.headers.get("user-agent"),
  });

  const res = NextResponse.redirect(GOOGLE_REVIEW.url, 302);
  res.headers.set("X-Robots-Tag", "noindex");
  return res;
}
```

Notes:
- `audit()` (`src/lib/audit/log.ts`) already swallows its own errors, so awaiting it cannot throw or block the redirect.
- `metadata: { src }` is valid `Json` (string value).
- `GOOGLE_REVIEW.url` is absolute, which `NextResponse.redirect` requires.

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS, no errors referencing `src/app/review/route.ts`.

- [ ] **Step 3: Manual redirect smoke (optional but recommended)**

Run `npm run dev`, then:
Run: `curl -sI "http://localhost:3000/review?src=poster" | grep -i "location\|x-robots"`
Expected: `location: https://g.page/r/CUHIchHqgXUbEBM/review` and `x-robots-tag: noindex`.

- [ ] **Step 4: Commit**

```bash
git add src/app/review/route.ts
git commit -m "feat(seo): /review redirect to GBP review composer with scan audit"
```

---

## Task 3: Shared receipt review CTA component

**Files:**
- Create: `src/components/staff/receipt-review-cta.tsx`

- [ ] **Step 1: Write the component**

Create `src/components/staff/receipt-review-cta.tsx`:

```tsx
import { QrCode } from "@/components/ui/qr-code";

// Compact, print-safe review nudge for the bottom of a printed receipt.
// Small QR (keeps a single-visit slip on one A5 page) + neutral, non-incentive
// copy (Google prohibits incentivized reviews). `url` is the on-domain
// /review?src=receipt link, built by the receipt page from the request host.
export function ReceiptReviewCta({ url }: { url: string }) {
  const display = url.replace(/^https?:\/\//, "");
  return (
    <div className="mt-6 flex items-center gap-4 rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-4 text-left print:mt-3 print:break-inside-avoid print:p-2">
      <QrCode value={url} size={88} className="shrink-0 p-2" />
      <div>
        <p className="text-sm font-bold text-[color:var(--color-brand-navy)]">
          Happy with your visit?
        </p>
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          Scan to leave us a Google review ★★★★★
        </p>
        <p className="mt-0.5 font-mono text-[10px] break-all text-[color:var(--color-brand-text-soft)]">
          {display}
        </p>
      </div>
    </div>
  );
}
```

Note: `QrCode` accepts a `className` that overrides its default padding; passing `p-2` tightens the small print QR.

- [ ] **Step 2: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/components/staff/receipt-review-cta.tsx
git commit -m "feat(seo): shared printed-receipt review CTA component"
```

---

## Task 4: Render the CTA on the single-visit receipt

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/[id]/receipt/page.tsx`

- [ ] **Step 1: Add imports**

At the top of the file, after the existing `import { PrintButton } from "./print-button";` line, add:

```tsx
import { headers } from "next/headers";
import { ReceiptReviewCta } from "@/components/staff/receipt-review-cta";
import { reviewLinkAbsolute } from "@/lib/seo/review";
```

- [ ] **Step 2: Build the review URL in the component body**

Immediately after this existing line:

```tsx
  const plainPin = await peekVisitPinFlash(visit.id);
```

add:

```tsx
  const host = (await headers()).get("host") ?? "drmed.ph";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const reviewUrl = reviewLinkAbsolute(`${proto}://${host}`, "receipt");
```

- [ ] **Step 3: Render the CTA before the article closes**

Find the existing thank-you paragraph + article close:

```tsx
        <p className="mt-6 text-center text-xs text-[color:var(--color-brand-text-soft)]">
          Thank you. Your results will be sent by SMS / email when ready.
        </p>
      </article>
```

Replace it with:

```tsx
        <p className="mt-6 text-center text-xs text-[color:var(--color-brand-text-soft)]">
          Thank you. Your results will be sent by SMS / email when ready.
        </p>

        <ReceiptReviewCta url={reviewUrl} />
      </article>
```

- [ ] **Step 4: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/visits/[id]/receipt/page.tsx"
git commit -m "feat(seo): review QR on single-visit receipt"
```

---

## Task 5: Render the CTA on the combined group receipt

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/visits/group/[groupId]/receipt/page.tsx`

- [ ] **Step 1: Add imports**

After the existing `import { PrintButton } from "./print-button";` line, add:

```tsx
import { headers } from "next/headers";
import { ReceiptReviewCta } from "@/components/staff/receipt-review-cta";
import { reviewLinkAbsolute } from "@/lib/seo/review";
```

- [ ] **Step 2: Build the review URL in the component body**

Immediately after this existing line:

```tsx
  const plainPin = await peekVisitGroupPinFlash(groupId);
```

add:

```tsx
  const host = (await headers()).get("host") ?? "drmed.ph";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const reviewUrl = reviewLinkAbsolute(`${proto}://${host}`, "receipt");
```

- [ ] **Step 3: Render the CTA after the Patient Portal Access box**

Find the end of the "Patient Portal Access" box and the outer container close (the last lines of the component):

```tsx
        <p className="mt-3 text-xs text-[color:var(--color-brand-text-soft)]">
          Sign in at <strong>{SITE.url.replace(/^https?:\/\//, "")}/portal</strong> to view
          results when ready. One PIN covers both receipts. Valid for 60 days.
        </p>
      </div>
    </div>
  );
}
```

Replace with:

```tsx
        <p className="mt-3 text-xs text-[color:var(--color-brand-text-soft)]">
          Sign in at <strong>{SITE.url.replace(/^https?:\/\//, "")}/portal</strong> to view
          results when ready. One PIN covers both receipts. Valid for 60 days.
        </p>
      </div>

      <ReceiptReviewCta url={reviewUrl} />
    </div>
  );
}
```

- [ ] **Step 4: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/visits/group/[groupId]/receipt/page.tsx"
git commit -m "feat(seo): review QR on combined group receipt"
```

---

## Task 6: `/review-poster` A5 desk standee

**Files:**
- Create: `src/app/review-poster/poster.tsx`
- Create: `src/app/review-poster/page.tsx`

- [ ] **Step 1: Write the poster client component**

Create `src/app/review-poster/poster.tsx`:

```tsx
"use client";

import { QrCode } from "@/components/ui/qr-code";
import { SITE, CONTACT } from "@/lib/marketing/site";

// Print-optimized A5 desk standee for the reception counter. Neutral, no-pressure
// copy — Google prohibits incentivized reviews. Mirrors the /register-poster
// pattern (standalone, Print button hidden in print, contact footer).
export function ReviewPoster({ url }: { url: string }) {
  const display = url.replace(/^https?:\/\//, "");
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-5 p-8 text-center">
      <button
        type="button"
        onClick={() => window.print()}
        className="no-print fixed top-4 right-4 rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
      >
        Print
      </button>

      {/* Brand: logo + official slogan */}
      <div className="flex flex-col items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- plain img prints reliably */}
        <img src="/logo.png" alt={SITE.name} className="h-20 w-auto" />
        <p className="text-base font-semibold italic text-[color:var(--color-brand-cyan)]">
          {SITE.tagline}
        </p>
      </div>

      <h1 className="font-heading text-4xl leading-tight font-extrabold text-[color:var(--color-brand-navy)]">
        Happy with your visit?
      </h1>
      <p className="text-lg text-[color:var(--color-brand-text-mid)]">
        A quick Google review helps other families find trustworthy, affordable
        care.
      </p>

      {/* QR in a framed card so it reads as the focal point */}
      <div className="rounded-2xl border-2 border-[color:var(--color-brand-bg-mid)] bg-white p-5 shadow-sm">
        <QrCode value={url} size={280} />
      </div>
      <p className="font-mono text-sm text-[color:var(--color-brand-text-soft)]">{display}</p>

      <ol className="mt-1 max-w-xs list-decimal space-y-1 pl-5 text-left text-sm text-[color:var(--color-brand-text-mid)]">
        <li>Scan the QR with your phone camera.</li>
        <li>Tap the stars to rate your visit.</li>
        <li>Share a few words — it only takes a minute.</li>
      </ol>

      <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
        No pressure — only if you&apos;d like to. Thank you for choosing {SITE.shortName}.
      </p>

      {/* Contact footer — makes the poster a complete, standalone print */}
      <div className="mt-2 w-full border-t border-[color:var(--color-brand-bg-mid)] pt-3 text-xs text-[color:var(--color-brand-text-soft)]">
        <p className="font-semibold text-[color:var(--color-brand-navy)]">{SITE.name}</p>
        <p>{CONTACT.address.full}</p>
        <p>
          {CONTACT.phone.mobile} · {CONTACT.phone.landline} · {CONTACT.email}
        </p>
      </div>

      {/* A5 portrait for an acrylic desk holder; margin:0 suppresses the
          browser's auto print headers/footers (date, title, URL). */}
      <style>{`@page { size: A5; margin: 0; } @media print { .no-print { display: none !important; } }`}</style>
    </div>
  );
}
```

Note: confirm `CONTACT.address.full` exists — it is used by `/register-poster`'s `poster.tsx`, so it is a safe reuse.

- [ ] **Step 2: Write the poster page (route + noindex)**

Create `src/app/review-poster/page.tsx`:

```tsx
import type { Metadata } from "next";
import { headers } from "next/headers";
import { reviewLinkAbsolute } from "@/lib/seo/review";
import { ReviewPoster } from "./poster";

// Standalone (outside marketing chrome), print-optimized desk poster reception
// can print for the counter. noindex — internal print aid, not a search page.
export const metadata: Metadata = {
  title: "Review poster — drmed.ph",
  robots: { index: false, follow: false },
};

export default async function ReviewPosterPage() {
  const host = (await headers()).get("host") ?? "drmed.ph";
  const proto = host.startsWith("localhost") ? "http" : "https";
  const url = reviewLinkAbsolute(`${proto}://${host}`, "poster");
  return <ReviewPoster url={url} />;
}
```

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 4: Visual check (optional)**

Run `npm run dev`, open `http://localhost:3000/review-poster`, confirm logo, headline, QR, steps, footer all render and the Print button is visible on screen.

- [ ] **Step 5: Commit**

```bash
git add src/app/review-poster/page.tsx src/app/review-poster/poster.tsx
git commit -m "feat(seo): printable A5 front-desk Google-review poster"
```

---

## Task 7: Route the result-email review CTA through `/review`

**Files:**
- Modify: `src/lib/notifications/notify-released.ts`

- [ ] **Step 1: Add the helper import**

This file already imports `{ SITE, GOOGLE_REVIEW } from "@/lib/marketing/site"`. Add a new import line after it:

```ts
import { reviewLinkAbsolute } from "@/lib/seo/review";
```

- [ ] **Step 2: Compute the tracked email link**

In `notify-released.ts`, just after the existing line:

```ts
  const includeReviewCta = hasEmail && !alreadyAsked;
```

add:

```ts
  const reviewUrl = reviewLinkAbsolute(SITE.url, "email");
```

- [ ] **Step 3: Use it in the plain-text body**

Find this block:

```ts
    ...(includeReviewCta
      ? [
          "",
          "How was your visit? A quick Google review helps other families find us:",
          GOOGLE_REVIEW.url,
        ]
      : []),
```

Replace `GOOGLE_REVIEW.url` with `reviewUrl`:

```ts
    ...(includeReviewCta
      ? [
          "",
          "How was your visit? A quick Google review helps other families find us:",
          reviewUrl,
        ]
      : []),
```

- [ ] **Step 4: Use it in the HTML body**

Find:

```ts
      (includeReviewCta ? emailReviewCta(GOOGLE_REVIEW.url) : ""),
```

Replace with:

```ts
      (includeReviewCta ? emailReviewCta(reviewUrl) : ""),
```

- [ ] **Step 5: Remove the now-unused import (only if unused)**

If `GOOGLE_REVIEW` is no longer referenced anywhere else in the file, change the import:

```ts
import { SITE, GOOGLE_REVIEW } from "@/lib/marketing/site";
```

to:

```ts
import { SITE } from "@/lib/marketing/site";
```

Verify first: `grep -n "GOOGLE_REVIEW" src/lib/notifications/notify-released.ts` should return nothing after the edits above before removing it.

- [ ] **Step 6: Typecheck + lint + existing email tests**

Run: `npm run typecheck && npm run lint && npx vitest run src/lib/notifications/branded-email.test.ts`
Expected: PASS (the branded-email test exercises `emailReviewCta` with an arbitrary URL, so it stays green).

- [ ] **Step 7: Commit**

```bash
git add src/lib/notifications/notify-released.ts
git commit -m "feat(seo): route result-email review CTA through /review?src=email"
```

---

## Task 8: Route the portal review card through `/review`

**Files:**
- Modify: `src/app/(patient)/portal/(authenticated)/page.tsx`

- [ ] **Step 1: Swap the import**

This file imports `{ GOOGLE_REVIEW } from "@/lib/marketing/site"`. Replace that import with the helper:

```ts
import { reviewLink } from "@/lib/seo/review";
```

(If `GOOGLE_REVIEW` is imported alongside other names from `site.ts` on the same line, remove only `GOOGLE_REVIEW` from that import and add the `reviewLink` import on a new line. Verify the import line first: `grep -n "GOOGLE_REVIEW" src/app/\(patient\)/portal/\(authenticated\)/page.tsx`.)

- [ ] **Step 2: Update the link href**

Find:

```tsx
          <a
            href={GOOGLE_REVIEW.url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
          >
            Leave us a Google review
          </a>
```

Replace `href={GOOGLE_REVIEW.url}` with `href={reviewLink("portal")}`:

```tsx
          <a
            href={reviewLink("portal")}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
          >
            Leave us a Google review
          </a>
```

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS, no unused-import error for `GOOGLE_REVIEW`.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(patient)/portal/(authenticated)/page.tsx"
git commit -m "feat(seo): route portal review card through /review?src=portal"
```

---

## Task 9: Admin SEO page — print link + scan stats

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/admin/seo/page.tsx`

- [ ] **Step 1: Add the review scan-count queries**

In the page component, after the existing `recentPings` query block (the `const { data: recentPings } = await admin...limit(25);` statement), add:

```tsx
  const REVIEW_ACTION = "review.link.opened";
  const countReviewScans = async (src: string) => {
    const { count } = await admin
      .from("audit_log")
      .select("id", { count: "exact", head: true })
      .eq("action", REVIEW_ACTION)
      .eq("metadata->>src", src);
    return count ?? 0;
  };
  const [scanReceipt, scanPoster, scanPortal, scanEmail] = await Promise.all([
    countReviewScans("receipt"),
    countReviewScans("poster"),
    countReviewScans("portal"),
    countReviewScans("email"),
  ]);
  const { count: scanTotalRaw } = await admin
    .from("audit_log")
    .select("id", { count: "exact", head: true })
    .eq("action", REVIEW_ACTION);
  const scanTotal = scanTotalRaw ?? 0;
```

(The `.eq("metadata->>src", ...)` JSON-path form is already used in this codebase — see `src/lib/notifications/review-cta.ts` and `src/lib/emails-log/query.ts`.)

- [ ] **Step 2: Render the Reviews section**

Immediately before the final closing `</div>` of the returned JSX (i.e. after the "Recent IndexNow submissions" `</section>`), add:

```tsx
      <section className="mt-8">
        <h2 className="font-heading text-lg font-bold text-[color:var(--color-brand-navy)]">
          Google reviews
        </h2>
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          A printable desk poster and the on-receipt QR both point patients to
          our Google review page. Scan counts below show which touchpoint is
          working.
        </p>

        <a
          href="/review-poster"
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-block rounded-md border border-[color:var(--color-brand-bg-mid)] px-4 py-2 text-sm font-semibold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
        >
          Print review poster →
        </a>

        <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            { label: "Receipt", value: scanReceipt },
            { label: "Poster", value: scanPoster },
            { label: "Portal", value: scanPortal },
            { label: "Email", value: scanEmail },
            { label: "Total", value: scanTotal },
          ].map((s) => (
            <div
              key={s.label}
              className="rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white p-3 text-center"
            >
              <dt className="text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                {s.label}
              </dt>
              <dd className="mt-1 font-heading text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
                {s.value}
              </dd>
            </div>
          ))}
        </dl>
        {scanTotal === 0 ? (
          <p className="mt-3 text-xs text-[color:var(--color-brand-text-soft)]">
            No review-link scans recorded yet.
          </p>
        ) : null}
      </section>
```

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/admin/seo/page.tsx"
git commit -m "feat(seo): review poster link + per-source scan counts on admin SEO page"
```

---

## Task 10: Reception chrome discoverability links

**Files:**
- Modify: `src/components/staff/registration-link-button.tsx`
- Modify: `src/app/(staff)/staff/(dashboard)/registration/registration-panel.tsx`

- [ ] **Step 1: Add review-poster link to the registration-link popover**

In `src/components/staff/registration-link-button.tsx`, find the existing register-poster link inside the `<Panel>`:

```tsx
          <a
            href="/register-poster"
            target="_blank"
            rel="noreferrer"
            className="text-xs font-semibold text-[color:var(--color-brand-cyan)] underline"
          >
            Open printable poster →
          </a>
```

Add a second link directly after it (still inside the `<Panel>`):

```tsx
          <a
            href="/review-poster"
            target="_blank"
            rel="noreferrer"
            className="text-xs font-semibold text-[color:var(--color-brand-cyan)] underline"
          >
            Google-review poster →
          </a>
```

- [ ] **Step 2: Add review-poster link to the registration panel**

In `src/app/(staff)/staff/(dashboard)/registration/registration-panel.tsx`, find the register-poster link inside the button row:

```tsx
        <a
          href="/register-poster"
          target="_blank"
          rel="noreferrer"
          className="flex-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-center text-sm font-semibold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
        >
          Print poster →
        </a>
```

Add a sibling link directly after it (inside the same `<div className="flex w-full flex-col gap-2 sm:flex-row">`):

```tsx
        <a
          href="/review-poster"
          target="_blank"
          rel="noreferrer"
          className="flex-1 rounded-md border border-[color:var(--color-brand-bg-mid)] px-3 py-2 text-center text-sm font-semibold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
        >
          Review poster →
        </a>
```

- [ ] **Step 3: Typecheck + lint**

Run: `npm run typecheck && npm run lint`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/components/staff/registration-link-button.tsx "src/app/(staff)/staff/(dashboard)/registration/registration-panel.tsx"
git commit -m "feat(seo): surface review poster from reception chrome"
```

---

## Task 11: Full gate + optional UI smoke

**Files:** none (verification only)

- [ ] **Step 1: Run the full test + quality gate**

Run: `npm run lint && npm run typecheck && npm test`
Expected: all PASS. The new `review.test.ts` is included; pre-existing suites (incl. `branded-email.test.ts`) stay green.

- [ ] **Step 2: Manual print verification**

With `npm run dev`:
- Open a single-visit receipt (`/staff/visits/<id>/receipt`), use Print preview, confirm the receipt + review CTA fit **one A5 page** and the small QR resolves to the GBP composer.
- Open a combined receipt (`/staff/visits/group/<groupId>/receipt`), confirm the review CTA renders after the Patient Portal Access box.
- Open `/review-poster`, Print preview at A5, confirm the QR and layout.

- [ ] **Step 3: Optional Playwright screenshot smoke**

If verifying visually, screenshot `/review-poster` at A5 (per the headless-screenshot CDP recipe — use `Emulation.setDeviceMetricsOverride`, judge by pixels). Confirm no console errors.

- [ ] **Step 4: Push the branch**

```bash
git push -u origin feat/review-qr-poster
```

- [ ] **Step 5: Open the PR**

```bash
export PATH="/opt/homebrew/bin:$PATH"
gh pr create --title "feat(seo): printed review QR + front-desk review poster (Tier 2)" \
  --body "$(cat <<'EOF'
## What

Adds a Google-review QR to printed receipts and a printable A5 front-desk review poster. Unifies all four review touchpoints (receipt, poster, result email, portal card) behind one brandable, per-source-trackable `drmed.ph/review` redirect, and surfaces scan counts + a print link on the admin SEO page.

- New `/review` 302 redirect → verified GBP review composer, with a privacy-safe `review.link.opened` audit row (no PII, no migration).
- Review QR on both single-visit and combined receipts (compact, one A5 page).
- New `/review-poster` A5 desk standee (mirrors `/register-poster`).
- Result-email + portal CTAs now route through `/review?src=email|portal`.
- Admin SEO page: "Print review poster" link + per-source scan counts.
- Reception chrome links to the review poster for discoverability.

No incentive language (Google ToS). No DB migration. No new dependency.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review notes

- **Spec coverage:** Core (/review route, receipt CTA ×2, poster) → Tasks 2–6. Add-on 4a (email+portal) → Tasks 7–8. Add-on 4b (admin link+stats) → Task 9. Add-on 4c (reception chrome) → Task 10. Testing/guardrails → Tasks 1 & 11.
- **Type consistency:** `reviewLink` / `reviewLinkAbsolute` / `reviewLinkSource` / `ReviewSource` names are used identically across Tasks 1, 2, 4, 5, 6, 7, 8. `ReceiptReviewCta({ url })` and `ReviewPoster({ url })` signatures match their call sites.
- **No migration:** scan tracking reuses `audit_log` via `audit()` (`actor_type: "anonymous"`), consistent with `seo.indexnow.ping`.
- **No placeholders:** every code step shows complete code; every command shows expected output.
