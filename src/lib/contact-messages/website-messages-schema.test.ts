// Pins the TypeScript vocabularies to migration 0154's CHECK constraints, the
// same way online-booking-copy.test.ts pins PAUSED_MESSAGE_MAX. A value added
// on one side only would either be offered in a <select> and then rejected by
// the database, or be stored and then render as "Unknown" / "Not recorded".
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APPOINTMENT_SOURCES } from "@/lib/appointments/source";
import { ContactSchema } from "@/lib/validations/contact";
import {
  CONTACT_FORM_LOCATIONS,
  CONTACT_MESSAGE_KINDS,
  CONTACT_MESSAGE_STATUSES,
  CORPORATE_SUBJECT,
  STAFF_NOTES_MAX,
  REPLY_CHANNELS,
  REPLY_OUTCOMES,
  REPLY_BODY_MAX,
} from "@/lib/contact-messages/labels";

const MIGRATION = readFileSync(
  join(__dirname, "../../../supabase/migrations/0154_website_messages_inbox.sql"),
  "utf8",
);

const MIGRATION_0156 = readFileSync(
  join(__dirname, "../../../supabase/migrations/0156_contact_message_form_location.sql"),
  "utf8",
);

// The quoted literals inside `check (<column> in (...))` for a named constraint.
function checkList(constraint: string, column: string, sql: string = MIGRATION): string[] {
  const re = new RegExp(
    `constraint\\s+${constraint}\\s+check\\s*\\((?:${column}\\s+is\\s+null\\s+or\\s+)?${column}\\s+in\\s*\\(([^)]*)\\)`,
    "i",
  );
  const m = re.exec(sql);
  if (!m) throw new Error(`constraint ${constraint} not found`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe("0154 CHECK constraints match the TypeScript vocabularies", () => {
  it("appointments.source", () => {
    expect(checkList("appointments_source_check", "source")).toEqual([...APPOINTMENT_SOURCES]);
  });

  it("contact_messages.status", () => {
    expect(checkList("contact_messages_status_check", "status")).toEqual([...CONTACT_MESSAGE_STATUSES]);
  });

  it("contact_messages.kind", () => {
    expect(checkList("contact_messages_kind_check", "kind")).toEqual([...CONTACT_MESSAGE_KINDS]);
  });

  it("the staff-notes length cap", () => {
    const m = /char_length\(staff_notes\)\s*<=\s*(\d+)/i.exec(MIGRATION);
    expect(Number(m?.[1])).toBe(STAFF_NOTES_MAX);
  });

  it("contact_message_replies.channel", () => {
    expect(checkList("contact_message_replies_channel_check", "channel")).toEqual([...REPLY_CHANNELS]);
  });

  it("contact_message_replies.outcome", () => {
    expect(checkList("contact_message_replies_outcome_check", "outcome")).toEqual([...REPLY_OUTCOMES]);
  });

  it("the reply body length cap", () => {
    const m = /char_length\(btrim\(body\)\)\s+between\s+1\s+and\s+(\d+)/i.exec(MIGRATION);
    expect(Number(m?.[1])).toBe(REPLY_BODY_MAX);
  });

  it("the corporate backfill uses the form's subject literal", () => {
    expect(MIGRATION).toContain(`where subject = '${CORPORATE_SUBJECT}'`);
  });

  // Negative control: the parser really reads the list, so a drift is caught.
  it("detects a value missing from the TypeScript side", () => {
    expect(checkList("appointments_source_check", "source")).not.toEqual(
      APPOINTMENT_SOURCES.filter((s) => s !== "referral"),
    );
  });
});

describe("0156 contact_messages.form_location", () => {
  it("CHECK list matches CONTACT_FORM_LOCATIONS", () => {
    expect(checkList("contact_messages_form_location_check", "form_location", MIGRATION_0156)).toEqual([
      ...CONTACT_FORM_LOCATIONS,
    ]);
  });

  it("is part of the P0053 immutable set", () => {
    expect(MIGRATION_0156).toMatch(/new\.form_location is distinct from old\.form_location/);
    // The re-created guard must still cover everything 0154 locked.
    for (const col of ["name", "email", "phone", "subject", "message", "ip_address", "user_agent", "attribution", "created_at"]) {
      expect(MIGRATION_0156).toContain(`new.${col} is distinct from old.${col}`);
    }
  });
});

describe("ContactSchema form location", () => {
  const base = { name: "Juan", email: "", phone: "", subject: "", message: "Hello there, a question." };

  it("keeps a location the form sends", () => {
    for (const l of CONTACT_FORM_LOCATIONS) {
      expect(ContactSchema.parse({ ...base, formLocation: l }).formLocation).toBe(l);
    }
  });

  it("stores anything else, or nothing, as not recorded instead of rejecting the message", () => {
    expect(ContactSchema.parse({ ...base, formLocation: "<script>" }).formLocation).toBeNull();
    expect(ContactSchema.parse({ ...base, formLocation: null }).formLocation).toBeNull();
    expect(ContactSchema.parse(base).formLocation).toBeNull();
  });
});
