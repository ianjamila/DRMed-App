import { expect, it } from "vitest";
import { checkCompleteQuery } from "@/lib/reports/paged-query-test-helpers";

it("includes auto-match candidates beyond 1,000 while retaining the account and date window", async () => {
  const requests = await checkCompleteQuery(
    "src/app/(staff)/staff/(dashboard)/admin/accounting/bank-rec/actions.ts",
    0,
    { accountId: "bank-account", windowStart: "2026-09-05", windowEnd: "2026-09-11" },
  );
  for (const url of requests) {
    expect(url.pathname).toContain("/journal_lines");
    expect(url.searchParams.get("account_id")).toBe("eq.bank-account");
    expect(url.searchParams.get("journal_entries.status")).toBe("eq.posted");
    expect(url.searchParams.getAll("journal_entries.posting_date")).toEqual([
      "gte.2026-09-05", "lte.2026-09-11",
    ]);
  }
});
