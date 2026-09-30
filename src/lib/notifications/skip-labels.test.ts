import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SKIP_REASON_LABEL, SKIP_SENDER_LABEL, skipReasonLabel, skipSenderLabel } from "./skip-labels";

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) ? [p] : [];
  });
}

describe("skip labels", () => {
  it("labels every sender that records a skipped patient message", () => {
    const senders = new Set<string>();
    for (const file of walk(join(process.cwd(), "src"))) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("auditSkippedInactiveRecipient")) continue;
      for (const m of text.matchAll(/sender:\s*"([a-z0-9-]+)"/g)) senders.add(m[1]!);
    }
    expect(senders.size).toBeGreaterThan(5);
    expect([...senders].filter((s) => !(s in SKIP_SENDER_LABEL))).toEqual([]);
  });
  it("labels every reason, and falls back to plain words for an unknown one", () => {
    for (const r of ["deleted", "merged", "missing", "lookup_failed", "walk_in"]) expect(SKIP_REASON_LABEL[r]).toBeTruthy();
    expect(skipReasonLabel("some_new_reason")).toBe("Some new reason");
    expect(skipSenderLabel("some-new-sender")).toBe("Some new sender");
  });
});
