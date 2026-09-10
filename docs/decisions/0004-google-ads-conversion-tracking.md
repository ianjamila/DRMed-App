# ADR-0004: What Google Ads conversion tracking does and does not see

- **Status**: Accepted
- **Date**: 2026-09-08
- **Decision-makers**: drmed.ph team
- **Supersedes**: —
- **Superseded by**: —
- **Related**: [ADR-0003](0003-meta-pixel-data-handling.md) — the same question, answered for Meta

## Context

drmed.ph runs Google Search ads (account 214-641-8284). A September 2026 audit
of the live campaign found the bidding strategy set to **Maximize conversions
with zero conversions ever recorded**, because there is no Google tag on the
site at all. With no conversion signal, Google spends the daily budget wherever
clicks are cheapest rather than wherever bookings come from; the audit measured
roughly half the spend going to Display placements and two thirds of clicks to
people outside the clinic's radius.

Fixing the bidding requires a real conversion signal, which requires the tag.
That puts us back in front of the question ADR-0003 answered for Meta, with the
same two constraints:

1. **RA 10173 (Philippine Data Privacy Act).** DRMed is a Personal Information
   Controller handling sensitive personal information — health data. Processing
   requires a lawful basis, and consent must be freely given, specific, and
   informed.
2. **Google's own policies.** Google's personalised-advertising policy prohibits
   building advertising audiences around health conditions, and its Customer
   Match / Enhanced Conversions terms constrain uploading identifiers. As with
   Meta, the obligation sits on *us* — Google does not filter it for us.

The core risk is unchanged and is not the obvious one. It is a conversion
payload that carries a patient identifier, or a conversion whose *name or
parameters* imply a condition. A booking conversion tagged with the test that
was booked would tell an ad platform that a specific person is being
investigated for a specific illness.

The one thing that *is* different from ADR-0003: Google has not restricted this
advertiser. Meta categorised the drmed.ph dataset as a Health & wellness
provider and silently drops every conversion event (ADR-0003 § Outcome), which
is why `NEXT_PUBLIC_META_PIXEL_ID` is unset in production. Google Ads accepts
these conversions, so this tag is the measurement that actually works.

## Decision

### Where tracking runs

Tracking runs **only on the public marketing site**. It is never mounted on the
Patient Portal (`/portal/*`) or the Staff Portal (`/staff/*`). This is enforced
structurally, exactly as for Meta: `<GoogleTag>` is mounted by the
`(marketing)` route-group layout only. The booking form is shared with the
portal, and its portal path returns before any tracking call.

### Consent (opt-in)

Nothing loads before consent. On a first visit there is **no gtag.js script, no
network request to Google, and no `_gcl_*` cookie**. A visitor who declines, or
who ignores the banner entirely, is never tracked. There is deliberately **no
`<noscript>` fallback**, because a visitor without JavaScript cannot be shown
the banner and therefore cannot consent.

Consent is re-checked at two independent layers, so no single mistake defeats
it: the tag is not mounted, and `googleAdsConversion()` re-reads the consent
cookie on every call.

We use this hard gate rather than Google **Consent Mode** in either basic or
advanced form. Advanced consent mode would load gtag.js for everyone and send
cookieless pings before a decision, buying modelled conversions in exchange for
contacting Google about visitors who never agreed to it. That trade is
available if the undercount below becomes intolerable, but it is not the
default for a clinic.

### What we send

Exactly two conversions, with these payloads and nothing else:

| Conversion | Fired when | Parameters |
|---|---|---|
| `Booking submitted` | A public `/schedule` booking reaches the success screen | `send_to`, plus `transaction_id` |
| `Messenger chat started` | A visitor taps any Messenger link or the floating button | `send_to` only |

Plus, per conversion, whatever gtag.js attaches itself: the page URL, IP
address, user agent, and the `gclid` of the ad click that brought the visitor.

`transaction_id` is the **same random per-submission UUID** already generated
for Meta de-duplication (`src/lib/analytics/event-id.ts`). Google de-duplicates
conversions sharing a `transaction_id`, so a reloaded success screen counts
once. It is explicitly **not** the DRM-ID and not the booking group id, for the
reason ADR-0003 gives: handing a clinic record key to an ad platform creates a
join key we cannot claw back.

### What we never send

- **No patient identity.** No name, DRM-ID, email, phone, birthdate, or address.
- **No health information.** No test names, service names, package names,
  physician names, specialties, diagnoses, results, or visit history. The
  booking conversion says *a booking happened* — never *what was booked*, and
  unlike the Meta `Schedule` event it does not even carry the lab/doctor branch.
- **No conversion value or currency.** A booking's worth varies, and inventing
  a flat number would poison target-CPA bidding. Value, if wanted, is set on
  the conversion action in the Google Ads UI, where it is a reporting default
  rather than a per-patient figure.
- **No Enhanced Conversions.** Google's tag can hash and upload a visitor's
  email and phone for better attribution. It is switched off explicitly
  (`allow_enhanced_conversions: false`) and must stay off — the direct
  counterpart of the Advanced Matching ban in ADR-0003.
- **No ad personalisation or remarketing.**
  `allow_ad_personalization_signals: false` is set on the tag config, so
  browsing drmed.ph does not add anyone to an advertising audience. Conversion
  measurement and Smart Bidding are unaffected by this; audience-building is
  what it switches off, and building audiences out of people who browsed a
  clinic is exactly what a health advertiser must not do.
- **No GA4, and no Merchant Center.** Only the `AW-` Google Ads tag id is
  configured by this site — but that is not sufficient on its own, and the
  difference matters. Verified in a browser on 2026-09-08: the tag config
  Google serves for `AW-868551722` also lists **two destinations linked
  server-side in the account** — a GA4 property (`G-2R14BG8YRD`) and a Merchant
  Center stream (`MC-ZYRJZLN5TE`), almost certainly Shopify-era leftovers
  alongside the Google Shopping conversion actions the audit found. Loading the
  Ads tag therefore *tries* to open two behavioural analytics streams on a
  clinic's website that nobody asked for.

  This is closed in two places, because neither alone is enough. The CSP blocks
  most of that traffic (`analytics.google.com`, `stats.g.doubleclick.net`,
  `ad.doubleclick.net`, `merchant-center-analytics.goog` are all absent from
  the allowlist and stay absent) — but not the GA4 hit that rides
  `www.google.com`, the same host the conversion beacon needs. So the tag also
  sets Google's documented `ga-disable-<ID>` opt-out flag for both ids before
  gtag.js can send anything.

  The durable fix would be to **unlink both destinations** in Google Ads →
  Tools → Data manager → Google tag, which stops it at the source. **That was
  attempted on 2026-09-10 and neither destination was unlinked** — so the
  `ga-disable` flags are this claim's permanent enforcement, not a stopgap
  awaiting an admin:

  - **GA4 `G-2R14BG8YRD` is deliberately left linked.** The account owner
    declined to unlink it, wanting the option of site analytics later. That is
    a legitimate choice and it costs nothing today, because the flag stops the
    property collecting from drmed.ph regardless. It does mean the account and
    the site disagree on paper, which is why it is written down here.
  - **Merchant Center `MC-ZYRJZLN5TE` could not be unlinked.** The tag's
    linked-destinations control is not exposed anywhere in this account's
    Google Ads UI (Connected products offers only "Manage in Business
    Manager", which governs the *account* link, not the tag destination). The
    Merchant Center feed is dead in any case — every product URL it points at
    (`drmed.ph/products/…`, `drmed.ph/collections/frontpage`) returns 404
    since the site left Shopify.

  Verified on production 2026-09-10, with consent granted and a real
  conversion fired: both `ga-disable` flags `true`, no request carrying
  `tid=G-…` or `tid=MC-…` on page load or on the conversion, and `_gcl_au` the
  only Google cookie.

  **Therefore: do not remove the `ga-disable` lines.** They are load-bearing.
  If the clinic ever genuinely wants GA4, that is a deliberate change — remove
  the id from `UNWANTED_TAG_DESTINATIONS` in `google-tag.tsx`, amend this ADR,
  and update the privacy notice and consent copy to disclose the stream — not
  a cleanup someone does while tidying.

### Lawful basis

Consent, obtained through the existing banner, for advertising measurement only.
Care delivery does not depend on it: booking, registration, results access, and
the portal behave identically whether a visitor accepts or declines, and access
to care is never conditioned on this choice.

### Content-Security-Policy

The tag needs four Google origins reachable, and the site ships a restrictive
CSP (`next.config.ts`). A missing origin makes the tag fail **silently** — no
user-visible error, and Google Ads simply keeps reporting zero conversions.
This is the single most likely way for the feature to break, so the hosts are
listed individually and commented rather than wildcarded:

| Directive | Hosts | Why |
|---|---|---|
| `script-src` | `www.googletagmanager.com`, `www.googleadservices.com` | gtag.js, and the conversion script it pulls in turn |
| `img-src` / `connect-src` | the two above, plus `googleads.g.doubleclick.net`, `www.google.com`, `www.google.com.ph` | the conversion beacon; Google picks the country domain from the visitor's locale |
| `frame-src` | `td.doubleclick.net`, `googleads.g.doubleclick.net`, `www.googleadservices.com` | the conversion ping's iframe transport |

## Consequences

- Reported conversions **undercount**, because declining and ignoring visitors
  are invisible. This is accepted, and is the same trade ADR-0003 made. Campaign
  comparisons stay valid since the bias applies evenly across campaigns.
- The booking conversion cannot be optimised by service, package, or even
  lab-vs-doctor branch, since those are health-adjacent and are not sent.
  "A booking happened" is the ceiling.
- The audit's step 13 — switching to target CPA once 15+ conversions land in 30
  days — is gated on real volume through this tag, not on the pre-existing
  codeless actions.
- The pre-existing account conversions (`Book appointment`, a `/about-us` page
  view, and leftover Google Shopping app events) are **codeless**: they fire
  from Google's own automatic detection now that a tag exists. They must be
  demoted to secondary or removed, or they will double-count against the two
  actions defined here. That is a Google Ads UI change, not a code change.
- Anyone adding a new conversion **must** re-check this ADR. As in ADR-0003,
  the risky change is not a new conversion type; it is adding a field to an
  existing one.

## Verification

- Automated: `npm test` covers the consent gate, the configuration gate, and
  the exact gtag payload (`src/lib/analytics/google-ads.test.ts`).
- Manual: see [docs/google-ads-verification.md](../google-ads-verification.md)
  for the browser + Google Ads runbook, including confirming the CSP lets the
  tag through and that the conversion registers as "Recording conversions".

## References

- Google Ads conversion tracking with gtag.js — <https://developers.google.com/google-ads/api/docs/conversions/overview>
- Google personalised advertising policy, health restrictions — <https://support.google.com/adspolicy/answer/143465>
- Consent mode, and what basic vs advanced sends — <https://support.google.com/google-ads/answer/10000067>
- RA 10173 and NPC issuances — <https://privacy.gov.ph/data-privacy-act/>
