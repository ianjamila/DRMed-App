import { it } from "vitest";
import { checkCompleteQuery } from "@/lib/reports/paged-query-test-helpers";

it("new batch validation includes rows beyond 1,000 with stable paging", async () => {
  await checkCompleteQuery("src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/actions.ts", 0);
});

it("add-to-batch validation includes rows beyond 1,000 with stable paging", async () => {
  await checkCompleteQuery("src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/actions.ts", 1);
});

// Settlement (0184) no longer fetches items via a paged PostgREST query —
// record_hmo_settlement resolves them itself, inside the transaction, under
// row locks. Its own row-count ceiling is p_items' array size (unbounded by
// PostgREST's 1,000-row cap, which only ever applied to a SELECT).
