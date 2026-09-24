import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PUBLIC_REFERRAL_OPTIONS,
  PUBLIC_REFERRAL_SOURCE_LABEL,
  REFERRAL_SOURCE_IDS,
  REFERRAL_SOURCE_LABEL,
  isReferralSource,
  referralSourceLabel,
} from "./referral-sources";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

// Every row any migration seeds into the referral_sources lookup, in file
// order: (id, label, sort_order). 0055 is the only one today; a later
// migration that adds a row is picked up here too, and must be mirrored in
// referral-sources.ts in the same PR.
function seededRows(): { id: string; label: string; sort: number }[] {
  const rows: { id: string; label: string; sort: number }[] = [];
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    const insert = /insert into public\.referral_sources\s*\([^)]*\)\s*values([\s\S]*?);/gi;
    for (const m of sql.matchAll(insert)) {
      for (const t of m[1]!.matchAll(/\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*(\d+)\s*\)/g)) {
        rows.push({ id: t[1]!, label: t[2]!, sort: Number(t[3]) });
      }
    }
  }
  return rows;
}

describe("referral source ids", () => {
  const rows = seededRows();

  it("finds the lookup's seed (guards the parser against matching nothing)", () => {
    expect(rows.length).toBe(12);
  });

  it("lists exactly the seeded ids, in the lookup's sort order", () => {
    const bySort = [...rows].sort((a, b) => a.sort - b.sort).map((r) => r.id);
    expect([...REFERRAL_SOURCE_IDS]).toEqual(bySort);
  });

  it("uses the lookup's own label as the staff label", () => {
    for (const r of rows) {
      expect(REFERRAL_SOURCE_LABEL[r.id as keyof typeof REFERRAL_SOURCE_LABEL]).toBe(r.label);
    }
  });
});

describe("public referral options", () => {
  it("offers every id once, with a patient-facing label", () => {
    expect(PUBLIC_REFERRAL_OPTIONS.map((o) => o.value)).toEqual([...REFERRAL_SOURCE_IDS]);
    for (const o of PUBLIC_REFERRAL_OPTIONS) {
      expect(o.label.trim().length).toBeGreaterThan(0);
      expect(o.label).toBe(PUBLIC_REFERRAL_SOURCE_LABEL[o.value]);
    }
  });

  it("never shows two options with the same wording", () => {
    const labels = PUBLIC_REFERRAL_OPTIONS.map((o) => o.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("names Messenger alongside Facebook, since the ads open Messenger", () => {
    expect(PUBLIC_REFERRAL_SOURCE_LABEL.online_facebook).toMatch(/messenger/i);
  });
});

describe("referralSourceLabel", () => {
  it("labels every known id, including the four the staff validation used to refuse", () => {
    expect(referralSourceLabel("online_instagram")).toBe("Instagram");
    expect(referralSourceLabel("online_tiktok")).toBe("TikTok");
    expect(referralSourceLabel("returning_patient")).toBe("Returning patient");
    expect(referralSourceLabel("gift_code")).toBe("Gift code");
  });

  it("shows an id it does not know raw instead of hiding it", () => {
    expect(referralSourceLabel("online_youtube")).toBe("online_youtube");
  });

  it("returns null for a blank value so the caller picks its placeholder", () => {
    expect(referralSourceLabel(null)).toBeNull();
    expect(referralSourceLabel(undefined)).toBeNull();
    expect(referralSourceLabel("")).toBeNull();
  });

  it("isReferralSource accepts only known ids", () => {
    expect(isReferralSource("online_facebook")).toBe(true);
    expect(isReferralSource("facebook")).toBe(false);
    expect(isReferralSource(3)).toBe(false);
  });
});
