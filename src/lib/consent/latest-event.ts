// src/lib/consent/latest-event.ts
//
// Which patient_consents row is "the current one". sync_patient_consent_state
// (0087) decides patients.consent_current from the event with the highest
// `seq` — an identity column, so insertion order — NOT from created_at: a
// grant and a withdrawal can share a timestamp, and a uuid `id` tie-break
// then picks one at random. Any app read of "the latest consent event" must
// order the same way or it can show a withdrawn consent as current (or none
// after a fresh grant). latest-event.test.ts pins this to the trigger's SQL.
export const LATEST_CONSENT_EVENT_ORDER = { column: "seq", ascending: false } as const;
