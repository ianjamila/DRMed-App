-- =============================================================================
-- 0180 — Document the posted-only journal LOOKUPS so nobody "fixes" them
-- =============================================================================
-- Ledger TOTALS count status in ('posted', 'reversed') (0173, #222): reversing
-- an entry marks the original 'reversed' and posts a mirror, so a posted-only
-- report keeps the mirror, drops the original and subtracts twice. That rule
-- is LEDGER_TOTAL_STATUSES in src/lib/accounting/ledger-status.ts and
-- "Ledger totals count posted + reversed" in CLAUDE.md.
--
-- The 15 functions below read journal_entries posted-only ON PURPOSE: each
-- finds "the live entry" (idempotency, the entry to reverse, a gate), not a
-- total. Counting a reversed entry there would re-reverse a dead entry, block
-- a legitimate re-post, or recompute nothing. Each is listed in SQL_LOOKUPS in
-- src/lib/accounting/ledger-status-sql.test.ts with the same reason; these
-- comments put that reason on the object itself, where psql's \df+ and
-- Studio show it to anyone editing the function.
--
-- Metadata only: no function body, grant or row changes. `create or replace
-- function` keeps an existing comment (same oid), so a later redefinition does
-- not lose it; a `drop function` does, and must re-add it.
-- Signatures are the latest definitions: 0028, 0030, 0043, 0049, 0136, 0140,
-- 0141, 0152, 0159, 0166.
-- =============================================================================

-- The two the owner asked about ----------------------------------------------

comment on function public.coa_account_has_open_period_postings(uuid) is
  'Chart-of-accounts deactivation gate: does a LIVE posted line hit this account in an open period? '
  'Posted-only on purpose - this is a lookup, not a ledger total. A reversed original is no longer a '
  'live posting, and it is always accompanied by its posted mirror on the same account, which is '
  'what this gate sees - so a reversal still blocks deactivation while the mirror sits in an open '
  'period (the mirror has its own posting date, which can differ from the original). Do not widen to '
  'posted + reversed: that rule (LEDGER_TOTAL_STATUSES, src/lib/accounting/ledger-status.ts; '
  'CLAUDE.md "Ledger totals count posted + reversed") is for sums. Listed in SQL_LOOKUPS '
  '(src/lib/accounting/ledger-status-sql.test.ts).';

comment on function public.recompute_clinic_fee_for_unreleased() is
  'Admin scrub: zeroes clinic_fee_php on test_requests that have no LIVE posted revenue JE yet. '
  'Posted-only on purpose - this is a lookup, not a ledger total. A line whose revenue JE was '
  'reversed (undo-release or cancel) is unreleased again, so it may be recomputed; counting the '
  'reversed JE would wrongly freeze it. Do not widen to posted + reversed: that rule '
  '(LEDGER_TOTAL_STATUSES, src/lib/accounting/ledger-status.ts; CLAUDE.md "Ledger totals count '
  'posted + reversed") is for sums. Listed in SQL_LOOKUPS (src/lib/accounting/ledger-status-sql.test.ts).';

-- The other 13 SQL_LOOKUPS ---------------------------------------------------
-- Same suffix on each: posted-only is a lookup, not a total; see the rule.

comment on function public.bridge_payment_insert() is
  'GL bridge (payments insert). Posted-only journal read on purpose: idempotency - skips the insert '
  'when a live posted JE already exists for this payment. A lookup, not a ledger total; totals count '
  'posted + reversed (LEDGER_TOTAL_STATUSES, src/lib/accounting/ledger-status.ts; CLAUDE.md). '
  'Listed in SQL_LOOKUPS (src/lib/accounting/ledger-status-sql.test.ts).';

comment on function public.bridge_payment_void() is
  'GL bridge (payment void). Posted-only journal read on purpose: finds the live payment JE to '
  'reverse; a reversed one must not be reversed twice. A lookup, not a ledger total; totals count '
  'posted + reversed (LEDGER_TOTAL_STATUSES, src/lib/accounting/ledger-status.ts; CLAUDE.md). '
  'Listed in SQL_LOOKUPS (src/lib/accounting/ledger-status-sql.test.ts).';

comment on function public.bridge_payment_delete() is
  'GL bridge (payment delete). Posted-only journal read on purpose: finds the live payment JE to '
  'reverse when a payment row is hard-deleted before being voided. A lookup, not a ledger total; totals count '
  'posted + reversed (LEDGER_TOTAL_STATUSES, src/lib/accounting/ledger-status.ts; CLAUDE.md). '
  'Listed in SQL_LOOKUPS (src/lib/accounting/ledger-status-sql.test.ts).';

comment on function public.bridge_test_request_released() is
  'GL bridge (test released). Posted-only journal read on purpose: idempotency - one live revenue JE '
  'per released line; a reversed one (after an undo) lets a re-release post again. A lookup, not a '
  'ledger total; totals count posted + reversed (LEDGER_TOTAL_STATUSES, '
  'src/lib/accounting/ledger-status.ts; CLAUDE.md). Listed in SQL_LOOKUPS '
  '(src/lib/accounting/ledger-status-sql.test.ts).';

comment on function public.bridge_test_request_cancelled() is
  'GL bridge (test cancelled). Posted-only journal read on purpose: finds the live revenue JE to '
  'reverse on cancel. A lookup, not a ledger total; totals count posted + reversed '
  '(LEDGER_TOTAL_STATUSES, src/lib/accounting/ledger-status.ts; CLAUDE.md). Listed in SQL_LOOKUPS '
  '(src/lib/accounting/ledger-status-sql.test.ts).';

comment on function public.fn_undo_release_bridge() is
  'GL bridge (undo release). Posted-only journal read on purpose: finds the live revenue JE to '
  'reverse on undo-release. A lookup, not a ledger total; totals count posted + reversed '
  '(LEDGER_TOTAL_STATUSES, src/lib/accounting/ledger-status.ts; CLAUDE.md). Listed in SQL_LOOKUPS '
  '(src/lib/accounting/ledger-status-sql.test.ts).';

comment on function public.bridge_hmo_claim_resolution_insert() is
  'GL bridge (HMO claim resolution insert). Posted-only journal read on purpose: idempotency - one '
  'live JE per HMO claim resolution. A lookup, not a ledger total; totals count posted + reversed '
  '(LEDGER_TOTAL_STATUSES, src/lib/accounting/ledger-status.ts; CLAUDE.md). Listed in SQL_LOOKUPS '
  '(src/lib/accounting/ledger-status-sql.test.ts).';

comment on function public.bridge_hmo_claim_resolution_void() is
  'GL bridge (HMO claim resolution void). Posted-only journal read on purpose: finds the live '
  'resolution JE to reverse on void. A lookup, not a ledger total; totals count posted + reversed '
  '(LEDGER_TOTAL_STATUSES, src/lib/accounting/ledger-status.ts; CLAUDE.md). Listed in SQL_LOOKUPS '
  '(src/lib/accounting/ledger-status-sql.test.ts).';

comment on function public.bridge_cash_adjustment_insert() is
  'GL bridge (cash adjustment insert). Posted-only journal read on purpose: idempotency - one live '
  'JE per cash-drawer adjustment. A lookup, not a ledger total; totals count posted + reversed '
  '(LEDGER_TOTAL_STATUSES, src/lib/accounting/ledger-status.ts; CLAUDE.md). Listed in SQL_LOOKUPS '
  '(src/lib/accounting/ledger-status-sql.test.ts).';

comment on function public.bridge_cash_adjustment_void() is
  'GL bridge (cash adjustment void). Posted-only journal read on purpose: finds the live adjustment '
  'JE to reverse on void. A lookup, not a ledger total; totals count posted + reversed '
  '(LEDGER_TOTAL_STATUSES, src/lib/accounting/ledger-status.ts; CLAUDE.md). Listed in SQL_LOOKUPS '
  '(src/lib/accounting/ledger-status-sql.test.ts).';

comment on function public.ap_reverse_je_for_source(text, uuid, uuid) is
  'AP: reverses the live JE for a bill post or bill payment on void. Posted-only journal read on '
  'purpose: finds the live AP JE to reverse; a reversed one must not be reversed twice. A lookup, '
  'not a ledger total; totals count posted + reversed (LEDGER_TOTAL_STATUSES, '
  'src/lib/accounting/ledger-status.ts; CLAUDE.md). Listed in SQL_LOOKUPS '
  '(src/lib/accounting/ledger-status-sql.test.ts).';

comment on function public.payments_block_post_je_edits() is
  'Trigger guard: blocks editing a payment while its live posted JE stands. Posted-only journal read '
  'on purpose: once the JE is reversed (voided) the row is no longer on the books. A lookup, not a '
  'ledger total; totals count posted + reversed (LEDGER_TOTAL_STATUSES, '
  'src/lib/accounting/ledger-status.ts; CLAUDE.md). Listed in SQL_LOOKUPS '
  '(src/lib/accounting/ledger-status-sql.test.ts).';

comment on function public.cash_adjustments_block_post_je_edits() is
  'Trigger guard: blocks editing a cash-drawer adjustment while its live posted JE stands. Posted-only '
  'journal read on purpose: once the JE is reversed (voided) the row is no longer on the books. A '
  'lookup, not a ledger total; totals count posted + reversed (LEDGER_TOTAL_STATUSES, '
  'src/lib/accounting/ledger-status.ts; CLAUDE.md). Listed in SQL_LOOKUPS '
  '(src/lib/accounting/ledger-status-sql.test.ts).';
