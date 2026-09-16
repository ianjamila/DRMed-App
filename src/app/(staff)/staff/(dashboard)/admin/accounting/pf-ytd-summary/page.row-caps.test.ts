import { it } from "vitest";
import { checkCompleteQuery } from "@/lib/reports/paged-query-test-helpers";

it("PF year accruals includes rows beyond 1,000 with stable paging", async () => {
  await checkCompleteQuery("src/app/(staff)/staff/(dashboard)/admin/accounting/pf-ytd-summary/page.tsx", 0);
});
