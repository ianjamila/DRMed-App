# Website Messages inbox, appointment source, retire Inquiries — 2026-09-24

Owner request (2026-09-24): "should I just remove Inquiries … we can just lead customers to
Appointments" → then "include all the also-worth-considering and fix it".

## What prod showed (read-only, 2026-09-24)

- `inquiries`: **0 rows ever.** Staff-only manual log; nothing on the website fed it, although
  its sidebar tooltip claimed it held "website chat or Messenger" inquiries.
- `contact_messages` (the public /contact form, since 0004): **17 messages, none handled, no
  staff screen and no alert** — 5 in the last 14 days (online booking was paused 2026-09-23 and
  the site now says "contact us to book"). Every one carries a phone or email. 1 is Corporate/HMO.
- `appointments`: 125 rows / 55 booking groups; 124 rows came through /schedule (the
  `appointment.booked` audit rows, `via = schedule`), 1 group was staff-made. Ad attribution
  existed only in audit metadata (5 rows carry UTM).
- 0004 left an anon `with check (true)` INSERT policy on `contact_messages`: anyone with the
  public anon key could write rows directly, skipping the honeypot and rate limit.

## Decisions

1. **Retire Inquiries** — pages, nav item, route name, labels, schema, the two reception
   dashboard cards (`reception.open_inquiries`, `reception.strip_inquiries`), the wipe-script
   entry, tests. `drop table inquiries` refuses if rows have appeared. Stale
   `dashboard_card_prefs` rows for the removed ids are ignored by `hiddenCardIdsFor` — no cleanup.
2. **Website Messages inbox** at `/staff/messages` (reception + admin), in the Front Desk
   subgroup renamed **"Messages & Bookings"** (Appointments, Website Messages).
   - Status `new → replied → booked | closed` (+ reopen). `booked` is set only by booking from
     the message (`linked_appointment_id` = the lead appointment row). `handled_by/at` = who last
     changed the status.
   - Kind `general | corporate` — `corporate` when the form subject is `CORPORATE_SUBJECT`
     ("Corporate / HMO"); staff may reclassify.
   - Staff notes (≤ 2000 chars). What the sender wrote is immutable (**P0053**).
   - The sender's first-party UTM cookie is stored as `attribution`.
   - RLS: no anon access at all (the form inserts with service role); reception/admin SELECT +
     UPDATE; no DELETE through a JWT ("Closed" dismisses, spam included).
3. **Alerts** — a count badge on the sidebar item and two reception dashboard cards (+ one admin
   card), and an email per new message to `CONTACT_ALERT_EMAILS` (comma list) or, when unset,
   every active reception + admin account. **The email carries no message body and no contact
   details** (RA 10173 — staff sign in to read it): first name, subject, corporate flag, a
   button to the message. Audited as `contact_message.alert_sent`.
4. **Book appointment from a message** — reuses the standard "+ New appointment" slide-over
   (`createStaffAppointmentAction` → `createAppointmentGroup` → the slot-guarded RPC), opened
   pre-filled via `/staff/appointments?from_message=<id>`. The legacy inquiry booking path
   inserted into `appointments` directly and bypassed the slot guard; it is deleted, not copied.
5. **Appointment source** — `appointments.source` (nullable; NULL = "Not recorded") +
   `appointments.attribution`. Public /schedule stamps `online_booking` / `patient_portal`; the
   staff slide-over asks "How did they reach us?" (required); booking from a message stamps
   `website_message` and copies the message's attribution. Backfilled from the audit trail.
6. **Send a quote from a message** — `/staff/quote?message=<id>` greets the sender by first
   name in the copied quote and offers "Mark message as replied" afterwards. The quote builder
   still saves nothing (unchanged).
7. **Booking Sources report** — a third tab in admin Marketing (`/staff/marketing/sources`):
   bookings by source and by ad campaign, website messages by type/status/campaign, and the
   message → booking rate, for a chosen period.

## Shared building blocks (already on the branch)

| File | What |
|---|---|
| `supabase/migrations/0154_website_messages_inbox.sql` | Everything in the schema; post-condition asserts |
| `src/lib/appointments/source.ts` | `APPOINTMENT_SOURCES`, labels, `STAFF_SELECTABLE_SOURCES`, `appointmentSourceLabel`, `attributionCampaignLabel` |
| `src/lib/contact-messages/labels.ts` | statuses/kinds + labels + hints, `CORPORATE_SUBJECT`, `CONTACT_SUBJECT_OPTIONS`, `contactMessageKindForSubject`, `STAFF_NOTES_MAX` |
| `src/lib/contact-messages/booking-link.ts` | `loadMessageForBooking`, `linkMessageToBooking` (server-only; pass the RLS server client) |
| `src/lib/contact-messages/website-messages-schema.test.ts` | Pins the CHECK lists to the TS vocabularies |
| `src/lib/appointments/create.ts` | `source` + `attribution` on both booking inputs |
| `src/lib/accounting/pg-errors.ts` | P0053 |
| `src/lib/staff/route-names.ts` | `/staff/messages` "Website Messages", `/staff/marketing/sources` "Booking Sources" |

## Out of scope / follow-ups

- Feeding in-system bookings per campaign into the Ad Performance tab's cost-per-booking.
- Replying to a message from inside the app (email/SMS send) — reception replies by phone,
  SMS or their own email client via the tel:/sms:/mailto: links.
- Anon/authenticated TRUNCATE grants on other public tables (repo-wide grant drift, not this PR).
