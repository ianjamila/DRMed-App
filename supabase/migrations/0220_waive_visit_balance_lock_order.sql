-- =============================================================================
-- 0220_waive_visit_balance_lock_order.sql
-- =============================================================================
-- waive_visit_balance (0183) takes the patient lifecycle lock FIRST.
--
-- THE BUG (found by the static lock-order guard,
-- src/lib/db/lifecycle-lock-order.test.ts; reproduced by
-- scripts/waiver-concurrency-proof.ts, scenarios W1/W2, mutant MW0183):
--   0183 locked the visit FOR UPDATE, then every live line in id order, and
--   reached the patient's lifecycle lock (0184) only at its final
--   `update public.visits`, through the a_lifecycle_guard trigger - row lock,
--   then advisory lock. merge_patients_guarded / undo_patient_merge_guarded
--   (0196) go the other way: the EXCLUSIVE patient lock, then `update visits`.
--   A waive that held the visit while a merge of its patient started was a
--   40P01: the waive waits for the patient lock the merge holds, the merge for
--   the visit row the waive holds. The app retried the waive once
--   (withLifecycleRetry), but Postgres may pick the MERGE as the victim, and a
--   merge refused by a deadlock is an admin's failed merge.
--   The same lesson as 0215 (recompute) and 0216 (delete / restore).
--
-- THE FIX: the global order - lifecycle_lock_and_assert(the visit's patient,
-- shared) -> visit FOR UPDATE (re-read: a visit moved to another patient
-- meanwhile is P0072, which waiveVisitBalanceAction retries once) -> lines
-- ORDER BY id -> the writes. A merge that wins the race leaves the patient
-- merged, so the lock assert refuses the waive with P0058 (proof W2) - the
-- admin waives on the kept record; the 0183 order made the MERGE the 40P01
-- victim instead (proof W1 against mutant MW0183). Everything after the prologue is 0183's body verbatim.
-- Same signature, SECURITY DEFINER, search_path and ACL (restated below).
-- No P-code: P0072 (0184) and P0058 (0184) already exist and are translated.
-- =============================================================================

create or replace function public.waive_visit_balance(p_visit_id uuid, p_actor_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visit        public.visits%rowtype;
  v_role         text;
  v_total_c      bigint;
  v_paid_c       bigint;
  v_rem_c        bigint;
  v_sum_c        bigint;
  v_left         bigint;
  v_lines_live   int;
  v_lines_legacy int;
  v_pay_live     int;
  v_pay_legacy   int;
  v_all_legacy   boolean;
  v_all_live     boolean;
  v_n            int := 0;
  v_posted       int := 0;
  r              record;
  v_patient      uuid;  -- 0220
begin
  if p_actor_id is null then
    raise exception 'Waiving needs the admin making the change.' using errcode = 'P0071';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'Reason is required.' using errcode = 'P0071';
  end if;
  select role into v_role from public.staff_profiles where id = p_actor_id and is_active;
  if v_role is distinct from 'admin' then
    raise exception 'Only an admin can waive a balance.' using errcode = 'P0071';
  end if;

  -- 0220: the patient lifecycle lock (shared, 0184) BEFORE any row lock - the
  -- global order release / undo / recompute (0215) / delete (0216) use, and the
  -- one merge / undo-merge (0196) need: they take it EXCLUSIVE and then UPDATE
  -- visits, so a waive holding the visit that only asked for it at its own
  -- visits UPDATE (a_lifecycle_guard) closed a cycle with a merge (40P01).
  -- P0058 when the patient is deleted or merged (what the guard raised before).
  select v.patient_id into v_patient from public.visits v where v.id = p_visit_id;
  if not found then
    raise exception 'Visit not found.' using errcode = 'P0071';
  end if;
  perform public.lifecycle_lock_and_assert(array[v_patient], false);

  -- Lock order (spec §5): the visit row, then every live line in id order.
  -- A concurrent release / undo / cancel holds its line's row lock, so the
  -- statuses read below are final for this transaction.  [CR-5]
  select * into v_visit from public.visits where id = p_visit_id for update;
  if not found then
    raise exception 'Visit not found.' using errcode = 'P0071';
  end if;
  -- 0220: re-read under the patient lock - a merge that moved the visit
  -- meanwhile means we hold the wrong patient's lock (P0072: the caller retries once).
  if v_visit.patient_id is distinct from v_patient then
    raise exception 'the patient on this visit changed while it was being saved — try again'
      using errcode = 'P0072';
  end if;
  perform 1 from public.test_requests where visit_id = p_visit_id and deleted_at is null order by id for update;

  if v_visit.deleted_at is not null then
    raise exception 'This visit was deleted from the queue. Restore it before waiving.' using errcode = 'P0071';
  end if;
  if v_visit.hmo_provider_id is not null then
    raise exception 'This visit is billed to an HMO and already releases without payment — there is no balance to waive.'
      using errcode = 'P0071';
  end if;
  if v_visit.payment_status = 'waived' then
    raise exception 'This visit''s balance is already waived.' using errcode = 'P0071';
  end if;
  if v_visit.payment_status = 'paid' then
    raise exception 'This visit is already fully paid — nothing to waive.' using errcode = 'P0071';
  end if;

  -- A gift-code redemption in flight: the payment row exists but the voucher
  -- has not been marked redeemed yet; if that update fails the app voids the
  -- payment, which a waive in between would refuse (P0070).  [CR-7]
  if exists (
    select 1 from public.payments p
     where p.visit_id = p_visit_id and p.voided_at is null and p.method = 'gift_code'
       and not exists (select 1 from public.gift_codes g where g.redeemed_payment_id = p.id)
  ) then
    raise exception 'A gift code is being redeemed on this visit right now. Try again in a moment.'
      using errcode = 'P0071';
  end if;

  -- Provenance, per row (spec §6).
  select coalesce(sum(round(amount_php * 100)), 0)::bigint,
         count(*) filter (where legacy_import_run_id is null),
         count(*) filter (where legacy_import_run_id is not null)
    into v_paid_c, v_pay_live, v_pay_legacy
    from public.payments
   where visit_id = p_visit_id and voided_at is null;
  select count(*) filter (where legacy_import_run_id is null),
         count(*) filter (where legacy_import_run_id is not null)
    into v_lines_live, v_lines_legacy
    from public.test_requests
   where visit_id = p_visit_id and deleted_at is null and status <> 'cancelled';
  v_all_legacy := v_visit.legacy_import_run_id is not null and v_lines_live = 0 and v_pay_live = 0;
  v_all_live   := v_visit.legacy_import_run_id is null and v_lines_legacy = 0 and v_pay_legacy = 0;
  if not v_all_legacy and not v_all_live then
    raise exception 'This visit mixes imported and live rows; reconcile it before waiving.' using errcode = 'P0071';
  end if;

  v_total_c := round(v_visit.total_php * 100)::bigint;
  v_rem_c   := v_total_c - v_paid_c;
  if v_rem_c <= 0 then
    raise exception 'Nothing left to waive on this visit.' using errcode = 'P0071';
  end if;

  if v_all_live then
    -- Priced live lines: headers and standalone lines; ₱0 package components
    -- (parent_id set) never carry money.
    select coalesce(sum(round(final_price_php * 100)), 0)::bigint into v_sum_c
      from public.test_requests
     where visit_id = p_visit_id and deleted_at is null and status <> 'cancelled'
       and parent_id is null and coalesce(final_price_php, 0) > 0;
    if v_sum_c = 0 then
      raise exception 'No priced lines to allocate the waiver over.' using errcode = 'P0071';
    end if;
    -- The release bridge books LINE prices, so the waiver only clears AR if
    -- the visit total is exactly the priced lines. Either direction is refused.  [CR-6]
    if v_total_c <> v_sum_c then
      raise exception 'This visit''s total (₱%) does not match its lines (₱%); fix the lines before waiving.',
        to_char(v_total_c / 100.0, 'FM999,999,990.00'), to_char(v_sum_c / 100.0, 'FM999,999,990.00')
        using errcode = 'P0071';
    end if;
    -- A released live line must have its release JE in the books, or the
    -- standalone credit to 1100 would clear AR that was never booked.  [CR-6]
    if exists (
      select 1 from public.test_requests tr
       where tr.visit_id = p_visit_id and tr.deleted_at is null and tr.parent_id is null
         and tr.status = 'released' and coalesce(tr.final_price_php, 0) > 0
         and not exists (select 1 from public.journal_entries je
                          where je.source_kind = 'test_request' and je.source_id = tr.id and je.status = 'posted')
    ) then
      raise exception 'A released line on this visit has no journal entry; reconcile the books before waiving.'
        using errcode = 'P0071';
    end if;

    -- Largest remainder in centavos.
    drop table if exists tmp_waiver_alloc;
    create temp table tmp_waiver_alloc on commit drop as
      select tr.id as test_request_id,
             -- numeric intermediates: centavos × centavos overflows bigint past
             -- ₱9.2M × ₱9.2M, well inside numeric(10,2)'s range. div(), not
             -- floor(a / b): numeric division rounds to 16 significant digits
             -- BEFORE a floor could run, so a quotient like 150000000.9999999967
             -- would round up and hand a centavo out twice; div() truncates exactly.
             div(v_rem_c::numeric * round(tr.final_price_php * 100), v_sum_c)::bigint        as share_c,
             mod(v_rem_c::numeric * round(tr.final_price_php * 100), v_sum_c)::bigint        as frac,
             case when s.kind in ('doctor_consultation', 'doctor_procedure') then '4920' else '4910' end as acct,
             tr.status
        from public.test_requests tr
        join public.services s on s.id = tr.service_id
       where tr.visit_id = p_visit_id and tr.deleted_at is null and tr.status <> 'cancelled'
         and tr.parent_id is null and coalesce(tr.final_price_php, 0) > 0;

    select v_rem_c - coalesce(sum(share_c), 0) into v_left from tmp_waiver_alloc;
    update tmp_waiver_alloc t
       set share_c = t.share_c + 1
      from (select test_request_id from tmp_waiver_alloc order by frac desc, test_request_id limit v_left) x
     where x.test_request_id = t.test_request_id;

    insert into public.visit_waiver_allocations (visit_id, test_request_id, amount_php, discount_account)
    select p_visit_id, test_request_id, share_c / 100.0, acct
      from tmp_waiver_alloc
     where share_c > 0;
    get diagnostics v_n = row_count;

    -- Lines already released: their AR is booked, clear it now. This is
    -- OUTSIDE any exception handler: a closed month (P0002) rolls the whole
    -- waive back.  [CR-8]
    for r in
      select wa.id
        from public.visit_waiver_allocations wa
        join tmp_waiver_alloc t on t.test_request_id = wa.test_request_id
       where t.status = 'released'
    loop
      perform public.waiver_post_allocation(r.id, p_actor_id);
      v_posted := v_posted + 1;
    end loop;
  end if;

  perform set_config('app.waive_visit', 'on', true);
  update public.visits
     set payment_status = 'waived',
         paid_php       = v_paid_c / 100.0,   -- [CR-14] reconcile the cached sum to the real payments
         waived_php     = v_rem_c / 100.0,
         waived_at      = now(),
         waived_by      = p_actor_id,
         waive_reason   = btrim(p_reason)
   where id = p_visit_id;
  -- Package headers whose components are all done auto-release inside that
  -- UPDATE (0109 Leg B, tg_release_headers_on_visit_paid) and fold their
  -- share. That path catches every error by design — including P0002 in a
  -- closed month — and leaves the header ready_for_release with a
  -- test_request.header_auto_release_failed audit row; the share folds when
  -- the header is released by hand later.  [CR-8]
  perform set_config('app.waive_visit', 'off', true);

  return jsonb_build_object(
    'waived_php',      v_rem_c / 100.0,
    'allocations',     v_n,
    'posted_now',      v_posted,
    'legacy',          v_all_legacy,
    'previous_status', v_visit.payment_status,
    'headers_pending', (select count(*) from public.test_requests
                         where visit_id = p_visit_id and is_package_header
                           and status = 'ready_for_release' and deleted_at is null)
  );
end;
$$;

revoke execute on function public.waive_visit_balance(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.waive_visit_balance(uuid, uuid, text) to service_role;
