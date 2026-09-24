import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  STAFF_ALERT_KEYS,
  STAFF_ALERTS,
  computeAlertRecipients,
  isStaffSubscribed,
  type AlertStaffMember,
} from "@/lib/notifications/staff-alerts";

// Every migration from 0155 on, in order: the key CHECK is re-created when an
// alert is added (0157 added online_booking), so the LAST definition wins, and
// seed rows accumulate across files.
const MIGRATIONS_DIR = join(__dirname, "../../../supabase/migrations");
const MIGRATION = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql") && Number(f.slice(0, 4)) >= 155)
  .sort()
  .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
  .join("\n");

describe("0155 pins the alert keys", () => {
  it("CHECK list matches STAFF_ALERT_KEYS", () => {
    const all = [...MIGRATION.matchAll(/constraint\s+staff_alert_settings_key_check\s+check\s*\(alert_key\s+in\s*\(([^)]*)\)/gi)];
    expect(all.length).toBeGreaterThan(0);
    const latest = all[all.length - 1]![1];
    const keys = [...latest.matchAll(/'([^']+)'/g)].map((x) => x[1]);
    expect([...keys].sort()).toEqual([...STAFF_ALERT_KEYS].sort());
  });

  it("every key is seeded", () => {
    for (const k of STAFF_ALERT_KEYS) expect(MIGRATION).toContain(`('${k}')`);
  });

  it("every alert has a definition", () => {
    for (const k of STAFF_ALERT_KEYS) expect(STAFF_ALERTS[k].key).toBe(k);
  });
});

const staff: AlertStaffMember[] = [
  { id: "a1", role: "admin", email: "Boss@Clinic.ph" },
  { id: "r1", role: "reception", email: "front@clinic.ph" },
  { id: "m1", role: "medtech", email: "lab@clinic.ph" },
  { id: "r2", role: "reception", email: null },
];

describe("computeAlertRecipients", () => {
  const base = {
    enabled: true,
    defaultRoles: ["reception", "admin"] as const,
    staff,
    overrides: new Map<string, boolean>(),
    extras: [],
  };

  it("uses the default roles when nobody was switched", () => {
    const r = computeAlertRecipients(base);
    expect(r.emails).toEqual(["Boss@Clinic.ph", "front@clinic.ph"]);
    expect(r.staffOn).toEqual(["a1", "r1", "r2"]);
    expect(r.staffWithoutEmail).toEqual(["r2"]);
  });

  it("an explicit switch beats the default both ways", () => {
    const r = computeAlertRecipients({
      ...base,
      overrides: new Map([
        ["a1", false],
        ["m1", true],
      ]),
    });
    expect(r.emails).toEqual(["front@clinic.ph", "lab@clinic.ph"]);
  });

  it("adds subscribed extra addresses and skips paused ones", () => {
    const r = computeAlertRecipients({
      ...base,
      extras: [
        { email: "inbox@clinic.ph", subscribed: true },
        { email: "old@clinic.ph", subscribed: false },
      ],
    });
    expect(r.emails).toEqual(["Boss@Clinic.ph", "front@clinic.ph", "inbox@clinic.ph"]);
  });

  it("deduplicates case-insensitively across staff and extras", () => {
    const r = computeAlertRecipients({ ...base, extras: [{ email: "boss@clinic.ph", subscribed: true }] });
    expect(r.emails).toEqual(["Boss@Clinic.ph", "front@clinic.ph"]);
  });

  it("a disabled alert emails nobody but still reports who would be switched on", () => {
    const r = computeAlertRecipients({ ...base, enabled: false });
    expect(r.enabled).toBe(false);
    expect(r.emails).toEqual([]);
    expect(r.staffOn).toEqual(["a1", "r1", "r2"]);
  });

  // Negative control: an override for someone in a default role must be able
  // to switch them OFF — the whole point of the picker.
  it("isStaffSubscribed honours an explicit false for a default role", () => {
    expect(isStaffSubscribed({ id: "a1", role: "admin" }, ["admin"], new Map([["a1", false]]))).toBe(false);
    expect(isStaffSubscribed({ id: "a1", role: "admin" }, ["admin"], new Map())).toBe(true);
  });
});
