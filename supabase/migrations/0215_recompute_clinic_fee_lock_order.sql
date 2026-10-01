-- 0215_recompute_clinic_fee_lock_order.sql
-- =============================================================================
-- recompute_clinic_fee_for_unreleased() locks visit -> lines, in id order, and
-- decides which lines to rewrite AFTER it holds them.
--
-- THE BUGS (reproduced by scripts/plan-order-lockers-proof.ts, scenarios R1,
-- R2a, R3-claim, R3-unclaim, R4, R5, P3):
--
--  1. LINE -> VISIT vs VISIT -> LINE. The function was ONE UPDATE over every
--     eligible line of every patient. Per row, the 0183 guard
--     (guard_test_request_on_waived_visit, BEFORE UPDATE of a money column) takes
--     that line's visit FOR UPDATE - AFTER the line's own row lock. release /
--     undo (0198/0205) take the visit FOR SHARE FIRST and the lines after. A
--     third session holding the visit FOR SHARE lines the two up: recompute holds
--     line A and queues on the visit, release holds the visit and wants A: 40P01
--     (R1, R4 undo of a released line with no posted entry, R5 two visits). The
--     payment flip is the same cycle through the package headers: its recalc
--     holds the visit and fn_release_headers_on_visit_paid wants a header
--     recompute holds (P3).
--
--  2. PLAN ORDER vs ID ORDER. The UPDATE locks lines in plan (heap) order;
--     claim / unclaim (0211) lock theirs ORDER BY id. Two lines L < H stored
--     H-then-L: recompute holds H (and its visit) and queues on L behind a
--     claim that then wants H: 40P01 (R3-claim, R3-unclaim).
--
--  3. LOST UPDATE ON A POSTED LINE (R2a). The eligible set came from a CTE
--     (`target_ids`) filtered by "no posted test_request journal entry". A
--     release that commits while the UPDATE is queued on the line posts that
--     entry - but when the UPDATE wakes, READ COMMITTED re-checks only the row it
--     waited for (EvalPlanQual) against the OLD statement snapshot, the CTE is
--     not re-run, the line still "qualifies" and its clinic_fee_php /
--     doctor_pf_php are rewritten under a posted entry.
--
-- THE FIX - one global lock order, then a fresh decision:
--   (a) collect the candidate line ids and their visit ids with the existing
--       eligibility predicate (incl. 0184's active-patient filter). NO lock.
--   (b) lock those visits FOR UPDATE ORDER BY id. FOR UPDATE is exactly what the
--       0183 guard takes again per line, so the guard never upgrades a lock or
--       waits for a second time, and a visit-first writer (release / undo /
--       payment recalc) is either ahead of us (we wait holding NO line) or
--       behind us (it waits holding at most its visit share, on a visit we
--       already own).
--   (c) lock those lines FOR UPDATE ORDER BY id: the order release/undo
--       (FOR UPDATE ORDER BY id) and claim/unclaim (FOR NO KEY UPDATE ORDER BY
--       id, 0211) use, so recompute can no longer close a cycle with them. The
--       order is visits first, then lines - the same as release/undo: patient
--       advisory (shared) -> visit -> lines ascending.
--   (d) a NEW statement (a fresh READ COMMITTED snapshot, taken after every wait)
--       UPDATEs only `id = any(v_lines)` AND re-evaluates the full eligibility
--       predicate. A line a release posted while we waited drops out; nothing
--       is rewritten under a posted entry. Every row it touches is already
--       locked by us, so it cannot wait mid-statement.
--
-- WHY A LINE THAT BECAME ELIGIBLE AFTER (a) WAITS FOR THE NEXT RUN. This is an
-- on-demand admin scrub (Accounting > Physicians' compensation); its candidate
-- set is fixed at (a) so the lock set is known and ordered. Re-collecting after
-- locking would need the locks first. A line that turns eligible mid-run (a
-- reversed entry, a new compensation arrangement) is simply picked up the next
-- time the button is pressed. A line that stopped being eligible is handled by
-- (d). The other direction is deliberately not chased.
--
-- Eligibility is written twice (a, d) and must stay identical: the
-- 0136 rule (clinic cut 0, or rent_paying / shareholder with no explicit cut),
-- clinic_fee_php > 0, an ACTIVE patient (0184), and NO posted test_request
-- journal entry. Posted-only on purpose (0180): a reversed entry means the line
-- is unreleased again.
--
-- Same signature, return shape ({rows_affected}), SECURITY DEFINER, pinned
-- search_path and ACL (service_role only) as before; the ACL is restated below.
-- No data change. Proof: npm run plan-order-lockers:proof -- --control
-- (mutants M1-M4 of this body must each be caught).
-- =============================================================================

create or replace function public.recompute_clinic_fee_for_unreleased()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_lines    uuid[];
  v_visits   uuid[];
  v_affected int := 0;
begin
  -- (a) candidates - no lock.
  select coalesce(array_agg(e.id), '{}'::uuid[]),
         coalesce(array_agg(distinct e.visit_id), '{}'::uuid[])
    into v_lines, v_visits
    from (
      select tr.id, tr.visit_id
        from public.test_requests tr
        join public.visits v on v.id = tr.visit_id
        join public.patients pt on pt.id = v.patient_id   -- 0184: only an active patient's line
        left join public.physicians p
          on p.id = coalesce(tr.attending_physician_id, v.attending_physician_id)
        left join public.physician_compensation pc on pc.physician_id = p.id
       where coalesce(
               pc.clinic_cut_php,
               case when pc.compensation_arrangement in ('rent_paying', 'shareholder') then 0 else 100 end
             ) = 0
         and tr.clinic_fee_php > 0
         and pt.deleted_at is null and pt.merged_into_id is null   -- 0184
         and not exists (
           select 1 from public.journal_entries je
            where je.source_kind = 'test_request'
              and je.source_id = tr.id
              and je.status = 'posted'
         )
    ) e;

  if cardinality(v_lines) = 0 then
    return jsonb_build_object('rows_affected', 0);
  end if;

  -- (b) visits first, FOR UPDATE (the mode the 0183 guard re-takes), ascending.
  perform 1 from public.visits
   where id = any (v_visits)
   order by id
     for update;

  -- (c) then the lines, ascending (release/undo and claim/unclaim order).
  perform 1 from public.test_requests
   where id = any (v_lines)
   order by id
     for update;

  -- (d) fresh snapshot, locks held: re-decide, then write.
  with updated as (
    update public.test_requests tr2
       set clinic_fee_php = 0,
           doctor_pf_php  = tr2.final_price_php
     where tr2.id = any (v_lines)
       and tr2.id in (
         select tr.id
           from public.test_requests tr
           join public.visits v on v.id = tr.visit_id
           join public.patients pt on pt.id = v.patient_id   -- 0184
           left join public.physicians p
             on p.id = coalesce(tr.attending_physician_id, v.attending_physician_id)
           left join public.physician_compensation pc on pc.physician_id = p.id
          where tr.id = any (v_lines)
            and coalesce(
                  pc.clinic_cut_php,
                  case when pc.compensation_arrangement in ('rent_paying', 'shareholder') then 0 else 100 end
                ) = 0
            and tr.clinic_fee_php > 0
            and pt.deleted_at is null and pt.merged_into_id is null   -- 0184
            and not exists (
              select 1 from public.journal_entries je
               where je.source_kind = 'test_request'
                 and je.source_id = tr.id
                 and je.status = 'posted'
            )
       )
    returning tr2.id
  )
  select count(*) into v_affected from updated;

  return jsonb_build_object('rows_affected', v_affected);
end;
$$;

comment on function public.recompute_clinic_fee_for_unreleased() is
  'Admin scrub: zeroes clinic_fee_php on test_requests that have no LIVE posted revenue JE yet. '
  'Posted-only on purpose - this is a lookup, not a ledger total. A line whose revenue JE was '
  'reversed (undo-release or cancel) is unreleased again, so it may be recomputed; counting the '
  'reversed JE would wrongly freeze it. Do not widen to posted + reversed: that rule '
  '(LEDGER_TOTAL_STATUSES, src/lib/accounting/ledger-status.ts; CLAUDE.md "Ledger totals count '
  'posted + reversed") is for sums. Listed in SQL_LOOKUPS (src/lib/accounting/ledger-status-sql.test.ts). '
  '0215: locks the candidates'' visits then lines FOR UPDATE ORDER BY id before a fresh-snapshot '
  'UPDATE that re-checks eligibility (proof: scripts/plan-order-lockers-proof.ts).';

revoke all on function public.recompute_clinic_fee_for_unreleased() from public, anon, authenticated;
grant execute on function public.recompute_clinic_fee_for_unreleased() to service_role;
