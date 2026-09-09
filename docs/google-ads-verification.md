# Google Ads conversion tracking — verification runbook

How to prove the tracking works, and that it stays inside the limits recorded in
[ADR-0004](decisions/0004-google-ads-conversion-tracking.md).

Part 1 is automated and already passing. Parts 2, 3 and 4 need the Google Ads
UI, so they have to be run by an account admin — Part 2 once, to mint the two
conversion labels the code expects; Part 3 after the first real traffic; and
Part 4 to unlink two destinations that should never have been on this tag.

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

With the tag accepted, the **Console must contain no `Refused to load` /
`Refused to connect` message naming a Google host.** If it does, the missing
origin belongs in `next.config.ts` (see the table in ADR-0004) — the tag will
otherwise look mounted while every conversion is dropped in the browser.

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

**This is still a workaround.** The durable fix is Part 4.

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

The code ships with `NEXT_PUBLIC_GOOGLE_ADS_ID` set and both labels blank,
because a label only exists once its conversion action does. Until a label is
filled in, that conversion is silently disabled — by design, so the tag can go
live before the actions exist.

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
7. Put the two labels in Vercel → project → Settings → Environment Variables:
   - `NEXT_PUBLIC_GOOGLE_ADS_BOOKING_LABEL`
   - `NEXT_PUBLIC_GOOGLE_ADS_MESSENGER_LABEL`

   These are `NEXT_PUBLIC_*`, so they are inlined at build time — **redeploy
   after setting them**, or the site keeps the old (blank) values.

### Then tidy the pre-existing conversions

Now that a tag exists, the account's **codeless** actions start firing from
Google's automatic detection and will double-count against the two above.
Per the audit's step 8:

- **Primary:** Booking submitted · Messenger chat started · Clicks to call
- **Secondary or removed:** `Book appointment` (codeless), `Page view (Page
  load drmed.ph/pages/about-us)`, and the leftover Google Shopping app events

---

## Part 3 — Confirm real conversions land

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

## Part 4 — Unlink GA4 and Merchant Center (Google Ads UI, once)

The `ga-disable` flags in `<GoogleTag>` are a client-side belt. This is the
braces, and it is the only fix that survives someone deleting a line of code
without knowing what it was for.

1. Google Ads → **Tools → Data manager → Google tag** → open the tag
   `AW-868551722`.
2. **Linked destinations** (also labelled *Connected products* / *Tag details*
   depending on the UI version). Both `G-2R14BG8YRD` (GA4) and
   `MC-ZYRJZLN5TE` (Merchant Center) should be listed there.
3. Unlink both. Neither belongs to a clinic website: the Merchant Center stream
   feeds a product catalogue nobody runs, and the GA4 property is a behavioural
   analytics stream ADR-0004 explicitly says the site does not have.
4. Re-run the linked-destinations table in Part 1. **Nothing should change** —
   the flags were already suppressing these — and that is the point. After this
   the code is no longer the only thing standing between the clinic's visitors
   and an analytics stream nobody signed off on.

Do this in the same sitting as the Part 2 conversion cleanup; both are tidying
the same Shopify-era wreckage.

**Do not delete the `ga-disable` lines afterwards.** They cost nothing, and a
destination that was unlinked once can be re-linked by anyone with account
access — including Google itself, which periodically prompts to reconnect
"recommended" products. If the clinic ever genuinely wants GA4, removing the
matching id from `UNWANTED_TAG_DESTINATIONS` in
`src/components/marketing/google-tag.tsx` is the deliberate switch.

---

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| No `gtag/js` request at all | Consent not granted, or `NEXT_PUBLIC_GOOGLE_ADS_ID` unset in that environment |
| `gtag/js` loads, conversion never fires | The action's label env var is blank, or the site was not redeployed after setting it |
| Console `Refused to …` naming a Google host | CSP in `next.config.ts` is missing that origin |
| Conversions counted twice | The codeless `Book appointment` action is still primary — demote it |
| Conversions land but show as Direct | The visitor did not arrive on a `gclid` link, or auto-tagging is off in the account |
| Everything looks right, still zero | Check an ad blocker is not eating the tag in your own browser before assuming a code fault |
| `_ga_*` cookies present despite the flags | Almost always stale — written before this feature shipped, and good for two years. Delete them and reload before concluding anything |
| A request with `tid=G-…` appears | The `ga-disable` line for that id was removed, or a *new* destination was linked to the tag. Compare the ids against `UNWANTED_TAG_DESTINATIONS` in `google-tag.tsx` |
| Conversions work for you but not for real patients | Suspect `www.google.com.ph`. Google redirects the beacon to the country domain, so a CSP that omits it fails only for the market the clinic actually advertises in |
