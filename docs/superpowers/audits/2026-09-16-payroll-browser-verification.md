# Payroll sorting/paging browser verification — 2026-09-16

Code tested: `8bad83f`, rebased onto main `23d0ed1` (#188). Draft PR: #191.

## Environment and method

Authenticated against production through the existing staff session at `http://localhost:3002`. Confirmed that port 3002 runs this payroll worktree with its existing ignored `.env.local` symlink.

Both requested MCP integrations were exposed. Supabase SQL confirmed `transaction_read_only=on`. Playwright initially encountered an active shared-profile lock. After the user explicitly authorized terminating its owner, the profile reopened and reused the saved staff login.

The fetch checks used Playwright MCP `browser_evaluate`: same-origin credentialed `fetch`, then `DOMParser`. Skeleton/empty-state rows were excluded. Full row keys were compared only inside the browser; output contained counts and booleans. No screenshots, PHI output, exports, or business mutations.

Playwright MCP's transport closed during the subsequent hydrated-check attempt. The successful hydrated checks used the already-installed Playwright driver directly with the same saved profile; no permissions or allow rules were changed. Browser contexts were closed afterwards, releasing the profile.

## Fetch + DOMParser results

| List | Complete rows | Five-row page 1 / page 2 | Sort tested |
|---|---:|---:|---|
| Government Rates — SSS | 26 | 5 / 5 | MSC lower, ascending and descending |
| Government Rates — withholding tax | 6 | 5 / 1 | Taxable lower, ascending and descending |
| Holidays | 18 | 5 / 5 | Name, ascending and descending |

All six cases returned authenticated HTTP 200 responses without redirect. Each had **zero page overlap**, and concatenating page 1 and page 2 exactly matched the corresponding prefix of the full 100-row-size rendering.

- SSS effective-date ties: one tied group spanning 26 rows retained the same secondary order in both directions.
- Holiday-kind ties: two tied groups retained identical internal order in both directions.
- SSS `size=5&page=999` clamped to the last page, exactly matching page 6 with one row.

## Hydrated interactions

For each of the three populated lists above, clicked a sortable header twice and verified the displayed values' ascending/descending order. Clicked Next, went Back and Forward, changed size from 5 to 10, then went Back and Forward again.

All row comparisons passed. Next had no overlap with the preceding five rows. Size changes reset to page 1, displaying 10 SSS rows, all 6 withholding-tax rows, and 10 holidays. Both history cycles restored exactly the previous URL and rows.

Request monitoring began after initial hydration and settling, and covered same-origin `/staff/` document/fetch/XHR requests throughout the interactions. **Each list produced zero loader requests, zero document navigations, and zero non-GET/HEAD staff requests.** This directly verifies that these complete client tables do not rerun their dynamic loaders for the tested sort/page/size/history controls.

Leaves additionally passed its hydrated empty-state check: sort and size changes, Back/Forward, empty-state message, and disabled Next. It produced zero loader requests and zero writes.

## Evidence limits

Production has **0 active employees, 0 payroll periods, and 0 payroll runs**, independently confirmed by read-only SQL counts:

```sql
select 'active_employees' as metric, count(*) as n
from employees where is_active = true
union all select 'payroll_periods', count(*) from payroll_periods
union all select 'payroll_runs', count(*) from payroll_runs;
```

Consequently, run review, employee histories, and DTR cannot be exercised with populated production data; no test data was created. Leaves' two balance RPCs per employee were not exercised because its employee set is empty. The no-loader-rerun behavior is proven on the populated rates/holiday tables and the empty Leaves table; employee-dependent RPC behavior retains regression-test coverage.

This is not a >1,000-row browser stress test or an RLS equivalence proof. Large-set completeness and server-paged control behavior are covered by the branch's regression suite.

## Local and preview gates

On main `23d0ed1`: **1,902 tests pass**, TypeScript clean, lint zero errors and only the pre-existing `booking.ts:101` warning. Whitespace check passes. Vercel preview for code commit `8bad83f` succeeded. Both PRs remain drafts; no review-bot review had appeared at the time of verification.

