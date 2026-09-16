import { it } from "vitest";
import { checkCompleteQuery } from "@/lib/reports/paged-query-test-helpers";

it("new batch selection includes rows beyond 1,000 with stable paging", async () => {
  await checkCompleteQuery("src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/batches/new/page.tsx", 0);
});
