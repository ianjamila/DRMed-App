# ADR-0003: What the Meta Pixel does and does not see

- **Status**: Accepted
- **Date**: 2026-07-27
- **Decision-makers**: drmed.ph team
- **Supersedes**: —
- **Superseded by**: —

## Context

drmed.ph advertises on Facebook and Instagram and needs to know which campaigns
produce bookings. That measurement uses the **Meta Pixel** (browser) and the
**Meta Conversions API** (server).

Two obligations constrain how this may be built:

1. **RA 10173 (Philippine Data Privacy Act).** DRMed is a Personal Information
   Controller handling sensitive personal information — health data. Processing
   requires a lawful basis, and consent must be freely given, specific, and
   informed.
2. **Meta's Business Tools Terms.** Meta prohibits sending business tools data
   that includes health information, or data that could be used to infer a
   health condition about an individual. Violations can terminate the ad
   account, and the prohibition sits on *us* — Meta does not filter it for us.

The core risk in a clinic app is not the obvious one (nobody was going to POST a
lab result to Facebook). It is the **subtle** one: an event payload that carries
a patient identifier, or an event name that implies a condition — a `Schedule`
event tagged with a test name effectively tells an ad platform that a specific
person is being investigated for a specific illness.

This ADR records exactly what we send, so an auditor, a future maintainer, or a
Meta review does not have to reverse-engineer it from application code.

## Decision

### Where tracking runs

Tracking runs **only on the public marketing site**. It is never mounted on the
Patient Portal (`/portal/*`) or the Staff Portal (`/staff/*`). This is enforced
structurally: the Pixel is mounted by the `(marketing)` route-group layout only,
and the proxy refuses to write the attribution cookie on `/portal` or `/staff`
paths.

### Consent (opt-in)

Nothing loads before consent. On a first visit there is **no Pixel script, no
network request to Meta, no `_fbp`/`_fbc` cookie, and no campaign cookie**. A
visitor who declines, or who ignores the banner entirely, is never tracked.
Declining also deletes anything previously stored. There is deliberately **no
`<noscript>` fallback pixel**, because a visitor without JavaScript cannot be
shown the banner and therefore cannot consent.

Consent is re-checked at three independent layers, so no single mistake defeats
it: the Pixel is not mounted; `metaTrack()` re-reads the consent cookie on every
call; and the server-side Conversions API sender refuses to send without it.

### What we send

Exactly four event types, with these payloads and nothing else:

| Event | Fired when | `custom_data` |
|---|---|---|
| `PageView` | A public marketing page is viewed | *(none)* |
| `Schedule` | A public booking is submitted | `content_name`: booking branch (`lab_test` / `doctor_appointment`), `content_category`: `booking`, `num_items`: a count, optional `campaign` |
| `Contact` / `Lead` | Contact form, tel-link tap, or Messenger click | `content_name`: which surface (e.g. `call_click`, `contact_form`), `content_category`: page context |
| `CompleteRegistration` | A genuinely new self-registration | `content_name`: `patient_self_registration` |

Plus, per event: a random `event_id`, the page URL, IP address, and user agent.

### What we never send

- **No patient identity.** No name, DRM-ID, email, phone, birthdate, or address.
- **No health information.** No test names, service names, package names,
  physician names, specialties, diagnoses, results, or visit history. The
  `Schedule` event says *a booking happened*, and which of two broad branches it
  used — never *what was booked*.
- **No record identifiers.** The `event_id` is a random per-submission UUID
  generated solely to de-duplicate the browser and server copies of one event.
  It is explicitly **not** the DRM-ID and not the booking group id. An earlier
  draft used those real identifiers; this was rejected, because handing a clinic
  record key to an ad platform creates a join key we cannot claw back.
- **No Advanced Matching.** Meta's Pixel can hash and send emails/phones for
  better attribution. It is switched off and must stay off.
- **No health-based audiences.** We do not build custom or lookalike audiences
  from any condition, test, or service interest.

### Lawful basis

Consent, obtained through the banner, for advertising measurement only. Care
delivery does not depend on it: booking, registration, results access, and the
portal behave identically whether a visitor accepts or declines, and access to
care is never conditioned on this choice.

## Consequences

- Reported conversions **undercount**, because declining and ignoring visitors
  are invisible. This is accepted. Campaign comparisons stay valid since the
  bias applies evenly across campaigns.
- `Schedule` cannot be optimised by service or package, since service names are
  health-adjacent and are not sent. Branch-level granularity is the ceiling.
- Anyone adding a new event **must** re-check this ADR. The risky change is not
  a new event type; it is adding a field to an existing one.

## Outcome: Meta blocks the conversion events (measured 2026-07-27)

**The conversion measurement this was built for does not work, and cannot be
made to work by changing our code.**

On 2026-07-07 Meta reviewed `drmed.ph`, categorised it **Health & wellness
provider**, rejected the category request, and applied two restrictions:

- the data source is in a **core setup**
- it is **blocked from sharing certain standard events**

Measured against the live dataset on 2026-07-27, sending each event through the
Conversions API with a valid token and test event code:

| Event | API response | Arrived in Events Manager |
|---|---|---|
| `PageView` | `events_received: 1` | **Yes** (3/3 rounds) |
| `Contact` | `events_received: 1` | No |
| `Lead` | `events_received: 1` | No |
| `CompleteRegistration` | `events_received: 1` | No |
| `Schedule` | `events_received: 1` | No |

Note the trap: **the API returns success for blocked events.** Meta accepts at
ingestion and drops at processing, with no error and nothing in `messages`. A
`200` from the Graph API is not evidence an event landed — only the Test Events
view is. Anyone debugging "why are there no Schedule conversions" should start
here rather than in the application code.

The Test Events filter was confirmed wide open (Standard **and** Custom events
ticked) before concluding this, and `PageView` is reported as a *Custom event*
rather than a standard one — consistent with core setup stripping standard-event
semantics.

Consequences:

- `META_CAPI_ACCESS_TOKEN` is deliberately **not set in production**. With every
  conversion event blocked, the server leg has nothing to contribute.
- Campaign→booking attribution is served by the first-party UTM cookie instead
  (`src/lib/analytics/attribution.ts` → booking audit metadata), which is
  unaffected by any of this.
- The tracking code is kept rather than deleted: it is written, tested, and
  inert without a token, so re-enabling is a config change if the category is
  ever reviewed differently.
- A further category review can be requested 30 days after the decision (from
  ~2026-08-06). A clinic is accurately categorised as a health provider, so a
  reversal should not be planned around.

## Verification

- Automated: `npm test` covers the consent gate, the event-id contract, and
  attribution parsing (`src/lib/analytics/*.test.ts`).
- Manual: see `docs/meta-pixel-verification.md` for the Events Manager runbook,
  including confirming that browser and server events de-duplicate.

## References

- Meta Business Tools Terms, "Prohibited data" — <https://www.facebook.com/legal/terms/businesstools>
- Meta health-and-wellness advertising restrictions — <https://www.facebook.com/business/help/1966009642360827>
- RA 10173 and NPC issuances — <https://privacy.gov.ph/data-privacy-act/>
