# Google Ads conversion tracking — verification runbook

How to prove the tracking works, and that it stays inside the limits recorded in
[ADR-0004](decisions/0004-google-ads-conversion-tracking.md).

Part 1 is automated and already passing. Parts 2, 3 and 4 need the Google Ads
UI, so they have to be run by an account admin — Part 2 once, to mint the two
conversion labels the code expects; Part 3 after the first real traffic; and
Part 4 to unlink two destinations that should never have been on this tag.

**Status as of 2026-09-10.** Part 2 is **done** — both actions exist, both
labels are live in production, and the stale codeless actions that would have
double-counted are gone. Part 3 is **half done**: the Messenger conversion has
fired end to end against the live account; the booking leg waits on a real
`/schedule` submission. Part 4 is **closed without unlinking either
destination** — one by the owner's choice, one because the control does not
exist in this account's UI — which promotes the `ga-disable` flags from
stopgap to permanent enforcement. Each part carries its own status box; read
those before repeating any of it.

The failure mode to keep in mind throughout: **a blocked or misconfigured
Google tag fails silently.** No user-visible error, no exception, no clue in
the application — Google Ads just keeps reporting zero conversions, exactly as
it did before this feature existed. Never conclude "it works" from the absence
of an error; only from the checks below.

---

## Part 1 — Automated (no credentials needed)

```bash
npm test               # consent gate, configuration gate, exact gtag payload
npm run typecheck
npm run lint
```

### Consent gates, verified in a real browser

Run `npm run dev` with `NEXT_PUBLIC_GOOGLE_ADS_ID` set, open
`http://localhost:3000/`, and check each row.

| State | Expected | How to check |
|---|---|---|
| First visit | Banner shown; **no** tag; `window.gtag` undefined; no `_gcl_*` cookies; no request to `googletagmanager.com` | DevTools → Console + Application → Cookies + Network |
| After **Accept** | Banner gone; `gtag/js?id=AW-…` loads **200**; `window.gtag` is a function; `drmed_cookie_consent=granted` | Same |
| Reload after Accept | Banner stays gone; tag mounts automatically | Same |
| After **Decline** | Page reloads; tag gone; `window.gtag` undefined; **no Google or Meta script left in the DOM**; `drmed_cookie_consent=denied` | Same |
| After **Decline**, cookies | A `_gcl_au` / `_fbp` written under an earlier *grant* survives. Decline stops new tracking; it does not retro-delete. Same for the Meta Pixel — not a broken gate | Application → Cookies |
| Footer → **Cookie preferences** | Banner reopens so the choice can be changed | Click it |

### CSP — the one that breaks silently

With the tag accepted, the Console must contain no `Refused to load` /
`Refused to connect` message naming a Google host — **with one deliberate
exception, below.** For anything else, the missing origin belongs in
`next.config.ts` (see the table in ADR-0004); the tag will otherwise look
mounted while every conversion is dropped in the browser.

> **`ad.doubleclick.net/ccm/s/collect` is blocked on purpose. Do not "fix" it.**
> On production (not on localhost — this one only shows up on the real domain)
> the tag tries one call to `ad.doubleclick.net` and the CSP refuses it. That
> host is Google's advertising cookie-sync / remarketing endpoint, which
> ADR-0004 forbids for a health provider; it is not on the allowlist, and it
> should stay off it. Conversions do not travel through it — they use
> `googleadservices.com` → `googleads.g.doubleclick.net` → `www.google.<tld>`,
> verified separately — so a console error naming *this* host means the policy
> is doing its job. Adding it would quietly re-open the remarketing sync the
> `allow_ad_personalization_signals: false` setting exists to prevent.
>
> Confirmed on `https://drmed.ph` on 2026-09-09. If Part 3 ever shows
> conversions failing to register on production while everything else here
> passes, this is the first assumption to re-test — but do not widen the CSP
> speculatively to chase it.

```
Network tab, after Accept — expected 200:
  www.googletagmanager.com/gtag/js?id=AW-868551722
  www.google.com/ccm/collect?…&tid=AW-868551722&en=page_view&npa=1
```

That is the whole of it on a plain page load. Google has moved this around
before — an older tag build also fetched
`www.googleadservices.com/pagead/conversion_async.js` — so treat the exact
second request as informative, not as a pass/fail criterion. The two that
matter are: `gtag/js` returns **200**, and nothing is refused.

Everything else — `googleadservices.com`, `googleads.g.doubleclick.net`,
`www.google.com.ph` — only appears once a conversion actually **fires**, which
is what the host-chain section below covers. A page load alone exercises barely
half the CSP allowlist, so "no errors on the homepage" is not evidence the
conversion path works.

### What must NOT be on the page

Confirm in the Elements tab that the inline `google-tag-init` script still
carries `allow_enhanced_conversions: false` and
`allow_ad_personalization_signals: false`. Every request the tag makes must
carry **`npa=1`** in its query string — that is the externally checkable proof
that ad personalisation is off, and it is worth spot-checking in the Network
tab rather than trusting the config line alone.

Enhanced conversions need a subtler check. The tag still sends its enhanced-
conversions *diagnostics* — you will see `gtm_ee=1` and a handful of `ec_*`
parameters (`ec_mode=a`, `ec_sel`, `ec_lat=0`) on the conversion beacon even
with the feature off. Those are Google reporting on its own auto-detection,
not user data. The check that actually matters is that **no hashed identifier
rides along**: there must be no long hex value in an `em=` / `ph=` /
`ad_*` parameter. (`em=tv.1~ec.e3` is a status code, not a hash.) If a 64-char
hex string ever appears there, a visitor's email or phone number is being
uploaded and ADR-0004 has been broken.

### The two linked destinations — GA4 and Merchant Center

The account's tag id does not resolve to Google Ads alone. Loading
`gtag/js?id=AW-868551722` pulls a config that **also lists a GA4 property
`G-2R14BG8YRD` and a Merchant Center stream `MC-ZYRJZLN5TE`** — confirmed on
2026-09-08 by grepping the served `gtag.js`. Nobody asked for a behavioural
analytics stream on a clinic's website and ADR-0004 says there isn't one; both
are almost certainly Shopify-era leftovers, like the Google Shopping conversion
actions the September 2026 audit found in the same account.

`<GoogleTag>` closes this in code with Google's documented `ga-disable-<ID>`
flags, set before `gtag.js` loads. **The CSP alone is not enough** — the GA4 hit
rides `www.google.com`, the same host the conversion beacon needs, so it would
sail straight through the allowlist.

Check it like this, with the tag accepted:

| Check | Expected | Where |
|---|---|---|
| `window['ga-disable-G-2R14BG8YRD']` | `true` | Console |
| `window['ga-disable-MC-ZYRJZLN5TE']` | `true` | Console |
| Any request with `tid=G-…` or `tid=MC-…` | **none** | Network, filter `google` |
| Cookies `_ga`, `_ga_2R14BG8YRD`, `_ga_ZYRJZLN5TE` | **none** | Application → Cookies |
| Cookie `_gcl_au` | present — this one is wanted (the Ads conversion linker) | Same |

The cookie row is the load-bearing one, and it needs a **clean slate**: delete
any `_ga*` cookies before reloading. They persist for two years, so a browser
that visited the site before this feature shipped will still be carrying them
and the check will look failed when it is not.

> **Verified in a browser on 2026-09-09** (dev server, consent granted, `_ga*`
> cleared first): both flags `true`; the only page-view hit was
> `www.google.com/ccm/collect` with `tid=AW-868551722` and `npa=1`; no GA4 or
> Merchant Center request of any kind; and of the Google cookies only `_gcl_au`
> came back. The stale `_ga_2R14BG8YRD` and `_ga_ZYRJZLN5TE` cookies found
> before clearing are what the leak looked like on 2026-09-08, before the flags
> existed — so the leak was real, and the flags close it.

**This was written as a workaround, and it is now the permanent enforcement.**
Part 4 was attempted on 2026-09-10 and neither destination was unlinked — GA4
by the owner's choice, Merchant Center because the control does not exist in
this account's UI. Treat these checks as load-bearing, not as belt-and-braces,
and see Part 4 before touching the flags.

### The conversion beacon's real host chain

Firing a conversion is the only way to exercise the rest of the CSP, and the
chain is longer than it looks. Verified end to end on 2026-09-09 by clicking
the Messenger button with a test label configured — all five hosts, in order:

```
www.googleadservices.com/pagead/conversion/868551722/    200
www.googleadservices.com/ccm/conversion/868551722/       200
googleads.g.doubleclick.net/pagead/viewthroughconversion 302 ─┐
www.google.com/pagead/1p-conversion/868551722/           302 ─┤ redirect chain
www.google.com.ph/pagead/1p-conversion/868551722/        200 ←─┘
```

That last hop is why `https://www.google.com.ph` is in the CSP: Google
redirects the conversion ping to the **visitor's country domain**. A Philippine
visitor lands on `.com.ph`; drop it from the allowlist and every conversion
from the clinic's actual market is blocked, while your own testing from
elsewhere looks fine.

The conversion also fired cleanly on a click that opens a new tab, with no
`event_callback` delayed-navigation dance — the page is never torn down
mid-beacon, which is the assumption `TrackedMessengerLink` is written on.

The booking conversion shares this exact code path (`googleAdsConversion()`,
one label apart) and is covered by unit tests; its live browser leg is Part 3,
because a real `/schedule` submission needs a database behind it.

---

## Part 2 — Create the two conversion actions (Google Ads UI, once)

> **DONE on 2026-09-10.** Both actions exist and both labels are live in the
> production bundle. Kept below because the steps are the record of how the
> account is configured, and because the UI defaults are wrong in six places
> (see *What the wizard gets wrong*) — anyone creating a third conversion
> action will hit every one of them.
>
> | | id | category | count | window | label |
> |---|---|---|---|---|---|
> | `Booking submitted` | 7756723341 | `SUBMIT_LEAD_FORM` | Every | 30d | `tYRBCI3p2PIcEKqYlJ4D` |
> | `Messenger chat started` | 7756758861 | `CONTACT` | One | 30d | `gUfcCM3-2vIcEKqYlJ4D` |
>
> Both: primary, value "same value" ₱1, data-driven attribution, enhanced
> conversions off. The labels are not secrets — they ship in the client bundle
> and are readable by anyone who opens DevTools on drmed.ph.

> **Prerequisite, and the first thing to check: `NEXT_PUBLIC_GOOGLE_ADS_ID` is
> not set in Vercel production.** Verified against the live site on 2026-09-09,
> straight after this feature merged: the new code is deployed (the CSP names
> the Google hosts, and the client bundle carries the `ga-disable` flags), but
> with consent granted `window.gtag` is still `undefined` and the tag id
> appears nowhere in the served page. **The tracking is inert until someone
> adds it.**
>
> Vercel → project → Settings → Environment Variables →
> `NEXT_PUBLIC_GOOGLE_ADS_ID` = `AW-868551722`, Production, then **redeploy**.
> It is a `NEXT_PUBLIC_*` var, inlined at build time, so setting it without a
> redeploy changes nothing.
>
> This is the feature's whole failure mode in miniature: everything looks
> shipped, nothing is measured, and no error is raised anywhere. Re-run the
> Part 1 browser checks against `https://drmed.ph` after the redeploy — if
> `window.gtag` is still undefined with consent granted, the var did not take.

The code ships both conversion **labels blank**, because a label only exists
once its conversion action does. Until a label is filled in, that conversion is
silently disabled — by design, so the tag can go live before the actions exist.

For each of **Booking submitted** and **Messenger chat started**:

1. Google Ads → **Goals → Conversions → New conversion action → Website**.
2. Enter `drmed.ph`, then **Add a conversion action manually** (not a scan —
   these are event-based, not codeless).
3. Category: **Submit lead form** for the booking, **Contact** for Messenger.
4. Count: **Every** for the booking (two bookings from one person are two
   bookings); **One** for Messenger (one chat is one lead, however many times
   the button is tapped).
5. Value: leave the default, or set a single default value. The site never
   sends a per-conversion value — ADR-0004 explains why.
6. **Tag setup → Install the tag yourself.** The event snippet shows
   `'send_to': 'AW-868551722/<label>'`. Copy **only the part after the slash**.
7. Put the labels in Vercel → project → Settings → Environment Variables,
   alongside the tag id from the prerequisite above:
   - `NEXT_PUBLIC_GOOGLE_ADS_ID` = `AW-868551722` (if not already set)
   - `NEXT_PUBLIC_GOOGLE_ADS_BOOKING_LABEL`
   - `NEXT_PUBLIC_GOOGLE_ADS_MESSENGER_LABEL`

   These are `NEXT_PUBLIC_*`, so they are inlined at build time — **redeploy
   after setting them**, or the site keeps the old (blank) values.

### What the wizard gets wrong

Every default below is wrong for this site, and each is silent — the action
saves happily and simply measures the wrong thing. Checked against the real UI
on 2026-09-10.

| Field | Google's default | Set it to | Why |
|---|---|---|---|
| Value | *Use different values for each conversion* | **Use the same value** (₱1) | "Different values" expects a `value` in the event snippet. The code deliberately sends none — see ADR-0004 |
| Count | *One* (for lead categories) | **Every** for booking, **One** for Messenger | Two bookings by one household are two bookings; repeat-taps of a chat button are one lead |
| Click-through window | *90 days* | **30 days** | A clinic booking decision runs days. 90 credits an ad click from three months ago |
| Enhanced conversions (per action) | **ticked** | **untick** | It uploads hashed email/phone. ADR-0004 forbids it, and the tag sets `allow_enhanced_conversions: false` — leaving it ticked creates a standing contradiction |
| Enhanced conversions (account) | **ticked**, method *Google Tag* | **untick** at Goals → Conversions → **Settings** | Separate switch from the per-action one. Not readable via the API — the only field exposed is `enhanced_conversions_for_leads_enabled`, which is the *different* "for leads" feature |
| Scan screen data sources | DRMed Tag ✅ **and** the GA4 property offered | tag ✅, **GA4 unticked** | Ticking GA4 builds the action as a GA4 event import instead of a direct Ads conversion — the code sends neither |

> **The navigation trap that cost the most time.** "Overwrite the placeholder
> name" is only safe inside the creation wizard. Clicking a *goal* name or an
> *action* name from Goals → Summary opens an **existing** action's edit page,
> which looks nearly identical — and renaming there silently repurposes a live
> action. On 2026-09-10 this renamed the Google-hosted `Clicks to call`
> (6875287661) to `Messenger chat started`; it has no event snippet and no
> label, so it could never have fired from the site, while every real call
> click would have reported as a Messenger chat. Restored the same day.
>
> **Always start from the blue `+ New conversion action` button**, and before
> typing a name check the page: the creation form has a *Manually with code /
> Automatically without code* radio pair and no dates. An edit page has
> **Conversion type ID** and **Date created** rows. If you see those, back out.

### Then tidy the pre-existing conversions

Now that a tag exists, the account's **codeless** actions start firing from
Google's automatic detection and will double-count against the two above. This
stopped being theoretical the moment the tag went live: `Book appointment` was
a `WEBPAGE_CODELESS` primary action pointed at the same `/schedule` success
flow as `Booking submitted`.

Done on 2026-09-10:

- **Removed** (not demoted) `Book appointment` (7255710670) and `Page view
  (Page load drmed.ph/pages/about-us)` (7399243879). Both codeless, both
  primary, both with **zero lifetime conversions** — so there was no history
  to preserve, and Secondary would not have helped: a secondary action still
  fires and still lands in *All conv.*, which is the column you watch while
  judging whether the new tracking works.
- **Kept primary:** `Booking submitted` · `Messenger chat started` ·
  `Clicks to call`.
- **Left alone:** the six `Google Shopping App *` actions and the four
  `Local actions - *`. Do **not** remove these. The Shopping actions hold
  **9,683 lifetime conversions** between them (Page View 6,635 · View Item
  2,688 · Begin Checkout 158 · Search 107 · Add To Cart 88 · Add Payment Info
  4 · Purchase 3, measured 2024-01-01→2026-09-10); the Local actions are live
  Google Business Profile signals. The UI's *All conv.* column shows `0.00`
  for these because it is scoped to the report date range — it is not a
  lifetime count, and reading it as one is how you talk yourself into deleting
  real data.

### The goal is the lever, not the action

Demoting a primary action to Secondary **fails** when it is the last primary
action of a goal that is in use — Google offers only *Remove*. That is the
trap that makes deleting look like the only option.

Work at the goal level instead: **Goals → Conversions → Summary → Edit goal →
Account default → Off**. The actions underneath keep their history, stay
primary inside a goal nothing consults, and reach no campaign.

Account-default goals were reduced on 2026-09-10 to exactly:

- **Submit lead form** (website) — `Booking submitted`
- **Contact** (website) — `Messenger chat started`

with Purchase, Page view, Add to cart, Begin checkout, Other, Download, Book
appointment, Get directions and Engagement all switched off.

### Campaign goals — the step that decides whether any of this is counted

A new conversion action is **not automatically counted by your campaigns.**
Google says so in a blue box during creation and it is easy to skim past:

> *"Submit lead form" is not an account default goal. This action will only be
> optimized for, and reported in the "Conversions" column when the "Submit
> lead form" goal is used in your campaigns.*

Before 2026-09-10 the live `Keyword` campaign (21792481121) used
**campaign-specific** goals whose only biddable entry was *Book appointment
(website)* — the category of the codeless action that was about to be removed.
Left as it was, every booking would have recorded and none would have appeared
in the campaign's Conversions column, and the 15-conversion bidding threshold
would never have been reached.

Cleaning the account-default set collapsed the campaign's stale override, and
the campaign inherited **Submit lead form + Contact**. Verify with:

```
campaign_conversion_goal where campaign.id = 21792481121 and biddable = true
→ SUBMIT_LEAD_FORM/WEBSITE, CONTACT/WEBSITE
```

If a campaign ever needs this set by hand: campaign → Settings → Conversion
goals → *Use account-level conversion goal settings*.

Known gap, not a regression: **`Contact (Google-hosted)` is not biddable**, and
that is the row `Clicks to call` lives in. Call clicks therefore appear in
*All conv.* but not in *Conversions*. It was already so before this work; the
goal UI toggles only the website-origin row.

### Turn off auto-apply recommendations

**Goals is not the only place Google edits this account.** Auto-apply was found
fully enabled on 2026-09-10 — 7 of 7 *Maintain your ads* and 14 of 14 *Grow
your business* — and it had already made three changes on its own:

| Date | Change | Keyword |
|---|---|---|
| 2026-08-27 | removed an enabled keyword | `blood count` (broad) |
| 2026-08-27 | removed an enabled keyword | `liver profile` (broad) |
| 2026-08-29 | added a broad keyword | `diagnosis and tests` |

`client_type: GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION` in `change_event` — not
a human. It deleted two of the most commercially relevant terms a diagnostic
clinic can bid on and replaced them with a phrase that matches almost any
medical query in the country.

All 21 recommendation types were switched off on 2026-09-10. **Keep them off.**
The set includes *Use Display Expansion* (re-enables the Display spend the
audit removed), *Add broad match keywords*, *Remove conflicting negative
keywords* (can strip the 146-term shared negative list), five separate
bid-strategy switches that would move the campaign off Maximize clicks before
the 15-conversion threshold, and *Add store visits as an account default goal*
— which would undo the goal cleanup above.

To audit what it has done: `change_event` filtered on
`client_type = 'GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION'`. The API only
retains 30 days, and `DURING LAST_30_DAYS` is rejected as "start date too old"
— pass an explicit `BETWEEN` range starting one day inside the window.

---

## Part 3 — Confirm real conversions land

> **Messenger leg: PASSED on production, 2026-09-10.** Driven with Playwright
> against `https://drmed.ph/` with consent granted — the first fire of a real
> minted label, not a test one. Full chain, in order:
>
> ```
> googleadservices.com/pagead/conversion/868551722/?…label=gUfcCM3-2vIcEKqYlJ4D&npa=1   200
> googleads.g.doubleclick.net/pagead/viewthroughconversion/868551722/                   302
> www.google.com/pagead/1p-conversion/868551722/                                        302
> www.google.com.ph/pagead/1p-conversion/868551722/                                     200
> ```
>
> `npa=1` present; **no `em=` / `ph=` / `ad_*` hashed identifier** anywhere on
> the beacon (the practical proof enhanced conversions is off, since the
> account-level switch is not readable through the API); no `tid=G-…` or
> `tid=MC-…` request; the only console errors were the two deliberate
> `ad.doubleclick.net` CSP refusals and nothing else.
>
> **Booking leg: still unproven live.** It shares the same code path one label
> apart and is covered by unit tests, but a real `/schedule` submission writes
> a real appointment, so it waits for a genuine booking. Step 3 below is how
> you confirm it landed.

1. **Google tag is live.** Google Ads → Tools → **Data manager → Google tag**
   should show the tag as active and recently seen. This can take a few hours
   after the first consenting visit.
2. **Fire one of each on production**, as a consenting visitor: accept the
   cookie banner, complete a booking through `/schedule` to the success screen,
   and tap the Messenger button.
3. **Conversion status.** Goals → Conversions → each action moves from *No
   recent conversions* to **Recording conversions**. Google's reporting lags —
   allow up to 24 hours, and up to 3 hours even for the fastest signal. A
   status still reading "Unverified" the next day means the label in the env
   var does not match the action.
4. **Attribution works end to end.** Click one of your own live search ads,
   accept cookies, and book. The conversion should appear against the campaign
   rather than under Direct — that is what proves the `gclid` survived the
   journey, and it is the whole point of the exercise.

### Only after that

Bidding stays on **Maximize clicks** until real conversions accumulate.
At **15+ tracked conversions in 30 days**, switch to Maximize conversions with
a target CPA of ₱450 (audit step 13). Switching earlier hands Google a signal
too sparse to optimise against, which is the failure this feature exists to
fix.

---

## Part 4 — Unlink GA4 and Merchant Center — CLOSED, neither was unlinked

**Attempted 2026-09-10. Neither destination was removed, and that is now the
settled state rather than an open task.** The `ga-disable` flags in
`<GoogleTag>` are therefore not a stopgap — they are the enforcement. Read
ADR-0004's "No GA4, and no Merchant Center" bullet alongside this.

**GA4 `G-2R14BG8YRD` — deliberately still linked.** The account owner chose to
keep it, wanting the option of site analytics later. The flag stops the
property collecting from drmed.ph, so the practical outcome matches the ADR;
the account and the site simply disagree on paper. If the clinic ever actually
wants GA4, that is a deliberate change: remove the id from
`UNWANTED_TAG_DESTINATIONS` in `src/components/marketing/google-tag.tsx`,
amend ADR-0004, and update the privacy notice and consent copy to disclose the
stream. Doing the first without the rest would start an undisclosed
behavioural-analytics stream on a health provider's site.

**Merchant Center `MC-ZYRJZLN5TE` — no unlink control exists.** The tag's
linked-destinations list is not reachable anywhere in this account's UI. What
looks like it in the obvious places is something else:

| Screen | What it actually governs | Safe? |
|---|---|---|
| Connected products → Google Merchant Center | the **account** link (MC `5447170217` ↔ Ads `214-641-8284`) | Actions only offers "Manage in Business Manager". Leave it — unlinking would stop the paused PMax campaign ever serving |
| Merchant Center → Apps and services | Business Manager / Business Profile access **to Merchant Center** | Do **not** "Remove access". It would break the Business Profile link feeding the free local listings |
| Goals → Conversions → Settings | conversion settings — no destination list | — |

The feed is dead regardless: every product URL it points at 404s
(`/products/vaccination-services`, `/products/fit-to-work`,
`/collections/frontpage`, checked 2026-09-10), so the ~14 Shopify-era items
cannot be serving. Rebuilding a Merchant Center feed against the current
site's URLs is a separate project, not a cleanup.

**Verification is unchanged and still passes.** Re-run the linked-destinations
table in Part 1: both flags `true`, no `tid=G-…` / `tid=MC-…` request on page
load or on a live conversion, `_gcl_au` the only Google cookie. Confirmed on
production 2026-09-10.

**Do not delete the `ga-disable` lines.** With both destinations still linked
they are the only thing stopping the two streams, so removing one is not a
tidy-up — it opens the stream. They also cost nothing, and even had the
destinations been unlinked the lines would still earn their place: a
destination can be re-linked by anyone with account access, including Google
itself, which periodically prompts to reconnect "recommended" products. The
deliberate switch, with its accompanying ADR and privacy-notice changes, is
described in Part 4.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| No `gtag/js` request at all | Consent not granted, or `NEXT_PUBLIC_GOOGLE_ADS_ID` unset in that environment — **as it was on production at merge time**. Check it first; it is the single most likely cause |
| `gtag/js` loads, conversion never fires | The action's label env var is blank, or the site was not redeployed after setting it |
| Console `Refused to …` naming a Google host | CSP in `next.config.ts` is missing that origin — **unless it names `ad.doubleclick.net`, which is blocked deliberately** (see Part 1) |
| Conversions counted twice | The codeless `Book appointment` action is still primary — demote it |
| Conversions land but show as Direct | The visitor did not arrive on a `gclid` link, or auto-tagging is off in the account |
| Everything looks right, still zero | Check an ad blocker is not eating the tag in your own browser before assuming a code fault |
| `_ga_*` cookies present despite the flags | Almost always stale — written before this feature shipped, and good for two years. Delete them and reload before concluding anything |
| A request with `tid=G-…` appears | The `ga-disable` line for that id was removed, or a *new* destination was linked to the tag. Compare the ids against `UNWANTED_TAG_DESTINATIONS` in `google-tag.tsx` |
| Conversions work for you but not for real patients | Suspect `www.google.com.ph`. Google redirects the beacon to the country domain, so a CSP that omits it fails only for the market the clinic actually advertises in |
| Action records conversions, but the campaign's **Conversions** column stays 0 | The campaign's conversion goals don't include that action's category. See *Campaign goals* in Part 2 — this is the default for a newly created category, not a fault |
| The UI offers only **Remove**, with no way to demote to Secondary | It's the last primary action of a goal that is in use. Don't remove it — turn **Account default → Off** on the goal instead (Part 2, *The goal is the lever*) |
| An old action shows `All conv. 0.00`, so it looks safe to delete | That column is scoped to the report date range, **not** lifetime. Query `metrics.all_conversions` over `segments.date BETWEEN '2024-01-01' AND <today>` before deleting anything |
| A keyword appeared or vanished that nobody added or removed | Auto-apply recommendations. Check `change_event` for `client_type = 'GOOGLE_ADS_RECOMMENDATIONS_SUBSCRIPTION'`, and confirm all 21 types are still off (Part 2) |
| A renamed action stopped working, or calls report as chat | Something was renamed on an **existing** action's edit page instead of created fresh. Check `conversion_action.type`: `GOOGLE_HOSTED` has no snippet and no label, so the site can never fire it |
