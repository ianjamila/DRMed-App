import { it } from "vitest";
import { checkCompleteQuery } from "@/lib/reports/paged-query-test-helpers";

it("provider unbilled selection includes rows beyond 1,000 with stable paging", async () => {
  await checkCompleteQuery("src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/[providerId]/page.tsx", 1);
});

it("billed historic selection includes rows beyond 1,000 with stable paging", async () => {
  await checkCompleteQuery("src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/[providerId]/page.tsx", 2);
});

it("paid historic totals includes rows beyond 1,000 with stable paging", async () => {
  await checkCompleteQuery("src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/[providerId]/page.tsx", 3);
});

it("written-off historic totals includes rows beyond 1,000 with stable paging", async () => {
  await checkCompleteQuery("src/app/(staff)/staff/(dashboard)/admin/accounting/hmo-claims/[providerId]/page.tsx", 4);
});
