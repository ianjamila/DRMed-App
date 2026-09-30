import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLOSURE_RESCHEDULE_STATUSES, closurePreviewCounts, type ClosurePreviewRow } from "./closure-preview";

const active = { deleted_at: null, merged_into_id: null };
const row = (scheduled_at: string, patient_id: string | null, patients: ClosurePreviewRow["patients"]): ClosurePreviewRow => ({
  scheduled_at,
  patient_id,
  patients,
});

describe("closurePreviewCounts", () => {
  it("buckets by the Manila day, not the UTC day", () => {
    // 2026-12-25 00:30 Manila = 2026-12-24 16:30 UTC.
    const m = closurePreviewCounts(["2026-12-25"], [row("2026-12-24T16:30:00Z", "p1", active)]);
    expect(m.get("2026-12-25")).toEqual({ affected: 1, skippedInactive: 0 });
  });

  it("moves walk-ins with no record and active patients; leaves deleted, merged and unreadable records", () => {
    const m = closurePreviewCounts(
      ["2026-12-25"],
      [
        row("2026-12-25T01:00:00Z", null, null),
        row("2026-12-25T02:00:00Z", "p1", active),
        row("2026-12-25T03:00:00Z", "p2", { deleted_at: "2026-09-01T00:00:00Z", merged_into_id: null }),
        row("2026-12-25T04:00:00Z", "p3", { deleted_at: null, merged_into_id: "p9" }),
        row("2026-12-25T05:00:00Z", "p4", null),
      ],
    );
    expect(m.get("2026-12-25")).toEqual({ affected: 2, skippedInactive: 3 });
  });

  it("gives every closure a row (0 when nothing is booked) and ignores open days between closures", () => {
    const m = closurePreviewCounts(["2026-12-25", "2027-01-01"], [row("2026-12-28T02:00:00Z", "p1", active)]);
    expect([...m.entries()]).toEqual([
      ["2026-12-25", { affected: 0, skippedInactive: 0 }],
      ["2027-01-01", { affected: 0, skippedInactive: 0 }],
    ]);
  });
});

// The page promises "never higher than what the button actually moves", so the
// TS count must stay the RPC's dry-run count. Read the dry-run branch of the
// latest migration defining reschedule_closure_appointments and pin each rule.
describe("closure preview matches reschedule_closure_appointments' dry run", () => {
  const dir = join(process.cwd(), "supabase", "migrations");
  const latest = readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
    .filter((f) => /create\s+or\s+replace\s+function\s+public\.reschedule_closure_appointments\(/i.test(readFileSync(join(dir, f), "utf8")))
    .at(-1)!;
  const sql = readFileSync(join(dir, latest), "utf8").replace(/\s+/g, " ");
  const fnStart = sql.search(/function public\.reschedule_closure_appointments\(/i);
  const dryRun = sql.slice(sql.indexOf("if coalesce(p_dry_run, false) then", fnStart), sql.indexOf("end if;", sql.indexOf("if coalesce(p_dry_run, false) then", fnStart)));

  it("found the dry-run branch", () => {
    expect(latest).toBeTruthy();
    expect(dryRun).toMatch(/^if coalesce\(p_dry_run, false\) then/);
  });
  it("same statuses", () => {
    const list = CLOSURE_RESCHEDULE_STATUSES.map((s) => `'${s}'`).join(", ");
    expect(dryRun).toContain(`a.status in (${list})`);
  });
  it("same day window (the Manila day)", () => {
    expect(sql).toContain("v_from timestamptz := p_closed_on::timestamp at time zone 'Asia/Manila'");
    expect(sql).toContain("v_to timestamptz := (p_closed_on + 1)::timestamp at time zone 'Asia/Manila'");
    expect(dryRun).toContain("a.scheduled_at >= v_from and a.scheduled_at < v_to");
  });
  it("same moved / left-alone split", () => {
    expect(dryRun).toContain("left join public.patients p on p.id = a.patient_id");
    expect(dryRun).toContain(
      "'affected', count(*) filter (where a.patient_id is null or (p.deleted_at is null and p.merged_into_id is null))",
    );
    expect(dryRun).toContain(
      "'skipped_inactive', count(*) filter (where a.patient_id is not null and (p.id is null or p.deleted_at is not null or p.merged_into_id is not null))",
    );
  });
});
