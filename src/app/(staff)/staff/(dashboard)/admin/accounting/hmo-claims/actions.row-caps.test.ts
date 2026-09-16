import { it } from "vitest";
import { checkCompleteQuery } from "@/lib/reports/paged-query-test-helpers";

it("new batch validation includes rows beyond 1,000 with stable paging", async () => {
  await checkCompleteQuery("src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/actions.ts", 0);
});

it("add-to-batch validation includes rows beyond 1,000 with stable paging", async () => {
  await checkCompleteQuery("src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/actions.ts", 1);
});

it("settlement validation includes rows beyond 1,000 with stable paging", async () => {
  await checkCompleteQuery("src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/actions.ts", 2);
});
