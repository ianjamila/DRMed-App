import { it } from "vitest";
import { checkCompleteQuery } from "@/lib/reports/paged-query-test-helpers";

it("send-out true-up total includes rows beyond 1,000 with stable paging", async () => {
  await checkCompleteQuery("src/lib/actions/accounting/cogs-send-out-trueups.ts", 0);
});
