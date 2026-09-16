import { it } from "vitest";
import { checkCompleteQuery } from "@/lib/reports/paged-query-test-helpers";

it("PF selected-entry validation includes rows beyond 1,000 with stable paging", async () => {
  await checkCompleteQuery("src/lib/actions/accounting/pf-disbursements.ts", 0);
});
