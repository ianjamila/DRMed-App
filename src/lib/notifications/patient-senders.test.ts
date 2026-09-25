import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

// Every file that calls sendEmail/sendSms either messages a PATIENT — and then
// must run checkPatientRecipient right before the provider call — or is listed
// here as staff/infra with the reason.
const ROOT = process.cwd();
const NOT_PATIENT: Record<string, string> = {
  "src/lib/notifications/email.ts": "The provider wrapper itself.",
  "src/lib/notifications/sms.ts": "The provider wrapper itself.",
  "src/app/(staff)/staff/(dashboard)/admin/newsletter/actions.ts": "Newsletter subscribers, not patient records (spec: subscriptions are untouched).",
  "src/app/(staff)/staff/(dashboard)/admin/settings/alerts/actions.ts": "Test email to staff alert recipients.",
  "src/app/(staff)/staff/(dashboard)/messages/actions.ts": "Reply to a website message sender, not a patient record.",
  "src/app/api/cron/dedup-digest/route.ts": "Staff digest.",
  "src/app/api/cron/stale-bookings/route.ts": "Staff reminder (Bookings not acted on).",
  "src/app/api/cron/template-health/route.ts": "Staff alert.",
  "src/lib/appointments/booking-alert.ts": "Staff alert about a booking.",
  "src/lib/contact-messages/alert.ts": "Staff alert about a website message.",
  "src/lib/visits/released-payment-alert.ts": "Staff alert (Admin Tools › Email Alerts, released_payment_removed) about a payment change leaving a visit owing after release — recipients come from resolveStaffAlertRecipients, never the patient.",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const full = join(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(full) && !/\.test\./.test(full)) out.push(full);
  }
  return out;
}
const rel = (f: string) => relative(ROOT, f).split(sep).join("/");
const senders = walk(join(ROOT, "src")).filter((f) => /\b(sendEmail|sendSms)\s*\(/.test(readFileSync(f, "utf8"))).map(rel);

describe("patient notifications check the recipient is active", () => {
  it("finds the senders", () => expect(senders.length).toBeGreaterThan(8));
  it("every patient sender calls checkPatientRecipient", () => {
    const bad = senders
      .filter((f) => !NOT_PATIENT[f])
      .filter((f) => !/checkPatientRecipient\s*\(/.test(readFileSync(join(ROOT, f), "utf8")));
    expect(bad, "Gate the send with checkPatientRecipient, or add the file to NOT_PATIENT with a reason.").toEqual([]);
  });
  it("has no stale NOT_PATIENT entries", () => {
    expect(Object.keys(NOT_PATIENT).filter((f) => !senders.includes(f))).toEqual([]);
  });
});
