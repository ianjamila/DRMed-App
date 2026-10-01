import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LATEST_CONSENT_EVENT_ORDER } from "./latest-event";

const MIGRATIONS_DIR = join(process.cwd(), "supabase/migrations");

/** The newest migration's definition of public.<fn>, up to the end of its body. */
function latestFunctionSql(fn: string): string {
  const re = new RegExp(String.raw`create\s+or\s+replace\s+function\s+public\.${fn}\b`, "i");
  const defining = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
    .filter((sql) => re.test(sql));
  const sql = defining.at(-1);
  if (!sql) throw new Error(`no migration defines ${fn}`);
  const from = sql.slice(sql.search(re));
  const bodyEnd = from.indexOf("$$;", from.indexOf("$$") + 2);
  return bodyEnd > 0 ? from.slice(0, bodyEnd) : from;
}

describe("latest consent event ordering", () => {
  it("matches the order sync_patient_consent_state uses", () => {
    const { column, ascending } = LATEST_CONSENT_EVENT_ORDER;
    const sync = latestFunctionSql("sync_patient_consent_state");
    // 0196: the trigger delegates to recompute_patient_consent_cache, which FOLDS
    // every event in ascending seq order — the event that decides the state is
    // the LAST one, i.e. the first in descending seq order, which is what
    // LATEST_CONSENT_EVENT_ORDER must name for the app to read the same event.
    if (/recompute_patient_consent_cache\s*\(/i.test(sync)) {
      expect({ column, ascending }).toEqual({ column: "seq", ascending: false });
      expect(latestFunctionSql("recompute_patient_consent_cache")).toMatch(/order\s+by\s+(?:\w+\.)?seq\s*(?:asc\s*)?$/im);
      return;
    }
    const direction = ascending ? "asc" : "desc";
    expect(sync).toMatch(new RegExp(String.raw`order\s+by\s+${column}\s+${direction}`, "i"));
  });

  it("never orders by created_at, which ties between a grant and a withdrawal", () => {
    expect(LATEST_CONSENT_EVENT_ORDER.column).not.toBe("created_at");
  });
});
