# Post-visit review-collection CTA — design

- **Date:** 2026-06-18
- **Status:** Approved (brainstorm) — ready for implementation plan
- **Branch / worktree:** `feat/review-collection-cta` in `.worktrees/review-collection-cta` (off `origin/main` @ `263b04d`)
- **Roadmap slot:** SEO/AEO **Tier 2, feature 3** — the last Tier 2 piece (features 1 & 2 merged). See `project_seo_aeo_roadmap`, `project_seo_aeo_tier2`, `project_emails_sent_log`.

## Summary

Add a tasteful **"Leave us a Google review" CTA** to the result-ready patient
email, shown **once per patient, ever**, plus an ambient review card in the
patient portal and an admin "review ask sent" badge in the Emails-sent log.
The goal: convert satisfied patients into genuine Google Business Profile (GBP)
reviews — the real local-SEO lever — reusing the existing Resend + branded-email
infrastructure. **No database migration. No new route. No new tracker.**

## Decisions (from brainstorm)

1. **`aggregateRating` is deferred — NOT built here.** Google does not show
   review-star rich results for self-serving `LocalBusiness`/`MedicalClinic`
   reviews (deprecated 2019) and prohibits republishing one's own Google
   reviews as `aggregateRating`. A hardcoded clinic rating would earn no stars
   and risk a manual action. The compliant future path (first-party review
   capture → eligible `Product`/package `aggregateRating`) is logged as
   follow-on work, not part of this feature.
2. **Review link is derived from the verified GBP pin, not owner-supplied.**
   The owner-confirmed Maps share link (`GEO.mapUrl`) expands to ftid
   `0x3397b726a17df91f:0x1b7581ea1172c841` → decimal CID `1978630453614266433`.
   We ship the guaranteed-correct `?cid=` listing link now and upgrade to a
   one-tap `writereview?placeid=ChIJ…` when that ID is obtained (see §1).
3. **Frequency: once per patient, ever** for the *email* CTA — suppressed via
   an `audit_log` flag (no migration). The portal card is ambient (always shown
   when results exist), not subject to suppression.
4. **R1–R5 refinements folded in** (section order, sentiment-safe copy, robust
   link, modularity/testability, no backfill — detailed below).
5. **Two cheap out-of-scope items folded in**: portal review card + admin
   "review ask sent" badge. Medium and larger items are explicit follow-on.

## Non-goals (this feature)

- `aggregateRating` / review-stars structured data of any kind.
- First-party (on-site) review capture, storage, or moderation.
- Printed-receipt QR, front-desk poster, dedicated post-visit thank-you email.
- "Review asks sent" admin stat, dismissable portal card, ungated portal
  micro-feedback, "refer a friend" CTA.
- Any analytics/click-tracking on the review link (off-domain; RA 10173).
- Touching `/schedule`, booking, or the day-before reminder emails.

All of the above are catalogued (by cost, with the recommended order) in the
**Out of scope / follow-on roadmap** at the end of this doc.

## Detailed design

### 1. Review-link config — `src/lib/marketing/site.ts`

Add a `GOOGLE_REVIEW` constant next to `SOCIAL`:

```ts
// Deep-link for leaving a Google review of the verified DRMed GBP listing.
// Derived from GEO.mapUrl (owner-confirmed pin): ftid
// 0x3397b726a17df91f:0x1b7581ea1172c841 → CID 1978630453614266433.
//
// Shipped value is the Maps LISTING link (CID) — guaranteed to resolve to the
// correct place; the listing shows a prominent "Write a review" button (one
// extra tap). Upgrade to the one-tap composer by replacing `url` with
//   https://search.google.com/local/writereview?placeid=<CHIJ_PLACE_ID>
// once the ChIJ Place ID is obtained (Google "Place ID Finder", no API key,
// search the business name) — OR paste your GBP "Ask for reviews" short link
// (https://g.page/r/<id>/review). Single edit, single source of truth.
export const GOOGLE_REVIEW = {
  url: "https://www.google.com/maps?cid=1978630453614266433",
} as const;
```

Both the email CTA and the portal card read `GOOGLE_REVIEW.url`.

**Known limitation (accepted for v1):** the shipped `?cid=` link lands on the
Maps *listing*, not the write-review composer — so the "Leave us a Google
review" button costs the patient one extra tap ("Write a review" on the
listing). The verified one-tap composer needs the `ChIJ` Place ID, which can't
be obtained headless without a Maps API key. During implementation we make one
attempt to resolve `ChIJ` (Place ID Finder, or an algorithmic `ftid → ChIJ`
conversion) and, if obtained, **load the resulting URL to confirm it names
"DRMed" before relying on it**; otherwise the `?cid=` listing link ships.

**Owner action (tracked follow-up):** the cleanest one-tap link is the GBP
"Ask for reviews" short link (`https://g.page/r/<id>/review`). Grabbing it is a
~30-second task in the Google Business Profile dashboard; pasting it into
`GOOGLE_REVIEW.url` is a single-line config change (no redeploy logic). This
materially improves conversion and should be done soon after launch.

### 2. Pure email CTA builder — `src/lib/notifications/branded-email.ts`

Add a pure, unit-tested helper that composes the CTA block from the existing
primitives (so it stays consistent with the branded shell and testable without
`server-only`):

```ts
// Secondary "leave a Google review" CTA, appended to the result-ready email
// AFTER the security fine print so it never competes with the primary action.
// Framed around the SERVICE experience, not the result — a result email can
// carry difficult news.
export function emailReviewCta(reviewUrl: string): string {
  return (
    emailDivider() + // thin hairline rule (new tiny helper, see below)
    emailParagraph(
      "How was your visit with us? If our team took good care of you, a " +
        "quick Google review helps other families find DRMed.",
    ) +
    emailButton("Leave us a Google review", reviewUrl, "navy")
  );
}
```

- Add a small `emailDivider()` helper (a `<tr>`/`<hr>`-style table row matching
  the shell's table layout, faint border color) — used to visually separate the
  review CTA from the transactional content above it.
- The button uses the **navy** variant (the existing primary "Sign in" button is
  cyan), so the review ask reads as clearly secondary.
- `escapeHtml` already covers the href inside `emailButton`.

**Tests (in `branded-email.test.ts`):** `emailReviewCta(url)` contains the navy
button, the exact href, and the service-experience copy; `emailDivider()`
renders the separator. (Pure → fast vitest, no DB.)

### 3. Once-per-patient suppression — `src/lib/notifications/review-cta.ts` (server-only)

```ts
import "server-only";
// Returns true if this patient has already been sent a review CTA in a
// previously DELIVERED result email. Matches the house JSONB-filter style
// used by emails-log/query.ts (`metadata->email->>ok`).
export async function patientAlreadyAskedForReview(
  admin: AdminClient,
  patientId: string,
): Promise<boolean> {
  const { data } = await admin
    .from("audit_log")
    .select("id")
    .eq("patient_id", patientId)
    .eq("action", "result.notified")
    .eq("metadata->review_cta->>shown", "true")
    .limit(1);
  return Boolean(data && data.length > 0);
}
```

- **Index-backed (verified):** `idx_audit_log_patient_id` (partial, `where
  patient_id is not null`) exists since `0001_init.sql`. The query filters on
  `patient_id` first, so even the common first-time-ask case (no matching row)
  is an index scan over that one patient's handful of `result.notified` rows —
  **not** a sequential scan of the whole audit log. No migration; safe on the
  hot result-release path.

### 4. Wire-up — `src/lib/notifications/notify-released.ts`

After the patient/test are resolved and before sending:

```ts
const hasEmail = Boolean(patient.email);
const alreadyAsked = hasEmail
  ? await patientAlreadyAskedForReview(admin, patient.id)
  : false;
const includeReviewCta = hasEmail && !alreadyAsked;
```

- **HTML:** when `includeReviewCta`, append `emailReviewCta(GOOGLE_REVIEW.url)`
  to `contentHtml` **after** `emailFinePrint(... PIN privacy ...)` so the
  security warning stays prominent (R1). Order becomes: greeting → released
  paragraph → DRM-ID/PIN detail box → "Sign in" button (cyan) → PIN fine print
  → **divider + review CTA (navy)** → footer.
- **Plain text:** when `includeReviewCta`, insert two lines before the sign-off:
  `"How was your visit? A quick Google review helps other families find us:"`
  and `GOOGLE_REVIEW.url`.
- **Audit metadata:** extend the existing `result.notified` audit row's
  `metadata` with `review_cta: { shown: includeReviewCta && emailResult.ok }`.
  The "asked" flag is therefore set **only when the CTA was actually
  delivered** — no-email patients and failed sends remain eligible next time.

**Race note (verified):** `notifyResultReleased` is called once per
`releaseTestRequestAction`, which is fired by a per-row "Release" button and
`await`s its own audit write before returning. There is no bulk/parallel
release. Consecutive releases for one patient are separated by a human click, so
the prior `review_cta.shown=true` row is always committed and visible before the
next read. The theoretical double-ask race is effectively impossible in
practice; worst case a patient sees the ask twice — acceptable, no data risk.
This is why the audit-log approach needs no migration.

**Multi-component packages:** a package fans out into component `test_requests`,
each potentially firing its own result email today. The per-patient flag means
only the **first delivered** result email across all of them carries the CTA —
the suppression handles this case for free.

### 5. Portal review card — `src/app/(patient)/portal/(authenticated)/page.tsx`

Add an ambient card, rendered only when the patient has ≥1 released result
(`!nothingToShow`), placed after the standalones lists and before "Still in
progress":

```tsx
{!nothingToShow ? (
  <section className="mt-8 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
    <h2 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
      Enjoying DRMed?
    </h2>
    <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
      A quick Google review helps other families find trustworthy, affordable care.
    </p>
    <a
      href={GOOGLE_REVIEW.url}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-3 inline-block rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
    >
      Leave us a Google review
    </a>
  </section>
) : null}
```

- Server component, plain off-domain `<a>` — **not** a tracker, so RA-10173-safe.
- Ambient (no suppression): it's pull, not push. Matches the existing card
  styling (the "Download a copy of your data" / uploads cards).
- Reuse the `GOOGLE_REVIEW` import from `site.ts`.

### 6. Admin "review ask sent" badge — Emails-sent log

The `review_cta.shown` flag is already written to the `result.notified` audit
row (§4), so surfacing it is read-only:

- **`src/lib/emails-log/types.ts`:** add `reviewCtaShown: boolean` to
  `EmailLogEntry`.
- **`src/lib/emails-log/parse-row.ts`:** set
  `reviewCtaShown: type === "result" && asObject(meta.review_cta).shown === true`.
- **Emails-sent page** (`src/app/(staff)/staff/(dashboard)/admin/emails-sent/page.tsx`
  — a single file, no separate row component): render a small chip
  ("Review ask ✓") in the **Details** `<td>` (the cell that already holds
  `e.detail` + the Resend id) on `result` rows where `reviewCtaShown` is true.
  Style it like the existing status chip
  (`rounded-md px-2 py-0.5 text-xs font-semibold`, a cyan tint to distinguish it
  from the green "Sent" status).
- **CSV export** (`src/lib/emails-log/csv.ts`): add a "Review ask" column
  (`yes`/empty) so the admin export stays consistent with the UI — otherwise the
  field is visible on screen but silently dropped from the exported file.

**Tests (in `parse-row.test.ts`):** a `result.notified` row with
`metadata.review_cta.shown = true` parses `reviewCtaShown: true`; absent/false →
`false`; non-result rows → `false`. **Tests (in `csv.test.ts`):** the new
column is present and reflects `reviewCtaShown`.

## Edge cases & accepted limitations

- **Patient merge:** if a patient record is merged into another after a review
  ask was sent, the surviving id may not see the old `review_cta` audit row (the
  merge tooling may not repoint `audit_log.patient_id`), so a merged patient
  could be asked once more. Harmless — accepted, not worth special handling.
- **Bounced email:** Resend "accepted" (`email.ok=true`) marks the patient as
  asked even if the message later bounces, so a hard-bounce patient won't be
  re-asked. Accepted — bounce-webhook plumbing isn't justified for a soft ask.
- **No-email / failed send:** `review_cta.shown` is only set true when the CTA
  was actually delivered, so these patients stay eligible for the next release.
- **Ambient portal card:** shows on every visit while results exist, even to a
  patient who already reviewed (we can't know — it's off-domain). Low-nag,
  standard; a dismissable variant is listed as a cheap follow-on.
- **Optional `decideReviewCta` predicate:** `notify-released.ts` is server-only
  and untested. If we want the include-decision under unit test without a DB,
  extract a pure `decideReviewCta({ hasEmail, alreadyAsked }): boolean` and test
  it. Low value (one boolean), called out so the choice is explicit.

## Data flow

```
reception clicks "Release" (per test)
   → releaseTestRequestAction(testRequestId, visitId)
       → test_requests.status = 'released' (payment/consent gates enforce)
       → audit: test_request.released
       → notifyResultReleased({ testRequestId, visitId })
            → resolve patient + test name
            → includeReviewCta = hasEmail && !patientAlreadyAskedForReview()
            → build HTML/text (with CTA after PIN fine print if included)
            → sendEmail (Resend) [+ sendSms if phone]
            → audit: result.notified { ..., review_cta: { shown: included && email.ok } }

patient → /portal → sees results → ambient "Leave us a Google review" card (if any released)
admin   → /staff/admin/emails-sent → "Review ask ✓" chip on result rows where shown
both CTAs/links → off-domain Google review composer/listing (no tracker)
```

## RA 10173 / compliance

- The email CTA rides **inside an existing transactional email** the patient
  already consented to (result notification). It is a one-time soft ask, not a
  recurring marketing channel — no new consent or unsubscribe is required.
- No analytics, pixels, or click-tracking are added anywhere. The review link is
  a plain `<a>` to Google; any cookies are set by Google after the patient
  leaves our domain.
- No tracker is added to `/portal` or `/staff` (guardrail upheld).
- No PII is sent to any new third party. The SMS path is unchanged.

## Testing plan

- **Unit (vitest, pure):** `emailReviewCta` + `emailDivider` render assertions
  (`branded-email.test.ts`); `parseEmailLogRow` `reviewCtaShown` cases
  (`parse-row.test.ts`).
- **Full gate:** `npm run typecheck`, `npm run lint` (0 errors),
  `npm test` (all green, +new), `npm run build`.
- **Manual reasoning / smoke:** the suppression query and the
  `notifyResultReleased` wiring are server-only (admin client); DB runtime smoke
  requires local Docker Supabase. Verify the include-decision and audit-metadata
  logic by reading + the pure tests; if Docker is available, optionally smoke a
  release and confirm one CTA then suppression on a second release.
- **Link check:** load `GOOGLE_REVIEW.url` and confirm it lands on the DRMed
  listing (and the composer, if the ChIJ upgrade is applied) before committing.

## Files touched

| File | Change |
|---|---|
| `src/lib/marketing/site.ts` | + `GOOGLE_REVIEW` const |
| `src/lib/notifications/branded-email.ts` | + `emailReviewCta`, `emailDivider` (pure) |
| `src/lib/notifications/branded-email.test.ts` | + tests for the two helpers |
| `src/lib/notifications/review-cta.ts` | **new** server-only suppression query |
| `src/lib/notifications/notify-released.ts` | conditional CTA (HTML + text) + audit flag |
| `src/app/(patient)/portal/(authenticated)/page.tsx` | + ambient review card |
| `src/lib/emails-log/types.ts` | + `reviewCtaShown` field |
| `src/lib/emails-log/parse-row.ts` | parse `review_cta.shown` |
| `src/lib/emails-log/parse-row.test.ts` | + `reviewCtaShown` cases |
| `src/lib/emails-log/csv.ts` | + "Review ask" export column |
| `src/lib/emails-log/csv.test.ts` | + column assertion |
| `src/app/(staff)/staff/(dashboard)/admin/emails-sent/page.tsx` | + "Review ask ✓" chip in the Details cell of result rows |

No migration, no new route, no new dependency.

## Out of scope / follow-on roadmap

Everything below is **deliberately not built in this PR** — recorded here so the
full picture survives. Build scope stays the three items above (email CTA +
portal card + admin badge). Ordered so the highest-ROI items are easy to pick up
next.

### Strategic recommendations (do these first)

- **Prioritise the printed-receipt QR.** Production transactional email only went
  live recently and much of the patient base has no email / never logs into the
  portal (see `project_emails_sent_log`). The email CTA + portal card reach only
  the *digitally-engaged minority*; for a walk-in lab, a **printed-receipt QR +
  front-desk poster** will drive most actual review volume. Highest-ROI
  follow-on — ahead of any further email tweaks.
- **Add a "review asks sent (last 30d)" stat to `/staff/admin/seo`.** Clicks are
  untrackable by design (off-domain, no tracker), so the only success proxy is
  *asks sent* (the `review_cta.shown` flag we already write) correlated against
  GBP review-count growth the owner watches manually. ~10 lines; the only
  built-in measurement we can offer.

### Cheap

- **Dismissable portal card** — `localStorage` "I've reviewed / hide" so the
  ambient card stops nagging loyal patients who already reviewed.
- **Focus-visible ring** on the portal card link (part of a broader portal a11y
  pass worth doing someday; the card currently matches its sibling buttons,
  which also lack an explicit focus ring).

### Medium

- **Printed-receipt QR + front-desk poster** (see Strategic above) — the
  catch-all for walk-ins and no-email patients. Touches the receipt PDF and a
  static poster asset.
- **Dedicated post-visit "thank-you" email** fired a few days after the visit
  completes (new cron, reuse Resend) — better timing, fully decoupled from
  result sentiment; could host the review ask in addition to / instead of the
  result-email CTA.
- **Ungated micro-feedback in the portal** — a "How was your visit? 👍 / 👎" that
  **always** still shows the Google review link regardless of the answer. The
  thumbs feed the clinic privately (sentiment signal); the public link is shown
  to *everyone*. This is the **compliant** cousin of review-gating (must be
  ungated — see Flagged).
- **"Refer a friend" CTA** variant beside the review ask (a different growth
  lever sharing the same email/portal real estate).

### Larger (own project)

- **First-party review capture in the portal** (star + comment after viewing
  results) → genuine clinic-owned reviews → **`aggregateRating` eligible on
  `Product`/package nodes** (Product review snippets are still supported by
  Google, unlike self-serving `LocalBusiness`). Migration + RLS + portal UI +
  moderation. This is the compliant revival of the deferred `aggregateRating`
  and the only path to review-star rich results.

### Flagged — do NOT build

- **Review-gating / routing** (5★ → Google, low → private feedback form). Common,
  but it **violates Google's review-gating policy** and risks a penalty. The
  *ungated* micro-feedback above is the compliant alternative.
