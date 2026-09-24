import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LATEST_CONSENT_EVENT_ORDER } from "./latest-event";

const MIGRATIONS_DIR = join(process.cwd(), "supabase/migrations");

/** The body of the newest migration that (re)defines the consent sync trigger. */
function latestSyncFunctionSql(): string {
  const defining = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8"))
    .filter((sql) => /create\s+or\s+replace\s+function\s+public\.sync_patient_consent_state/i.test(sql));
  const sql = defining.at(-1);
  if (!sql) throw new Error("no migration defines sync_patient_consent_state");
  return sql.slice(sql.search(/function\s+public\.sync_patient_consent_state/i));
}

describe("latest consent event ordering", () => {
  it("matches the order sync_patient_consent_state uses", () => {
    const { column, ascending } = LATEST_CONSENT_EVENT_ORDER;
    const direction = ascending ? "asc" : "desc";
    expect(latestSyncFunctionSql()).toMatch(new RegExp(String.raw`order\s+by\s+${column}\s+${direction}`, "i"));
  });

  it("never orders by created_at, which ties between a grant and a withdrawal", () => {
    expect(LATEST_CONSENT_EVENT_ORDER.column).not.toBe("created_at");
  });
});
