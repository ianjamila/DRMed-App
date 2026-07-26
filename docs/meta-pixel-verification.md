# Meta Pixel — verification runbook

How to prove the tracking works, and that it stays inside the limits recorded in
[ADR-0003](decisions/0003-meta-pixel-data-handling.md).

Part 1 is automated and already passing. Part 2 needs credentials that only an
account admin can mint, so it has to be run by a human once, before go-live.

---

## Part 1 — Automated (no credentials needed)

```bash
npm test               # consent gate, event-id contract, attribution parsing
npm run typecheck
npm run lint
```

### Consent gates, verified in a real browser

Run `npm run dev`, open `http://localhost:3000/privacy`, and check each row.
These were confirmed passing on 2026-07-27.

| State | Expected | How to check |
|---|---|---|
| First visit | Banner shown; **no** Pixel; `window.fbq` undefined; no `_fb*` cookies; no request to `facebook.net` | DevTools → Console + Application → Cookies + Network |
| After **Accept** | Banner gone; Pixel script present; `drmed_cookie_consent=granted` | Same |
| Reload after Accept | Banner stays gone; Pixel mounts automatically | Same |
| After **Decline** | Page reloads; Pixel gone; `_fbp`/`_fbc` deleted; `drmed_cookie_consent=denied` | Same |
| Footer → **Cookie preferences** | Banner reopens so the choice can be changed | Click it |

### Attribution cookie gates

With the dev server running:

```bash
U="utm_source=facebook&utm_campaign=c1_annual_pe"
probe () { curl -s -D - -o /dev/null -H "Cookie: $2" "$1" | grep -ci "set-cookie: drmed_attribution="; }

probe "http://localhost:3000/?$U" ""                              # expect 0 — no consent
probe "http://localhost:3000/?$U" "drmed_cookie_consent=denied"   # expect 0 — declined
probe "http://localhost:3000/?$U" "drmed_cookie_consent=granted"  # expect 1 — consented
probe "http://localhost:3000/portal/login?$U" "drmed_cookie_consent=granted"  # expect 0 — portal
probe "http://localhost:3000/staff/login?$U"  "drmed_cookie_consent=granted"  # expect 0 — staff
```

---

## Part 2 — Live, against Events Manager

> Needs `META_CAPI_ACCESS_TOKEN` and `META_TEST_EVENT_CODE`. **Not yet done** —
> the token has not been generated. Until it is, the server (Conversions API)
> leg is inert in every environment: it no-ops without a token.

### 2.1 Get the credentials

1. Events Manager → Data Sources → **DRMed Healthcare Inc - Congressional's
   pixel** (dataset `1564717654419936`).
2. **Settings → Conversions API → Generate access token.** Put it in
   `.env.local` as `META_CAPI_ACCESS_TOKEN`.
3. **Test Events** tab → copy the test code (`TEST12345`-style) into
   `META_TEST_EVENT_CODE`.

Keep `META_TEST_EVENT_CODE` set only while testing. **Remove it before
go-live**, or production conversions get tagged as test traffic and are excluded
from campaign optimisation.

### 2.2 Confirm the server leg reaches Meta

```bash
npm run verify:meta-capi -- --event Schedule
```

Expect `HTTP 200` and `events_received: 1`. The event should appear in the
**Test Events** tab within a few seconds, marked **Server**.

If it fails: a `190` means the token is expired or belongs to another pixel; a
`200` with nothing in Test Events usually means the test code is wrong.

### 2.3 Confirm browser and server de-duplicate

This is the step worth the effort — it is what stops one booking being counted
twice.

> **Do this on a deployed preview URL, not localhost.** The live pixel restricts
> which domains may send events. On `localhost:3000` the script loads and
> initialises, then the console logs *"1564717654419936 is unavailable on this
> website due to it's traffic permission settings"* and **no events are sent** —
> so the browser half of this test silently produces nothing. Either run it
> against a Vercel preview deployment, or add the test origin under Events
> Manager → your pixel → Settings → **Domains / traffic permissions**.

1. Deployed preview site, DevTools open. Accept cookies.
2. In the console, capture the id the browser will send:
   ```js
   const seen = [];
   const real = window.fbq;
   window.fbq = (...a) => { seen.push(a); return real(...a); };
   ```
3. Complete a booking on `/schedule`.
4. Read the id back:
   ```js
   seen.filter(a => a[1] === 'Schedule')
   // → ["track","Schedule",{…},{eventID:"<THE-ID>"}]
   ```
5. Send the server twin with that same id:
   ```bash
   npm run verify:meta-capi -- --event Schedule --event-id <THE-ID>
   ```
6. In **Test Events**, expect **one** `Schedule` row showing both Browser and
   Server, not two separate rows.

Two rows means de-duplication failed — check that the browser `eventID` and the
server `event_id` are byte-identical, and that both carry the same event name.

### 2.4 Confirm no personal or health data leaves

On the same booking, in DevTools → Network, filter `facebook.com/tr`, and read
the outgoing payload. Confirm against [ADR-0003](decisions/0003-meta-pixel-data-handling.md):

- [ ] No patient name, DRM-ID, email, phone, birthdate, address
- [ ] No test, service, package, physician, or specialty name
- [ ] `event_id` is a random UUID — not a DRM-ID, not a booking group id
- [ ] Advanced Matching is **off** in the pixel's settings
- [ ] `Schedule` `content_name` is only `lab_test` or `doctor_appointment`

Keep a dated screenshot of this payload. It is the cheapest evidence you have
that the Business Tools terms are being met.

### 2.5 Before go-live

- [ ] Remove `META_TEST_EVENT_CODE` from production env
- [ ] Set `NEXT_PUBLIC_META_PIXEL_ID` and `META_CAPI_ACCESS_TOKEN` in Vercel
      (Production **and** Preview)
- [ ] Re-run the Part 1 consent checks against the deployed preview URL
- [ ] Confirm the privacy notice at `/privacy` §6 matches what is actually sent
