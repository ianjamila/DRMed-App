import { it } from "vitest";
import { checkCompleteQuery } from "@/lib/reports/paged-query-test-helpers";

it("batch items includes rows beyond 1,000 with stable paging", async () => {
  await checkCompleteQuery("src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/batches/[batchId]/page.tsx", 0);
});

it("batch resolutions includes rows beyond 1,000 with stable paging", async () => {
  await checkCompleteQuery("src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/batches/[batchId]/page.tsx", 1);
});

it("batch allocations includes rows beyond 1,000 with stable paging", async () => {
  await checkCompleteQuery("src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/batches/[batchId]/page.tsx", 2);
});
