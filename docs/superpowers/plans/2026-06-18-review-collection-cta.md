# Post-visit Review-Collection CTA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a tasteful, once-per-patient "Leave us a Google review" CTA to the result-ready patient email, plus an ambient portal review card and an admin "review ask sent" badge — reusing the existing Resend + branded-email infra, with no DB migration.

**Architecture:** A single config constant (`GOOGLE_REVIEW.url`) is the one source of truth for the review link. A pure email helper (`emailReviewCta`) builds the CTA block; a thin server-only query (`patientAlreadyAskedForReview`) suppresses repeats via an `audit_log` flag (`metadata.review_cta.shown`, index-backed by `idx_audit_log_patient_id`). `notify-released.ts` wires them together and records the flag. The portal card and the Emails-sent badge/CSV read the same data. No tracker, no migration, no new route.

**Tech Stack:** Next.js 16 (App Router, RSC), TypeScript strict, Supabase (service-role admin client), Resend (via existing `sendEmail`), Vitest (pure-logic unit tests).

**Spec:** `docs/superpowers/specs/2026-06-18-review-collection-cta-design.md`

---

## File structure

| File | Responsibility |
|---|---|
| `src/lib/marketing/site.ts` | + `GOOGLE_REVIEW` const (the single review-link source) |
| `src/lib/notifications/branded-email.ts` | + pure `emailDivider()` and `emailReviewCta(url)` helpers |
| `src/lib/notifications/branded-email.test.ts` | + tests for the two new helpers |
| `src/lib/notifications/review-cta.ts` | **new** server-only `patientAlreadyAskedForReview()` query |
| `src/lib/notifications/notify-released.ts` | conditional CTA in HTML + text; `review_cta` audit flag |
| `src/app/(patient)/portal/(authenticated)/page.tsx` | + ambient "Leave us a Google review" card |
| `src/lib/emails-log/types.ts` | + `reviewCtaShown: boolean` on `EmailLogEntry` |
| `src/lib/emails-log/parse-row.ts` | parse `metadata.review_cta.shown` → `reviewCtaShown` |
| `src/lib/emails-log/parse-row.test.ts` | + `reviewCtaShown` cases |
| `src/lib/emails-log/csv.ts` | + "Review ask" export column |
| `src/lib/emails-log/csv.test.ts` | update header assertion + add column test; `entry()` base gets the new field |
| `src/app/(staff)/staff/(dashboard)/admin/emails-sent/page.tsx` | + "Review ask ✓" chip in the Details cell of result rows |

**Notes for the implementer (DRMed-specific):**
- Tests run on **vitest**; pure-logic only — a module under test must **not** `import "server-only"`. That's why `review-cta.ts`, `notify-released.ts`, and the two `page.tsx` files have no unit tests (they're server-only / RSC); they're covered by `npm run typecheck` + `npm run build`.
- All commit messages use Conventional Commits and end with the trailer:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- A post-commit hook may print `python3 ... Killed: 9` — that's a harmless sandbox quirk; the commit still succeeds.

---

## Task 1: Add the `GOOGLE_REVIEW` config constant

**Files:**
- Modify: `src/lib/marketing/site.ts` (add after the `SOCIAL` block, ~line 59)

- [ ] **Step 1: (best-effort) try to resolve the one-tap `ChIJ` review link**

The verified Maps pin is `GEO.mapUrl` → ftid `0x3397b726a17df91f:0x1b7581ea1172c841` → decimal CID `1978630453614266433`. Optionally attempt to resolve the `ChIJ` Place ID (Google "Place ID Finder", or an `ftid → ChIJ` converter) to build a one-tap composer URL `https://search.google.com/local/writereview?placeid=<ChIJ>`. **If and only if** you obtain one, open it in a browser and confirm it names "DRMed Clinic and Laboratory" before using it. If you cannot verify it, **skip this** and ship the `?cid=` listing link in Step 2 (it is guaranteed-correct; it costs one extra tap).

- [ ] **Step 2: Add the constant**

Add immediately after the `SOCIAL` block in `src/lib/marketing/site.ts`:

```ts
// Deep-link for leaving a Google review of the verified DRMed GBP listing.
// Derived from GEO.mapUrl (owner-confirmed pin): ftid
// 0x3397b726a17df91f:0x1b7581ea1172c841 → CID 1978630453614266433.
//
// Shipped value is the Maps LISTING link (CID) — guaranteed to resolve to the
// correct place; the listing shows a prominent "Write a review" button (one
// extra tap). Upgrade to the one-tap composer by replacing `url` with
//   https://search.google.com/local/writereview?placeid=<CHIJ_PLACE_ID>
// once the ChIJ Place ID is obtained — OR paste the GBP "Ask for reviews"
// short link (https://g.page/r/<id>/review). Single edit, single source.
export const GOOGLE_REVIEW = {
  url: "https://www.google.com/maps?cid=1978630453614266433",
} as const;
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run typecheck`
Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add src/lib/marketing/site.ts
git commit -m "$(cat <<'EOF'
feat(seo): add GOOGLE_REVIEW link config (review-collection CTA)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Pure email helpers `emailDivider` + `emailReviewCta`

**Files:**
- Modify: `src/lib/notifications/branded-email.ts` (add after `emailButton`, ~line 79)
- Test: `src/lib/notifications/branded-email.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/lib/notifications/branded-email.test.ts`, add `emailReviewCta` and `emailDivider` to the import list at the top:

```ts
import {
  escapeHtml,
  emailParagraph,
  emailButton,
  emailDetailBox,
  emailHighlight,
  emailDivider,
  emailReviewCta,
  renderEmailShell,
} from "./branded-email";
```

Then append these `describe` blocks at the end of the file:

```ts
describe("emailDivider", () => {
  it("renders a hairline separator row", () => {
    expect(emailDivider()).toContain("border-top");
  });
});

describe("emailReviewCta", () => {
  it("renders a navy button with the review url and service-experience copy", () => {
    const html = emailReviewCta("https://www.google.com/maps?cid=123");
    expect(html).toContain("https://www.google.com/maps?cid=123");
    expect(html).toContain("Leave us a Google review");
    expect(html).toContain("#263F91"); // navy button (secondary)
    expect(html).toContain("How was your visit"); // sentiment-safe, service-framed
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/notifications/branded-email.test.ts`
Expected: FAIL — `emailDivider`/`emailReviewCta` are not exported (`is not a function` / import error).

- [ ] **Step 3: Implement the two helpers**

In `src/lib/notifications/branded-email.ts`, add immediately after the `emailButton` function (after its closing `}`, ~line 79):

```ts
// Faint hairline rule. Table row keeps it robust across email clients (Outlook
// strips bare <hr>). Used to separate the secondary review CTA from the
// transactional content above it.
export function emailDivider(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:18px 0;"><tr><td style="border-top:1px solid #e5eaf2;font-size:0;line-height:0;">&nbsp;</td></tr></table>`;
}

// Secondary "leave a Google review" CTA. Appended to the result-ready email
// AFTER the security fine print so it never competes with the primary action.
// Framed around the SERVICE experience, not the result — a result email can
// carry difficult news. Navy button = visually secondary to the cyan primary.
export function emailReviewCta(reviewUrl: string): string {
  return (
    emailDivider() +
    emailParagraph(
      "How was your visit with us? If our team took good care of you, a " +
        "quick Google review helps other families find DRMed.",
    ) +
    emailButton("Leave us a Google review", reviewUrl, "navy")
  );
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/notifications/branded-email.test.ts`
Expected: PASS (all existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/lib/notifications/branded-email.ts src/lib/notifications/branded-email.test.ts
git commit -m "$(cat <<'EOF'
feat(notifications): emailDivider + emailReviewCta pure helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Server-only suppression query `patientAlreadyAskedForReview`

**Files:**
- Create: `src/lib/notifications/review-cta.ts`

No vitest test: this module `import "server-only"` (pulls the admin client), so it is verified by `npm run typecheck` + `npm run build`, not Vitest. The query mirrors the JSONB-filter style already used in `src/lib/emails-log/query.ts` (`q.eq("metadata->email->>ok", "true")`) and is index-backed by `idx_audit_log_patient_id`.

- [ ] **Step 1: Create the module**

Create `src/lib/notifications/review-cta.ts`:

```ts
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

type AdminClient = ReturnType<typeof createAdminClient>;

// True if this patient has already been sent a review CTA in a previously
// DELIVERED result email (audit metadata review_cta.shown === true). Filters on
// patient_id first, so even the common first-ask case (no matching row) is an
// index scan over that one patient's few result.notified rows via
// idx_audit_log_patient_id — never a full audit_log scan. No migration.
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

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/lib/notifications/review-cta.ts
git commit -m "$(cat <<'EOF'
feat(notifications): once-per-patient review-CTA suppression query

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Wire the CTA into `notify-released.ts`

**Files:**
- Modify: `src/lib/notifications/notify-released.ts`

Server-only; verified by typecheck + build. The current file resolves `patient`/`svc`, builds `emailText` (a joined array) and `emailHtml` (via `renderEmailShell`), sends SMS + email in `Promise.all`, then writes a `result.notified` audit row. We (a) add imports, (b) compute `includeReviewCta`, (c) append the CTA to HTML + text, (d) add the `review_cta` flag to the audit metadata.

- [ ] **Step 1: Update imports**

In `src/lib/notifications/notify-released.ts`:

Change the marketing-site import (currently `import { SITE } from "@/lib/marketing/site";`) to:

```ts
import { SITE, GOOGLE_REVIEW } from "@/lib/marketing/site";
```

Add `emailReviewCta` to the branded-email import list (it currently imports `renderEmailShell, emailParagraph, emailDetailBox, emailButton, emailFinePrint, escapeHtml`):

```ts
import {
  renderEmailShell, emailParagraph, emailDetailBox, emailButton, emailFinePrint, escapeHtml, emailReviewCta,
} from "./branded-email";
```

Add the suppression-query import next to the other `./` imports:

```ts
import { patientAlreadyAskedForReview } from "./review-cta";
```

- [ ] **Step 2: Compute `includeReviewCta`**

Immediately after the line `const testName = svc.name;` (just before `const smsBody =`), add:

```ts
  // Review CTA: only on a patient's FIRST delivered result email, and only if
  // they have an email on file. Suppressed thereafter via the audit flag.
  const hasEmail = Boolean(patient.email);
  const alreadyAsked = hasEmail
    ? await patientAlreadyAskedForReview(admin, patient.id)
    : false;
  const includeReviewCta = hasEmail && !alreadyAsked;
```

- [ ] **Step 3: Append the CTA to the plain-text body**

Replace the `emailText` array's tail so the review lines appear before the sign-off. The current array ends:

```ts
    "Your PIN is valid for 60 days. Keep it private — anyone with your PIN can view your lab results.",
    "",
    "— DRMed Clinic and Laboratory",
  ].join("\n");
```

Change it to:

```ts
    "Your PIN is valid for 60 days. Keep it private — anyone with your PIN can view your lab results.",
    ...(includeReviewCta
      ? [
          "",
          "How was your visit? A quick Google review helps other families find us:",
          GOOGLE_REVIEW.url,
        ]
      : []),
    "",
    "— DRMed Clinic and Laboratory",
  ].join("\n");
```

- [ ] **Step 4: Append the CTA to the HTML body**

In the `renderEmailShell({ ... contentHtml: ... })` call, the `contentHtml` currently ends with:

```ts
      emailFinePrint("Your PIN is valid for 60 days. Keep it private — anyone with your PIN can view your lab results."),
```

Change that line to (CTA after the fine print so the security warning stays prominent):

```ts
      emailFinePrint("Your PIN is valid for 60 days. Keep it private — anyone with your PIN can view your lab results.") +
      (includeReviewCta ? emailReviewCta(GOOGLE_REVIEW.url) : ""),
```

- [ ] **Step 5: Record the audit flag**

In the `audit({ ... metadata: { ... } })` call, add a `review_cta` key to `metadata`. After the `email:` entry (the last key in `metadata`), add:

```ts
      review_cta: { shown: includeReviewCta && emailResult.ok },
```

(`emailResult` is in scope after the `Promise.all`. The flag is true only when the CTA was actually delivered, so no-email patients and failed sends stay eligible next time.)

- [ ] **Step 6: Verify it compiles**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Sanity-read the change**

Confirm by eye: the CTA only renders when `includeReviewCta`; the order in the email is sign-in button → PIN fine print → review CTA; the audit metadata records `review_cta.shown`.

- [ ] **Step 8: Commit**

```bash
git add src/lib/notifications/notify-released.ts
git commit -m "$(cat <<'EOF'
feat(notifications): once-per-patient Google review CTA in result email

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Ambient portal review card

**Files:**
- Modify: `src/app/(patient)/portal/(authenticated)/page.tsx`

RSC; verified by typecheck + build. `nothingToShow` is already computed in the page (`packages.length === 0 && standalones.length === 0`).

- [ ] **Step 1: Import the config**

At the top of `src/app/(patient)/portal/(authenticated)/page.tsx`, add to the existing imports:

```ts
import { GOOGLE_REVIEW } from "@/lib/marketing/site";
```

- [ ] **Step 2: Add the card**

Insert this block immediately after the closing `</div>` of the mobile stacked-cards section (the `<div className="mt-6 sm:hidden">…</div>`) and **before** the `{visitsWithPending.length > 0 ? (` section:

```tsx
      {!nothingToShow ? (
        <section className="mt-8 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
          <h2 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
            Enjoying DRMed?
          </h2>
          <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
            A quick Google review helps other families find trustworthy,
            affordable care.
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

- [ ] **Step 3: Verify it compiles**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(patient)/portal/(authenticated)/page.tsx"
git commit -m "$(cat <<'EOF'
feat(portal): ambient Google review card on results page

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Surface `reviewCtaShown` in the emails-log model

**Files:**
- Modify: `src/lib/emails-log/types.ts`
- Modify: `src/lib/emails-log/parse-row.ts`
- Test: `src/lib/emails-log/parse-row.test.ts`
- Modify: `src/lib/emails-log/csv.test.ts` (keep typecheck green — `entry()` base needs the new required field)

- [ ] **Step 1: Write the failing parse-row tests**

In `src/lib/emails-log/parse-row.test.ts`, append to the `describe("parseEmailLogRow", …)` block:

```ts
  it("result.notified — reviewCtaShown true when metadata.review_cta.shown", () => {
    const e = parseEmailLogRow(
      row({ metadata: { test_name: "CBC", email: { ok: true }, review_cta: { shown: true } } }),
      patient,
    );
    expect(e.reviewCtaShown).toBe(true);
  });

  it("reviewCtaShown is false when absent, false, or a non-result row", () => {
    expect(
      parseEmailLogRow(row({ metadata: { test_name: "CBC", email: { ok: true } } }), patient).reviewCtaShown,
    ).toBe(false);
    expect(
      parseEmailLogRow(row({ metadata: { review_cta: { shown: false } } }), patient).reviewCtaShown,
    ).toBe(false);
    expect(
      parseEmailLogRow(
        row({ action: "appointment.booked.notified", metadata: { review_cta: { shown: true } } }),
        patient,
      ).reviewCtaShown,
    ).toBe(false);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/emails-log/parse-row.test.ts`
Expected: FAIL — `reviewCtaShown` is `undefined` (not on the parsed entry).

- [ ] **Step 3: Add the field to the type**

In `src/lib/emails-log/types.ts`, add to the `EmailLogEntry` interface (e.g. after `visitId`):

```ts
  reviewCtaShown: boolean; // result emails only: did this email carry the review CTA
```

- [ ] **Step 4: Set the field in the parser**

In `src/lib/emails-log/parse-row.ts`, in the object returned by `parseEmailLogRow`, add (e.g. after `visitId: asString(meta.visit_id),`):

```ts
    reviewCtaShown: type === "result" && asObject(meta.review_cta).shown === true,
```

- [ ] **Step 5: Keep the CSV test helper type-valid**

In `src/lib/emails-log/csv.test.ts`, the `entry()` helper builds a full `EmailLogEntry`. Add the new required field to its base object (e.g. after `visitId: "v1",`):

```ts
    reviewCtaShown: false,
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/emails-log/parse-row.test.ts src/lib/emails-log/csv.test.ts`
Expected: PASS (new parse-row cases pass; csv tests still pass with the added field).

- [ ] **Step 7: Verify typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/emails-log/types.ts src/lib/emails-log/parse-row.ts src/lib/emails-log/parse-row.test.ts src/lib/emails-log/csv.test.ts
git commit -m "$(cat <<'EOF'
feat(emails-log): parse review_cta.shown into reviewCtaShown

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Add the "Review ask" column to the CSV export

**Files:**
- Modify: `src/lib/emails-log/csv.ts`
- Test: `src/lib/emails-log/csv.test.ts`

- [ ] **Step 1: Update the failing header assertion + add a column test**

In `src/lib/emails-log/csv.test.ts`, update the existing header assertion in the `"emits a header row then one row per entry"` test to include the new trailing column:

```ts
    expect(lines[0]).toBe(
      '"Sent (ISO)","Type","Status","Recipient","DRM-ID","Email","Resend ID","Detail","Review ask"',
    );
```

Then add a new test to the `describe("emailLogToCsv", …)` block:

```ts
  it("emits the review-ask column (yes when the CTA was sent)", () => {
    const csv = emailLogToCsv([entry({ reviewCtaShown: true })]);
    const line = csv.split("\r\n")[1];
    expect(line.endsWith('"yes"')).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/lib/emails-log/csv.test.ts`
Expected: FAIL — header assertion mismatch (no "Review ask"), and the new row does not end with `"yes"`.

- [ ] **Step 3: Add the column to the CSV builder**

In `src/lib/emails-log/csv.ts`, add `"Review ask"` to the end of the `HEADERS` array:

```ts
const HEADERS = [
  "Sent (ISO)",
  "Type",
  "Status",
  "Recipient",
  "DRM-ID",
  "Email",
  "Resend ID",
  "Detail",
  "Review ask",
];
```

And add the cell to the end of the per-row array (after `cell(e.detail),`):

```ts
        cell(e.detail),
        cell(e.reviewCtaShown ? "yes" : ""),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/emails-log/csv.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/emails-log/csv.ts src/lib/emails-log/csv.test.ts
git commit -m "$(cat <<'EOF'
feat(emails-log): add Review ask column to CSV export

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: "Review ask ✓" badge on the Emails-sent page

**Files:**
- Modify: `src/app/(staff)/staff/(dashboard)/admin/emails-sent/page.tsx`

RSC; verified by typecheck + build. The badge goes in the **Details** `<td>` (the cell that renders `e.detail` + the Resend id + the `—` fallback).

- [ ] **Step 1: Add the chip and update the `—` fallback condition**

In the Details cell of the row map, the current cell is:

```tsx
                    <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)]">
                      {e.detail ? <span>{e.detail}</span> : null}
                      {e.resendId ? (
                        <span className="mt-0.5 block font-mono text-[10px] text-[color:var(--color-brand-text-soft)]">
                          {e.resendId}
                        </span>
                      ) : null}
                      {!e.detail && !e.resendId ? "—" : null}
                    </td>
```

Replace it with (adds the chip; the `—` fallback now also accounts for the chip so a chip-only row doesn't show a stray dash):

```tsx
                    <td className="px-4 py-3 text-xs text-[color:var(--color-brand-text-mid)]">
                      {e.detail ? <span>{e.detail}</span> : null}
                      {e.resendId ? (
                        <span className="mt-0.5 block font-mono text-[10px] text-[color:var(--color-brand-text-soft)]">
                          {e.resendId}
                        </span>
                      ) : null}
                      {e.reviewCtaShown ? (
                        <span className="mt-0.5 inline-block rounded-md bg-cyan-100 px-2 py-0.5 text-xs font-semibold text-cyan-900">
                          Review ask ✓
                        </span>
                      ) : null}
                      {!e.detail && !e.resendId && !e.reviewCtaShown ? "—" : null}
                    </td>
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(staff)/staff/(dashboard)/admin/emails-sent/page.tsx"
git commit -m "$(cat <<'EOF'
feat(emails-log): Review ask badge on Emails-sent result rows

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `npm run typecheck`
Expected: PASS, no errors.

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: 0 errors (warnings tolerated only if pre-existing).

- [ ] **Step 3: Unit tests**

Run: `npm test`
Expected: PASS — all suites green, including the new `branded-email`, `parse-row`, and `csv` cases (≥ 343 tests; baseline was 338 + ~5 new).

- [ ] **Step 4: Production build**

Run: `npm run build`
Expected: build succeeds (RSC routes compile, no type errors).

- [ ] **Step 5: Final manual sanity (no code)**

Confirm against the spec:
- Result email includes the navy review CTA **after** the PIN fine print, only on a first delivered email.
- Portal card shows only when there is ≥1 released result; link opens in a new tab.
- Emails-sent page shows the cyan "Review ask ✓" chip on the result row where the CTA was sent; CSV export has the "Review ask" column.

- [ ] **Step 6: Push the branch and open the PR (when ready)**

```bash
export PATH="/opt/homebrew/bin:$PATH"
git push -u origin feat/review-collection-cta
gh pr create --title "feat(seo): post-visit Google review CTA (Tier 2 feat 3)" \
  --body "See docs/superpowers/specs/2026-06-18-review-collection-cta-design.md. Once-per-patient review CTA in the result-ready email + ambient portal card + admin 'review ask sent' badge/CSV. No migration. aggregateRating deferred (Google bans self-serving clinic stars)."
```

---

## Self-review (completed during planning)

- **Spec coverage:** §1 → Task 1; §2 → Task 2; §3 → Task 3; §4 → Task 4; §5 → Task 5; §6 → Tasks 6–8; testing plan → Task 9. All in-scope sections have a task. Out-of-scope/follow-on items are intentionally not tasked.
- **Placeholder scan:** no TBD/TODO; every code step shows full code and exact commands.
- **Type consistency:** `GOOGLE_REVIEW.url` (string) used in Tasks 1/4/5; `reviewCtaShown: boolean` defined in Task 6 and consumed in Tasks 6/7/8; `patientAlreadyAskedForReview(admin, patientId)` defined in Task 3, called in Task 4 with the existing `admin` client and `patient.id`; `emailReviewCta(url)`/`emailDivider()` defined in Task 2, used in Tasks 2/4.
- **No-migration invariant:** holds — only reads/writes existing `audit_log.metadata`; `idx_audit_log_patient_id` confirmed present.
