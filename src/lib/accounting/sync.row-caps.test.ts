import { it } from "vitest";
import { checkCompleteQuery } from "@/lib/reports/paged-query-test-helpers";

it("lab export includes rows beyond 1,000 with stable paging", async () => {
  await checkCompleteQuery("src/lib/accounting/sync.ts", 0);
});

it("consultation export includes rows beyond 1,000 with stable paging", async () => {
  await checkCompleteQuery("src/lib/accounting/sync.ts", 1);
});

it("procedure export includes rows beyond 1,000 with stable paging", async () => {
  await checkCompleteQuery("src/lib/accounting/sync.ts", 2);
});
