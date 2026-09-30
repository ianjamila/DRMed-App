import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Codex review finding 3 (P1, 2026-09-30): restoreTestRequestsForVisit used to
// filter the READ by the exact deleted_at a bulk Undo expected (sameInstant),
// but predicate the WRITE only on "deleted_at is not null" — so a
// restore-and-re-delete landing between the read and the write still matched
// that looser predicate and got silently undone by an Undo that had nothing
// to do with it. The fix groups the validated rows by the exact deleted_at
// value read (groupIdsByDeletedAt, src/lib/queue/partial-panel.ts — its own
// grouping logic is unit-tested there) and issues one UPDATE per group, each
// predicated on `.eq("deleted_at", thatValue)`. restoreTestRequestsForVisit
// itself has no pure seam (admin client, StaffSession, audit()) — pinned here
// as source text.

const FILE = join(process.cwd(), "src/lib/actions/visits/queue-restore-core.ts");
const src = readFileSync(FILE, "utf8");

describe("restoreTestRequestsForVisit's bulk-Undo write predicates on the exact deleted_at read, not just NOT NULL", () => {
  it("groups the expectedDeletedAtOf branch's rows via groupIdsByDeletedAt", () => {
    expect(src).toMatch(/import \{ groupIdsByDeletedAt \} from "@\/lib\/queue\/partial-panel";/);
    expect(src).toMatch(/groupIdsByDeletedAt\(/);
  });

  it("the expectedDeletedAtOf branch's write predicates on the exact value, never merely NOT NULL", () => {
    const branchStart = src.indexOf("if (expectedDeletedAtOf) {", src.indexOf("let restored:"));
    expect(branchStart, "expectedDeletedAtOf write branch not found").toBeGreaterThan(-1);
    const branchEnd = src.indexOf("\n  } else {", branchStart);
    expect(branchEnd).toBeGreaterThan(branchStart);
    const branch = src.slice(branchStart, branchEnd);
    expect(branch).toMatch(/\.eq\("deleted_at",\s*deletedAtValue\)/);
    expect(branch).not.toMatch(/\.not\("deleted_at",\s*"is",\s*null\)/);
  });

  it("the manual-restore (no expectedDeletedAtOf) branch is unchanged: still predicates on NOT NULL", () => {
    const elseStart = src.indexOf("\n  } else {", src.indexOf("let restored:"));
    expect(elseStart).toBeGreaterThan(-1);
    const elseEnd = src.indexOf("\n  }\n\n  const rowById", elseStart);
    expect(elseEnd).toBeGreaterThan(elseStart);
    const branch = src.slice(elseStart, elseEnd);
    expect(branch).toMatch(/\.not\("deleted_at",\s*"is",\s*null\)/);
    expect(branch).not.toMatch(/groupIdsByDeletedAt/);
  });

  it("every write in both branches still scopes to the visit", () => {
    // Losing `.eq("visit_id", visitId)` on either branch would let a
    // same-batch id belonging to a DIFFERENT visit slip through the write.
    const writes = [...src.matchAll(/\.update\(\{ deleted_at: null[\s\S]{0,300}?\.select\("id"\)/g)];
    expect(writes.length).toBeGreaterThanOrEqual(2);
    for (const w of writes) {
      expect(w[0]).toMatch(/\.eq\("visit_id",\s*visitId\)/);
    }
  });
});
