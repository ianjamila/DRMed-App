-- =============================================================================
-- 0183_waived_balance_gl.sql — a waived balance is booked as a discount and
-- clears 1100 AR Patients; a waived visit's money and lines are frozen.
-- =============================================================================
-- Before this, waiveVisitBalanceAction only flipped visits.payment_status to
-- 'waived'. The release bridge then debited 1100 for every line at full price
-- and credited full revenue, so the waived remainder sat in AR forever.
--
-- Design (docs/superpowers/specs/2026-09-25-waived-balance-gl-design.md):
--   1. waive_visit_balance() splits the remainder over the visit's priced live
--      lines (largest remainder, centavos, bounded by the line price) into
--      visit_waiver_allocations, one row per line, FIXED at waive time.
--      A line already released gets a standalone JE now (DR 4910/4920,
--      CR 1100, source 'visit_waiver' keyed by the allocation); a line released
--      later has its share FOLDED into its release JE (DR 1100 final − waived,
--      DR 4910/4920 waived, CR revenue unchanged). recognised_at /
--      journal_entry_id record what posted, so nothing double-posts on replay.
--   2. Undo-release and cancel reverse the allocation with the line: a folded
--      share goes with the release JE's mirror reversal; a standalone waiver
--      JE is reversed by waiver_unrecognise_line(); either way the allocation
--      is marked unrecognised so a re-release folds it again.
--   3. Money on a waived visit is refused at the DB (P0070): payment insert,
--      void, money-bearing update, hard delete, move on or off; bill lines
--      cannot be added, restored, repriced, reparented or moved. The one
--      exception is correct_payment keeping the amount (method/reference/
--      notes) — it inserts the replacement before voiding the original, under
--      app.waived_visit_edit = 'on' scoped to exactly those two writes.
--   4. payment_status may become 'waived' (insert or update) only inside
--      waive_visit_balance() (app.waive_visit = 'on') and may never leave it;
--      a waived visit's total, HMO, provenance and waiver record are frozen
--      (P0069). RLS "visits: staff full" is FOR ALL for every staff role.
--   5. Lock order: visits row FOR UPDATE, then the visit's live test_requests
--      rows FOR UPDATE in id order, payments only read. The payment guard and
--      recalc_visit_payment lock the visits row; correct_payment locks
--      payment → visit; undo/cancel/release hold their line's row lock. The
--      waiver never locks a payment. The one possible cycle (waiver vs. an
--      undo cascade component → header) is detected by Postgres (40P01).
--   6. Provenance per row: all live → allocate + post; all imported (visit,
--      every live line, every non-voided payment) → 'waived' with NO
--      allocation and no JE; mixed → P0071.
--   7. Reversals: original → 'reversed', mirrored 'posted' entry (0173).
--      Posting date Manila. A closed month raises P0002 from
--      je_period_lock_check for the waiver's own standalone entries and the
--      whole waive rolls back; a package header auto-released by the waive
--      (0109 Leg B) catches its own errors by design and stays
--      ready_for_release with an audit row.
--
-- P-codes: P0069 visits guard · P0070 money or bill lines on a waived visit ·
-- P0071 waive_visit_balance refusals (several messages, passed through).
-- =============================================================================

-- ---- Precondition: no waived visit may exist (nothing is backfilled) ---------
-- Held under a table lock so a waiver committed between the preflight count
-- and this transaction cannot slip through without an allocation.  [CR-11]
do $$
declare v_n int;
begin
  lock table public.visits in share row exclusive mode;
  select count(*) into v_n from public.visits where payment_status = 'waived';
  if v_n > 0 then
    raise exception 'STOP 0183: % waived visit(s) exist and would carry no allocation. Reconcile them before applying.', v_n;
  end if;
end $$;

alter type public.je_source_kind add value if not exists 'visit_waiver';

-- ---- visits: the waiver, fixed at waive time --------------------------------
alter table public.visits
  add column if not exists waived_php   numeric(10,2),
  add column if not exists waived_at    timestamptz,
  add column if not exists waived_by    uuid references public.staff_profiles(id),
  add column if not exists waive_reason text;

comment on column public.visits.waived_php is
  'The remainder waived (total − paid at waive time), fixed by waive_visit_balance (0183). NULL when never waived.';

-- ---- the per-line allocation ------------------------------------------------
create table if not exists public.visit_waiver_allocations (
  id               uuid primary key default gen_random_uuid(),
  visit_id         uuid not null references public.visits(id),
  test_request_id  uuid not null references public.test_requests(id),
  amount_php       numeric(10,2) not null check (amount_php > 0),
  discount_account text not null check (discount_account in ('4910', '4920')),
  -- Set when the share is in the books: by its own 'visit_waiver' JE (line
  -- already released at waive time) or folded into the line's release JE.
  recognised_at    timestamptz,
  journal_entry_id uuid references public.journal_entries(id),
  created_at       timestamptz not null default now(),
  constraint visit_waiver_allocations_line_key unique (test_request_id)
);
create index if not exists idx_visit_waiver_allocations_visit
  on public.visit_waiver_allocations (visit_id);

alter table public.visit_waiver_allocations enable row level security;
revoke all on public.visit_waiver_allocations from anon;
revoke all on public.visit_waiver_allocations from authenticated;
grant select on public.visit_waiver_allocations to authenticated;
create policy "visit_waiver_allocations: reception/admin read"
  on public.visit_waiver_allocations for select to authenticated
  using ((select public.has_role(array['reception', 'admin'])));
-- Writes: waive_visit_balance() and the bridges only (service_role / triggers).

-- ---- P0069: the visits guard --------------------------------------------------
-- INSERT is guarded too: "visits: staff full" (0151) is FOR ALL, so a staff JWT
-- could insert a row already 'waived'.  [CR-2]  Once waived, the fields the
-- waiver was computed from (total, paid, provenance, HMO) and the waiver's own
-- record are frozen.  [CR-4]  paid_php is the cached live-payment sum that
-- visitMoneySummary derives the displayed waiver from (statement.ts), so a
-- direct write would make the lists disagree with the allocation; it may only
-- move inside the RPC (which reconciles it to the real payment sum) or during
-- correct_payment's equal-amount replacement (recalc_visit_payment goes up by
-- the replacement and back down by the void, under app.waived_visit_edit).  [CR-14]
create or replace function public.guard_visit_waived_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inside boolean := coalesce(current_setting('app.waive_visit', true), '') = 'on';
  v_edit   boolean := coalesce(current_setting('app.waived_visit_edit', true), '') = 'on';
begin
  if tg_op = 'INSERT' then
    if new.payment_status = 'waived' and not v_inside then
      raise exception 'A balance can only be waived with Waive balance on the visit page.'
        using errcode = 'P0069';
    end if;
    return new;
  end if;

  if new.payment_status = 'waived' and old.payment_status is distinct from 'waived' and not v_inside then
    raise exception 'A balance can only be waived with Waive balance on the visit page.'
      using errcode = 'P0069';
  end if;
  if old.payment_status = 'waived' and new.payment_status is distinct from 'waived' then
    raise exception 'A waived balance cannot be un-waived.' using errcode = 'P0069';
  end if;
  if old.payment_status = 'waived' and not v_inside and (
       new.total_php             is distinct from old.total_php
    or new.hmo_provider_id       is distinct from old.hmo_provider_id
    or new.legacy_import_run_id  is distinct from old.legacy_import_run_id
    or new.waived_php            is distinct from old.waived_php
    or new.waived_at             is distinct from old.waived_at
    or new.waived_by             is distinct from old.waived_by
    or new.waive_reason          is distinct from old.waive_reason
  ) then
    raise exception 'This visit''s balance was waived, so its total, billing and waiver record are fixed.'
      using errcode = 'P0069';
  end if;
  -- [CR-14] paid_php: only the RPC (reconcile) or the equal-amount edit may move it.
  if old.payment_status = 'waived' and not v_inside and not v_edit
     and new.paid_php is distinct from old.paid_php then
    raise exception 'This visit''s balance was waived, so its paid amount is fixed.'
      using errcode = 'P0069';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_visits_waived_transition_guard on public.visits;
create trigger trg_visits_waived_transition_guard
  before insert or update of payment_status, total_php, paid_php, hmo_provider_id, legacy_import_run_id,
                            waived_php, waived_at, waived_by, waive_reason
  on public.visits
  for each row execute function public.guard_visit_waived_transition();

-- ---- P0070: payments on a waived visit ---------------------------------------
-- Insert, void, any money-bearing update (amount / method / visit / received_at
-- — payments_block_post_je_edits only covers rows WITH a posted JE; imported
-- rows have none) and a hard DELETE (bridge_payment_delete reverses the JE)
-- all move money. Both the old and the new visit are checked, locked in uuid
-- order.  [CR-3]  Provenance is frozen too: flipping legacy_import_run_id on a
-- payment changes what the waiver's provenance rule saw.  [CR-12]
-- Trigger order (alphabetical among BEFORE triggers): on a payment WITH a
-- posted JE, trg_payments_block_post_je_edits raises P0004 first for
-- amount/method/visit/received_at — that is still a refusal; P0070 is what
-- an imported (JE-less) payment gets. On DELETE, trg_bridge_payment_delete
-- runs first and reverses the JE, then this guard raises and the whole
-- statement rolls back — the reversal never commits.  [CR-15]
create or replace function public.guard_payment_on_waived_visit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids    uuid[];
  v_id     uuid;
  v_status text;
  v_inside boolean := coalesce(current_setting('app.waived_visit_edit', true), '') = 'on';
begin
  if tg_op = 'UPDATE' then
    if not (
         (old.voided_at is null and new.voided_at is not null)
      or new.amount_php  is distinct from old.amount_php
      or new.method      is distinct from old.method
      or new.visit_id    is distinct from old.visit_id
      or new.received_at is distinct from old.received_at
      or new.legacy_import_run_id is distinct from old.legacy_import_run_id
    ) then
      return new;
    end if;
    v_ids := array(select distinct x from unnest(array[old.visit_id, new.visit_id]) x order by x);
  elsif tg_op = 'DELETE' then
    v_ids := array[old.visit_id];
  else
    v_ids := array[new.visit_id];
  end if;

  foreach v_id in array v_ids loop
    -- Visit row lock first — the one order every money path uses (spec §5).
    select payment_status into v_status from public.visits where id = v_id for update;
    if v_status = 'waived' and not v_inside then
      raise exception 'This visit''s balance was waived, so its payments are fixed: nothing can be recorded, changed, deleted or moved on it.'
        using errcode = 'P0070';
    end if;
  end loop;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists trg_payments_waived_visit_guard on public.payments;
create trigger trg_payments_waived_visit_guard
  before insert or update or delete on public.payments
  for each row execute function public.guard_payment_on_waived_visit();

-- ---- P0070: bill lines on a waived visit --------------------------------------
-- The allocation was computed over the lines as they stood. A new line, a
-- restored line (the 0125 cascade also raises total_php), a reprice, a
-- reparent or a move to another visit would leave a line with no share that
-- still releases at full AR.  [CR-4]  Status changes (release / undo / cancel)
-- of a line the allocation saw stay allowed — the bridges handle the share —
-- but a line that was CANCELLED at waive time was excluded from the split, so
-- bringing it back (cancelled → anything else) would release at full AR with
-- no share: refused.  [CR-13]  Provenance is frozen: marking a live line
-- imported would skip its release JE (0159's legacy early return) and strand
-- the allocation; clearing an imported line's provenance would post full AR
-- with no allocation.  [CR-12]  Soft-delete is already impossible on a
-- non-unpaid visit (P0042).
create or replace function public.guard_test_request_on_waived_visit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ids    uuid[];
  v_id     uuid;
  v_status text;
  v_inside boolean := coalesce(current_setting('app.waive_visit', true), '') = 'on';
begin
  if tg_op = 'UPDATE' then
    if not (
         (old.deleted_at is not null and new.deleted_at is null)   -- restore
      or (old.status = 'cancelled' and new.status is distinct from 'cancelled')  -- reactivate [CR-13]
      or new.legacy_import_run_id is distinct from old.legacy_import_run_id       -- provenance [CR-12]
      or new.final_price_php     is distinct from old.final_price_php
      or new.base_price_php      is distinct from old.base_price_php
      or new.discount_amount_php is distinct from old.discount_amount_php
      or new.clinic_fee_php      is distinct from old.clinic_fee_php
      or new.doctor_pf_php       is distinct from old.doctor_pf_php
      or new.parent_id           is distinct from old.parent_id
      or new.service_id          is distinct from old.service_id
      or new.visit_id            is distinct from old.visit_id
      or new.is_package_header   is distinct from old.is_package_header
    ) then
      return new;
    end if;
    v_ids := array(select distinct x from unnest(array[old.visit_id, new.visit_id]) x order by x);
  else
    v_ids := array[new.visit_id];
  end if;

  foreach v_id in array v_ids loop
    select payment_status into v_status from public.visits where id = v_id for update;
    if v_status = 'waived' and not v_inside then
      raise exception 'This visit''s balance was waived, so its lines are fixed: nothing can be added, restored, reactivated, repriced or moved.'
        using errcode = 'P0070';
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_test_requests_waived_visit_guard on public.test_requests;
create trigger trg_test_requests_waived_visit_guard
  before insert or update of deleted_at, status, legacy_import_run_id, final_price_php, base_price_php,
                            discount_amount_php, clinic_fee_php, doctor_pf_php, parent_id, service_id,
                            visit_id, is_package_header
  on public.test_requests
  for each row execute function public.guard_test_request_on_waived_visit();

-- ---- Post one allocation's standalone JE (line already released) ------------
create or replace function public.waiver_post_allocation(p_allocation_id uuid, p_actor_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  a      record;
  v_je   uuid;
  v_date date := (now() at time zone 'Asia/Manila')::date;
begin
  select wa.*, s.kind
    into a
    from public.visit_waiver_allocations wa
    join public.test_requests tr on tr.id = wa.test_request_id
    join public.services s on s.id = tr.service_id
   where wa.id = p_allocation_id
   for update of wa;
  if not found then
    raise exception 'Waiver allocation not found.' using errcode = 'P0071';
  end if;
  if a.recognised_at is not null then
    return a.journal_entry_id;
  end if;

  -- Idempotency: a live JE for this allocation already exists (posted-only
  -- lookup on purpose — SQL_LOOKUPS in ledger-status-sql.test.ts).
  select id into v_je
    from public.journal_entries
   where source_kind = 'visit_waiver'
     and source_id = a.id
     and status = 'posted';
  if v_je is null then
    insert into public.journal_entries (
      posting_date, description, status, source_kind, source_id, created_by
    ) values (
      v_date,
      'Balance waived: ' || coalesce(a.kind, 'line') || ' discount',
      'draft', 'visit_waiver', a.id, p_actor_id
    ) returning id into v_je;

    insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order, description)
    values
      (v_je, public.coa_uuid_for_code(a.discount_account), a.amount_php, 0, 1, 'Balance waived'),
      (v_je, public.coa_uuid_for_code('1100'),             0, a.amount_php, 2, 'Clear patient receivable');

    update public.journal_entries set status = 'posted' where id = v_je;
  end if;

  update public.visit_waiver_allocations
     set recognised_at = now(), journal_entry_id = v_je
   where id = a.id;
  return v_je;
end;
$$;

comment on function public.waiver_post_allocation(uuid, uuid) is
  'Posts one waiver allocation''s standalone discount JE (0183). Posted-only journal read on purpose: '
  'idempotency — one live JE per allocation. A lookup, not a ledger total; totals count posted + '
  'reversed (LEDGER_TOTAL_STATUSES, ledger-status-sql.test.ts SQL_LOOKUPS).';

-- ---- Undo / cancel: take the share back out of the books --------------------
create or replace function public.waiver_unrecognise_line(p_test_request_id uuid, p_actor_id uuid, p_reason text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  a        record;
  v_orig   uuid;
  v_number text;
  v_rev    uuid;
begin
  select * into a
    from public.visit_waiver_allocations
   where test_request_id = p_test_request_id
   for update;
  if not found or a.recognised_at is null then
    return;
  end if;

  -- A standalone waiver JE is reversed here. A folded share lives inside the
  -- release JE the caller has just reversed, so there is nothing to post.
  -- Posted-only lookup on purpose (SQL_LOOKUPS): find the live entry to reverse.
  select id, entry_number into v_orig, v_number
    from public.journal_entries
   where source_kind = 'visit_waiver'
     and source_id = a.id
     and status = 'posted'
   for update;
  if v_orig is not null then
    insert into public.journal_entries (
      posting_date, description, status, source_kind, source_id, reverses, created_by
    ) values (
      (now() at time zone 'Asia/Manila')::date,
      'Reversal of ' || v_number || ': ' || p_reason,
      'draft', 'reversal', null, v_orig, p_actor_id
    ) returning id into v_rev;
    insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
    select v_rev, account_id, credit_php, debit_php, line_order
      from public.journal_lines
     where entry_id = v_orig
     order by line_order;
    update public.journal_entries set status = 'posted' where id = v_rev;
    update public.journal_entries set status = 'reversed', reversed_by = v_rev where id = v_orig;
  end if;

  update public.visit_waiver_allocations
     set recognised_at = null, journal_entry_id = null
   where id = a.id;
end;
$$;

comment on function public.waiver_unrecognise_line(uuid, uuid, text) is
  'Undo-release / cancel hook (0183): reverses a standalone waiver JE and marks the allocation '
  'unrecognised. Posted-only journal read on purpose: finds the live entry to reverse; a reversed one '
  'must not be reversed twice (LEDGER_TOTAL_STATUSES, ledger-status-sql.test.ts SQL_LOOKUPS).';

-- ---- The waive itself --------------------------------------------------------
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

  -- Lock order (spec §5): the visit row, then every live line in id order.
  -- A concurrent release / undo / cancel holds its line's row lock, so the
  -- statuses read below are final for this transaction.  [CR-5]
  select * into v_visit from public.visits where id = p_visit_id for update;
  if not found then
    raise exception 'Visit not found.' using errcode = 'P0071';
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
             (v_rem_c * round(tr.final_price_php * 100)::bigint) / v_sum_c as share_c,
             (v_rem_c * round(tr.final_price_php * 100)::bigint) % v_sum_c as frac,
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

comment on function public.waive_visit_balance(uuid, uuid, text) is
  'Admin waives a visit balance (0183): fixes the remainder, allocates it per line (largest remainder), posts the discount JE for lines already released, folds the rest into later release JEs. Refusals raise P0071. '
  'Posted-only journal read on purpose: existence of a released line''s live release JE (LEDGER_TOTAL_STATUSES, ledger-status-sql.test.ts SQL_LOOKUPS).';

-- ---- Fold the share into a later release JE ---------------------------------
-- COPY the whole body of bridge_test_request_released() from 0159 (the latest
-- definition; 0180 only added a comment) and apply exactly these edits:
--
--   (a) declare block — add:
--         v_waived           numeric(10,2) := 0;
--         v_waived_account   text;
--   (b) right after the idempotency check (`if exists (... status = 'posted') then return new; end if;`) — add:
--         -- 0183: a waived visit's share for this line, not yet in the books.
--         select amount_php, discount_account into v_waived, v_waived_account
--           from public.visit_waiver_allocations
--          where test_request_id = new.id and recognised_at is null
--          for update;
--         v_waived := coalesce(v_waived, 0);
--   (c) BOTH "DR: receivable for final_price_php" inserts — change the guard
--       and the amount from `new.final_price_php` to `new.final_price_php - v_waived`:
--         if coalesce(new.final_price_php, 0) - v_waived > 0 then
--           ... values (v_je_id, public.coa_uuid_for_code(v_cash_account), new.final_price_php - v_waived, 0, v_line_order, 'Release receivable');
--   (d) right after the "Discount line (DR contra-revenue)" block — add:
--         -- 0183: the waived share as a discount, folded into this JE.
--         if v_waived > 0 then
--           insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order, description)
--           values (v_je_id, public.coa_uuid_for_code(v_waived_account), v_waived, 0, v_line_order, 'Balance waived');
--           v_line_order := v_line_order + 1;
--           update public.visit_waiver_allocations
--              set recognised_at = now(), journal_entry_id = v_je_id
--            where test_request_id = new.id;
--         end if;
--   Keep the legacy early return, the parent_id return, P0034, the PF lines,
--   the suspense audit and the ACL restatement exactly as in 0159.
create or replace function public.bridge_test_request_released()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_visit            record;
  v_service          record;
  v_physician_id     uuid;
  v_actor            uuid;
  v_je_id            uuid;
  v_je_number        text;
  v_posting_date     date;
  v_cash_account     text;
  v_revenue_account  text;
  v_discount_account text;
  v_line_order       int := 1;
  v_waived           numeric(10,2) := 0;
  v_waived_account   text;
begin
  -- Legacy backfill rows are GL-silent (the books already hold this money).
  if NEW.legacy_import_run_id is not null then
    return NEW;
  end if;

  -- Package components are ₱0 lines; the header books the package revenue (0041).
  if NEW.parent_id is not null then
    return NEW;
  end if;

  -- Trigger fires on every UPDATE; only proceed on status→released transition.
  if not (old.status is distinct from new.status and new.status = 'released') then
    return new;
  end if;

  -- Idempotency: if a posted JE already exists for this test_request, skip.
  -- The partial unique index journal_entries_one_posted_per_source (0030) also
  -- enforces this, but an early exit is cleaner and avoids wasted work.
  if exists (
    select 1 from public.journal_entries
    where source_kind = 'test_request'
      and source_id = new.id
      and status = 'posted'
  ) then
    return new;
  end if;

  -- 0183: a waived visit's share for this line, not yet in the books.
  select amount_php, discount_account into v_waived, v_waived_account
    from public.visit_waiver_allocations
   where test_request_id = new.id and recognised_at is null
   for update;
  v_waived := coalesce(v_waived, 0);

  -- auth.uid() may be null when called from a SECURITY DEFINER Server Action
  -- via the service-role client. The journal_entries.created_by column is a
  -- nullable FK to staff_profiles(id), so null is acceptable.
  v_actor := auth.uid();

  select * into v_visit   from public.visits   where id = new.visit_id;
  select * into v_service from public.services where id = new.service_id;

  -- ---- P0034 guard ---------------------------------------------------------
  -- attending_physician_id is required at release only for doctor lines that
  -- actually accrue PF (0131). Intake admits physician-less procedures whose
  -- doctor PF is ₱0; release must not dead-end them. The doctor_pf_entries
  -- insert below only runs when coalesce(new.doctor_pf_php, 0) > 0, so a null
  -- physician is never consumed when the exemption applies.
  -- COALESCE reads the per-line override first, then the visit-level default.
  if v_service.kind in ('doctor_consultation', 'doctor_procedure') then
    v_physician_id := coalesce(new.attending_physician_id, v_visit.attending_physician_id);
    if v_physician_id is null and coalesce(new.doctor_pf_php, 0) > 0 then
      raise exception
        'attending_physician_id required for consult/procedure release on test_request %',
        new.id
        using errcode = 'P0034';
    end if;
  end if;

  -- ---- Account resolution --------------------------------------------------
  -- Revenue account: per kind. Unknown kinds fall through to Suspense + audit.
  v_revenue_account := case v_service.kind
    when 'lab_test'            then '4100'
    when 'lab_package'         then '4100'
    when 'vaccine'             then '4100'
    when 'home_service'        then '4100'
    when 'doctor_consultation' then '4200'
    when 'doctor_procedure'    then '4500'
    else null
  end;

  if v_revenue_account is null then
    -- Unknown kind: route to Suspense and write audit row for operator follow-up.
    -- Matches the Suspense audit pattern in 0033 for RA 10173 traceability.
    v_revenue_account := '9999';
    insert into public.audit_log (
      actor_id, actor_type, action, resource_type, resource_id, metadata
    ) values (
      v_actor,
      'system',
      'coa.suspense_post',
      'test_request',
      new.id,
      jsonb_build_object(
        'reason',       'no mapping for service.kind in bridge_test_request_released',
        'service_kind', v_service.kind,
        'service_id',   v_service.id
      )
    );
  end if;

  -- Discount account: 4920 for doctor kinds, 4910 for all others (lab/vaccine/etc).
  -- Spec §4.1 correctness check #6: 4920 for doctor lines, 4910 for lab lines.
  v_discount_account := case v_service.kind
    when 'doctor_consultation' then '4920'
    when 'doctor_procedure'    then '4920'
    else '4910'
  end;

  -- AR/cash-side account for the DR side of the release JE.
  -- Spec §4.1 correctness check #4: 1100 = AR Patients (NOT 1010 Cash on Hand).
  -- Cash physically moves to 1010 only at payment INSERT via bridge_payment_insert.
  -- Spec §4.1 correctness check #5: 1110 = AR HMO for HMO visits.
  if v_visit.hmo_provider_id is not null then
    v_cash_account := '1110';   -- AR HMO
  else
    v_cash_account := '1100';   -- AR Patients
  end if;

  -- 0140: Manila-local date of the release, not the UTC date `::date` reads.
  -- `now()` itself is UTC in Postgres, so the fallback needs the same
  -- conversion CLAUDE.md requires for a DB date default — never bare `current_date`.
  v_posting_date := coalesce(
    (new.released_at at time zone 'Asia/Manila')::date,
    (now() at time zone 'Asia/Manila')::date
  );

  -- ---- JE header (draft) -----------------------------------------------------
  -- Insert as 'draft' first so je_lines_balance_check (P0001) doesn't fire
  -- while lines are being inserted one by one. Flip to 'posted' after all lines
  -- are in. entry_number assigned explicitly via je_next_number (matches §6.3-6.7
  -- and 12.4 pattern — more explicit; avoids auto-trigger races on bulk operations).
  v_je_number := public.je_next_number(extract(year from v_posting_date)::int);
  insert into public.journal_entries (
    entry_number, posting_date, description, status, source_kind, source_id, created_by
  ) values (
    v_je_number,
    v_posting_date,
    'Test request released: ' || coalesce(v_service.kind, 'unknown'),
    'draft',
    'test_request',
    new.id,
    v_actor
  ) returning id into v_je_id;

  -- ---- Revenue-side lines --------------------------------------------------

  if v_service.kind in ('doctor_consultation', 'doctor_procedure') then
    -- DR: receivable for the full final_price_php (what patient/HMO owes).
    if coalesce(new.final_price_php, 0) - v_waived > 0 then
      insert into public.journal_lines (
        entry_id, account_id, debit_php, credit_php, line_order, description
      ) values (
        v_je_id, public.coa_uuid_for_code(v_cash_account), new.final_price_php - v_waived, 0, v_line_order, 'Release receivable'
      );
      v_line_order := v_line_order + 1;
    end if;

    -- CR: clinic fee + discount → revenue account (4200 or 4500).
    if coalesce(new.clinic_fee_php, 0) + coalesce(new.discount_amount_php, 0) > 0 then
      insert into public.journal_lines (
        entry_id, account_id, debit_php, credit_php, line_order, description
      ) values (
        v_je_id,
        public.coa_uuid_for_code(v_revenue_account),
        0, coalesce(new.clinic_fee_php, 0) + coalesce(new.discount_amount_php, 0),
        v_line_order,
        'Clinic fee (incl. discount absorbed by clinic)'
      );
      v_line_order := v_line_order + 1;
    end if;

    -- CR: doctor PF to 2110 (cash path) or 2160 (HMO holding path).
    if coalesce(new.doctor_pf_php, 0) > 0 then
      if v_visit.hmo_provider_id is null then
        insert into public.journal_lines (
          entry_id, account_id, debit_php, credit_php, line_order, description
        ) values (
          v_je_id,
          public.coa_uuid_for_code('2110'),
          0, new.doctor_pf_php,
          v_line_order,
          'Doctor PF accrual (cash)'
        );
        v_line_order := v_line_order + 1;

        insert into public.doctor_pf_entries (
          test_request_id, physician_id, pf_php,
          recognition_basis, recognized_at, journal_entry_id
        ) values (
          new.id, v_physician_id, new.doctor_pf_php,
          'cash_at_release', now(), v_je_id
        );

      else
        insert into public.journal_lines (
          entry_id, account_id, debit_php, credit_php, line_order, description
        ) values (
          v_je_id,
          public.coa_uuid_for_code('2160'),
          0, new.doctor_pf_php,
          v_line_order,
          'Doctor PF pending HMO settlement'
        );
        v_line_order := v_line_order + 1;

        insert into public.doctor_pf_entries (
          test_request_id, physician_id, pf_php,
          recognition_basis, recognized_at, journal_entry_id
        ) values (
          new.id, v_physician_id, new.doctor_pf_php,
          'hmo_at_settlement',
          null,
          null
        );
      end if;
    end if;

  else
    -- DR: receivable for the final_price_php (what patient owes after discount).
    if coalesce(new.final_price_php, 0) - v_waived > 0 then
      insert into public.journal_lines (
        entry_id, account_id, debit_php, credit_php, line_order, description
      ) values (
        v_je_id, public.coa_uuid_for_code(v_cash_account), new.final_price_php - v_waived, 0, v_line_order, 'Release receivable'
      );
      v_line_order := v_line_order + 1;
    end if;

    -- CR: revenue for the base_price_php (pre-discount amount).
    if coalesce(new.base_price_php, new.final_price_php, 0) > 0 then
      insert into public.journal_lines (
        entry_id, account_id, debit_php, credit_php, line_order, description
      ) values (
        v_je_id,
        public.coa_uuid_for_code(v_revenue_account),
        0, coalesce(new.base_price_php, new.final_price_php),
        v_line_order,
        'Release revenue (base price)'
      );
      v_line_order := v_line_order + 1;
    end if;

  end if;

  -- ---- Discount line (DR contra-revenue) ------------------------------------
  if coalesce(new.discount_amount_php, 0) > 0 then
    insert into public.journal_lines (
      entry_id, account_id, debit_php, credit_php, line_order, description
    ) values (
      v_je_id,
      public.coa_uuid_for_code(v_discount_account),
      new.discount_amount_php, 0,
      v_line_order,
      'Discount'
    );
    v_line_order := v_line_order + 1;
  end if;

  -- 0183: the waived share as a discount, folded into this JE.
  if v_waived > 0 then
    insert into public.journal_lines (
      entry_id, account_id, debit_php, credit_php, line_order, description
    ) values (
      v_je_id, public.coa_uuid_for_code(v_waived_account), v_waived, 0, v_line_order, 'Balance waived'
    );
    v_line_order := v_line_order + 1;
    update public.visit_waiver_allocations
       set recognised_at = now(), journal_entry_id = v_je_id
     where test_request_id = new.id;
  end if;

  -- ---- Send-out cost: deliberately NOT booked here (0159) ------------------
  -- Partner labs are paid on the spot and the payment is recorded as a
  -- "Send Out" expense (Quick expense / petty cash). Booking that account again
  -- at release would count the same cost twice, so release posts revenue only.

  -- ---- Flip to posted -------------------------------------------------------
  update public.journal_entries
    set status = 'posted'
    where id = v_je_id;

  return new;
end;
$function$;

revoke execute on function public.bridge_test_request_released() from public, anon, authenticated;
grant  execute on function public.bridge_test_request_released() to service_role;

-- ---- Undo-release: reverse the share with the line ---------------------------
-- COPY fn_undo_release_bridge() from 0166 (line 140 — the cogs-free body) and
-- add ONE line immediately after the `end if;` that closes
-- `if v_original_je is not null then`, before the doctor_pf_entries void:  [CR-1]
--         -- 0183: a standalone waiver JE for this line is reversed too; a folded share went with the JE above.
--         perform public.waiver_unrecognise_line(new.id, v_actor, 'release undone');
create or replace function public.fn_undo_release_bridge()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor        uuid;
  v_original_je  uuid;
  v_orig_number  text;
  v_reversal_je  uuid;
  v_header       record;
begin
  v_actor := auth.uid();

  -- ---- 1. Accounting reversal (pattern: 0064 bridge_test_request_cancelled) --
  select id, entry_number into v_original_je, v_orig_number
    from public.journal_entries
    where source_kind = 'test_request' and source_id = new.id and status = 'posted'
    for update;

  if v_original_je is not null then
    insert into public.journal_entries (
      posting_date, description, status, source_kind, source_id, reverses, created_by
    ) values (
      -- 0140: Manila-local date of the undo, not the UTC date `current_date` reads.
      (now() at time zone 'Asia/Manila')::date,
      'Reversal of ' || v_orig_number || ': release undone',
      'draft', 'reversal', null, v_original_je, v_actor
    ) returning id into v_reversal_je;

    insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
    select v_reversal_je, account_id, credit_php, debit_php, line_order
      from public.journal_lines where entry_id = v_original_je order by line_order;

    update public.journal_entries set status = 'posted' where id = v_reversal_je;
    update public.journal_entries
       set status = 'reversed', reversed_by = v_reversal_je
     where id = v_original_je;
  end if;

  -- 0183: a standalone waiver JE for this line is reversed too; a folded share went with the JE above.
  perform public.waiver_unrecognise_line(new.id, v_actor, 'release undone');

  -- (The send-out subledger void that followed was removed by 0166.)
  update public.doctor_pf_entries
     set voided_at = now(), voided_by = v_actor, void_reason = 'release_undone'
   where test_request_id = new.id and voided_at is null;

  -- ---- 2. Package cascade ---------------------------------------------------
  if new.parent_id is not null then
    select id, status into v_header
      from public.test_requests where id = new.parent_id for update;

    -- Clear the completion stamp; fn_set_package_completed_at's IS NULL guard
    -- re-stamps correctly on re-completion.
    update public.test_requests
       set package_completed_at = null
     where id = new.parent_id and package_completed_at is not null;

    if v_header.status = 'released' then
      -- Re-fires this trigger for the header's own JE reversal.
      update public.test_requests
         set status = 'ready_for_release',
             released_at = null, released_by = null, release_medium = null
       where id = new.parent_id;

      -- Traceability: the human reason lives on the component's audit row
      -- (written by the server action); this system row marks the cascade.
      insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
      values (
        v_actor, 'system', 'test_request.release_undone', 'test_request', new.parent_id,
        jsonb_build_object('cascaded_from', new.id, 'visit_id', new.visit_id)
      );
    end if;
  end if;

  return new;
end;
$$;

revoke execute on function public.fn_undo_release_bridge() from public, anon, authenticated;
grant  execute on function public.fn_undo_release_bridge() to service_role;

-- ---- Cancel: same hook --------------------------------------------------------
-- COPY bridge_test_request_cancelled() from 0166 (line 29) and add ONE line
-- immediately after `v_actor := auth.uid();`:  [CR-1]
--         perform public.waiver_unrecognise_line(new.id, v_actor, 'test request cancelled');
create or replace function public.bridge_test_request_cancelled()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_actor        uuid;
  v_original_je  uuid;
  v_orig_number  text;
  v_reversal_je  uuid;
begin
  -- Package components have no JE to reverse (see released-bridge guard).
  if NEW.parent_id is not null then
    return NEW;
  end if;

  -- Only proceed on released→cancelled transition. The trigger definition in
  -- 0030 already constrains: WHEN (OLD.status = 'released' AND NEW.status = 'cancelled')
  -- but the guard below makes the function self-consistent if called directly.
  if not (old.status = 'released' and new.status = 'cancelled') then
    return new;
  end if;

  v_actor := auth.uid();
  perform public.waiver_unrecognise_line(new.id, v_actor, 'test request cancelled');

  -- Find the original posted release JE for this test_request.
  -- FOR UPDATE locks the row to prevent a concurrent void from racing.
  select id, entry_number into v_original_je, v_orig_number
    from public.journal_entries
    where source_kind = 'test_request'
      and source_id = new.id
      and status = 'posted'
    for update;

  if v_original_je is null then
    -- Test request was released but has no posted JE (defensive edge case).
    -- Still soft-void subledger rows in case they were inserted before the JE.
    update public.doctor_pf_entries
      set voided_at   = now(),
          voided_by   = v_actor,
          void_reason = 'test_request_cancelled'
      where test_request_id = new.id
        and voided_at is null;

    return new;
  end if;

  -- ---- Insert reversal JE header (draft) ------------------------------------
  -- source_kind = 'reversal', source_id = null, reverses = original JE id.
  -- This mirrors the pattern in bridge_payment_void (0030). The partial unique
  -- index journal_entries_one_posted_per_source excludes source_kind='reversal'
  -- rows, so no collision with the idempotency guard on release.
  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, reverses, created_by
  ) values (
    -- 0141: Manila-local date of the cancellation, not the UTC date `current_date` reads.
    (now() at time zone 'Asia/Manila')::date,
    'Reversal of ' || v_orig_number || ': test request cancelled',
    'draft',
    'reversal',
    null,
    v_original_je,
    v_actor
  ) returning id into v_reversal_je;

  -- ---- Mirror lines with swapped debit/credit --------------------------------
  -- Works correctly for the new split-JE shape from 6.1: each line is
  -- reversed 1:1 regardless of which account it touches.
  insert into public.journal_lines (
    entry_id, account_id, debit_php, credit_php, line_order
  )
  select
    v_reversal_je,
    account_id,
    credit_php,   -- swap: original credit becomes reversal debit
    debit_php,    -- swap: original debit becomes reversal credit
    line_order
  from public.journal_lines
  where entry_id = v_original_je
  order by line_order;

  -- ---- Flip reversal to posted; mark original as reversed -------------------
  update public.journal_entries
    set status = 'posted'
    where id = v_reversal_je;

  update public.journal_entries
    set status      = 'reversed',
        reversed_by = v_reversal_je
    where id = v_original_je;

  -- ---- 12.5 addition: soft-void subledger rows ------------------------------
  -- Void any open doctor_pf_entries for this test_request. This handles both
  -- 'cash_at_release' (PF now reversed by the JE above) and 'hmo_at_settlement'
  -- (PF was deferred; cancellation withdraws the pending claim entirely).
  -- (The send-out subledger void that followed was removed by 0166.)
  update public.doctor_pf_entries
    set voided_at   = now(),
        voided_by   = v_actor,
        void_reason = 'test_request_cancelled'
    where test_request_id = new.id
      and voided_at is null;

  return new;
end;
$function$;

revoke execute on function public.bridge_test_request_cancelled() from public, anon, authenticated;
grant  execute on function public.bridge_test_request_cancelled() to service_role;

-- ---- correct_payment: the equal-amount exception ------------------------------
-- COPY correct_payment from 0174 (lines 48–187, same signature). Add to the
-- declare block:
--         v_src_status text;
--         v_tgt_status text;
--         r_v          record;
-- Add this block immediately BEFORE the comment
-- `-- Reference / notes only: not a money change, edit in place.`:
--         -- 0183: a waived visit's money is fixed. Lock order payment → visits
--         -- in uuid order (source and target both), the same order as
--         -- guard_payment_on_waived_visit, so two opposite-direction moves
--         -- cannot cycle.
--         for r_v in
--           select id, payment_status from public.visits
--            where id in (v_old.visit_id, coalesce(v_target, v_old.visit_id))
--            order by id for update
--         loop
--           if r_v.id = v_old.visit_id then v_src_status := r_v.payment_status; end if;
--           if v_moving and r_v.id = v_target then v_tgt_status := r_v.payment_status; end if;
--         end loop;
--         if v_moving and v_tgt_status = 'waived' then
--           raise exception 'That visit''s balance was waived, so no payment can be moved onto it.' using errcode = 'P0070';
--         end if;
--         if v_src_status = 'waived' then
--           if v_moving then
--             raise exception 'This visit''s balance was waived, so its payments cannot be moved.' using errcode = 'P0070';
--           end if;
--           if p_amount_php <> v_old.amount_php then
--             raise exception 'This visit''s balance was waived, so the amount is fixed. Change only the method, reference or notes.'
--               using errcode = 'P0070';
--           end if;
--         end if;
-- Then wrap ONLY the proven replacement — the flag is set right before the
-- insert and cleared right after the void; the in-place (reference/notes)
-- branch returns before it is ever set:  [CR-3]
--         if v_src_status = 'waived' then
--           perform set_config('app.waived_visit_edit', 'on', true);
--         end if;
--         insert into public.payments ( ... ) values ( ... ) returning id into v_new_id;
--         update public.payments set voided_at = now(), voided_by = p_actor_id, void_reason = ... where id = p_payment_id;
--         perform set_config('app.waived_visit_edit', 'off', true);
--         return v_new_id;
create or replace function public.correct_payment(
  p_payment_id       uuid,
  p_amount_php       numeric,
  p_method           text,
  p_reference_number text,
  p_notes            text,
  p_reason           text,
  p_actor_id         uuid,
  p_visit_id         uuid default null,
  p_expected         jsonb default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_old    public.payments%rowtype;
  v_new_id uuid;
  v_target uuid;
  v_moving boolean;
  v_ref    text := nullif(btrim(coalesce(p_reference_number, '')), '');
  v_notes  text := nullif(btrim(coalesce(p_notes, '')), '');
  v_src_status text;
  v_tgt_status text;
  r_v          record;
begin
  if p_actor_id is null then
    raise exception 'Edit payment needs the staff member making the change.'
      using errcode = 'P0054';
  end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required to edit a payment.'
      using errcode = 'P0054';
  end if;

  select * into v_old
    from public.payments
   where id = p_payment_id
   for update;

  if not found then
    raise exception 'Payment not found.' using errcode = 'P0054';
  end if;
  if v_old.voided_at is not null then
    raise exception 'This payment was already deleted or edited. Refresh the visit and try again.'
      using errcode = 'P0054';
  end if;

  -- What the caller saw must still be what is there. Text fields compare the
  -- way they are stored (trimmed, '' = NULL); a key the caller left out is
  -- not checked.
  if p_expected is not null and (
       (p_expected ? 'amount_php'
          and v_old.amount_php is distinct from (p_expected->>'amount_php')::numeric)
    or (p_expected ? 'method'
          and v_old.method is distinct from (p_expected->>'method'))
    or (p_expected ? 'visit_id'
          and v_old.visit_id is distinct from (p_expected->>'visit_id')::uuid)
    or (p_expected ? 'reference_number'
          and v_old.reference_number is distinct from
              nullif(btrim(coalesce(p_expected->>'reference_number', '')), ''))
    or (p_expected ? 'notes'
          and v_old.notes is distinct from
              nullif(btrim(coalesce(p_expected->>'notes', '')), ''))
  ) then
    raise exception 'Someone else changed this payment since you opened it. Refresh the visit and try again.'
      using errcode = 'P0054';
  end if;

  if v_old.method in ('gift_code', 'hmo')
     or exists (select 1 from public.gift_codes where redeemed_payment_id = v_old.id) then
    raise exception 'Gift code and HMO payments cannot be edited. Delete it and record it again.'
      using errcode = 'P0054';
  end if;
  if v_old.legacy_import_run_id is not null then
    raise exception 'Payments from the imported history cannot be edited. Delete it and record it again.'
      using errcode = 'P0054';
  end if;
  -- The method is only checked when it CHANGES: a Move (or a reference fix)
  -- re-sends the payment's own method, and a legacy bpi / maybank receipt
  -- must stay what it was rather than be refused for a method the counter no
  -- longer offers. A new method must be one the counter records today.
  if p_method is null
     or (p_method is distinct from v_old.method
         and p_method not in ('cash', 'gcash', 'maya', 'card', 'bank_transfer')) then
    raise exception 'Choose Cash, GCash, Maya, Card or Bank transfer.'
      using errcode = 'P0054';
  end if;
  if p_amount_php is null or p_amount_php <= 0 then
    raise exception 'Amount must be greater than zero.' using errcode = 'P0054';
  end if;
  if round(p_amount_php, 2) <> p_amount_php then
    raise exception 'Amount can have at most two decimal places.' using errcode = 'P0054';
  end if;
  if p_amount_php > 99999999.99 then
    raise exception 'Amount is too large.' using errcode = 'P0054';
  end if;

  v_target := coalesce(p_visit_id, v_old.visit_id);
  v_moving := v_target <> v_old.visit_id;
  if v_moving then
    if not exists (select 1 from public.visits where id = v_target) then
      raise exception 'Visit not found.' using errcode = 'P0054';
    end if;
    if exists (select 1 from public.visits where id = v_target and deleted_at is not null) then
      raise exception 'That visit was deleted from the queue. Restore it before moving a payment onto it.'
        using errcode = 'P0054';
    end if;
  end if;

  -- 0183: a waived visit's money is fixed. Lock order payment → visits
  -- in uuid order (source and target both), the same order as
  -- guard_payment_on_waived_visit, so two opposite-direction moves
  -- cannot cycle.
  for r_v in
    select id, payment_status from public.visits
     where id in (v_old.visit_id, coalesce(v_target, v_old.visit_id))
     order by id for update
  loop
    if r_v.id = v_old.visit_id then v_src_status := r_v.payment_status; end if;
    if v_moving and r_v.id = v_target then v_tgt_status := r_v.payment_status; end if;
  end loop;
  if v_moving and v_tgt_status = 'waived' then
    raise exception 'That visit''s balance was waived, so no payment can be moved onto it.' using errcode = 'P0070';
  end if;
  if v_src_status = 'waived' then
    if v_moving then
      raise exception 'This visit''s balance was waived, so its payments cannot be moved.' using errcode = 'P0070';
    end if;
    if p_amount_php <> v_old.amount_php then
      raise exception 'This visit''s balance was waived, so the amount is fixed. Change only the method, reference or notes.'
        using errcode = 'P0070';
    end if;
  end if;

  -- Reference / notes only: not a money change, edit in place.
  if not v_moving and p_amount_php = v_old.amount_php and p_method = v_old.method then
    if v_ref is not distinct from v_old.reference_number
       and v_notes is not distinct from v_old.notes then
      raise exception 'Nothing changed.' using errcode = 'P0054';
    end if;
    update public.payments
       set reference_number = v_ref,
           notes            = v_notes
     where id = p_payment_id;
    return p_payment_id;
  end if;

  -- Money change or move: re-create, then void. See 0161's header for the order.
  if v_src_status = 'waived' then
    perform set_config('app.waived_visit_edit', 'on', true);
  end if;
  insert into public.payments (
    visit_id, amount_php, method, reference_number, notes,
    received_by, received_at, corrects_payment_id
  ) values (
    v_target, p_amount_php, p_method, v_ref, v_notes,
    v_old.received_by, v_old.received_at, v_old.id
  )
  returning id into v_new_id;

  update public.payments
     set voided_at   = now(),
         voided_by   = p_actor_id,
         void_reason = case when v_moving then 'Moved: ' else 'Edited: ' end || btrim(p_reason)
   where id = p_payment_id;
  perform set_config('app.waived_visit_edit', 'off', true);

  return v_new_id;
end;
$$;

comment on function public.correct_payment(uuid, numeric, text, text, text, text, uuid, uuid, jsonb) is
  'Edit / Move a payment (0161, stale guard 0174, waived-visit rule 0183): re-create then void in one transaction; reference/notes-only edits in place. On a waived visit only an equal-amount replacement is allowed (P0070). p_expected = the payment as the caller saw it; any difference is refused (P0054).';

-- ---- ACLs (0119: new functions are service_role-only; restated by name —
-- hosted Supabase also grants anon/authenticated by default)
revoke execute on function public.guard_visit_waived_transition()             from public, anon, authenticated;
revoke execute on function public.guard_payment_on_waived_visit()             from public, anon, authenticated;
revoke execute on function public.guard_test_request_on_waived_visit()        from public, anon, authenticated;
revoke execute on function public.waiver_post_allocation(uuid, uuid)          from public, anon, authenticated;
revoke execute on function public.waiver_unrecognise_line(uuid, uuid, text)   from public, anon, authenticated;
revoke execute on function public.waive_visit_balance(uuid, uuid, text)       from public, anon, authenticated;
grant  execute on function public.guard_visit_waived_transition()             to service_role;
grant  execute on function public.guard_payment_on_waived_visit()             to service_role;
grant  execute on function public.guard_test_request_on_waived_visit()        to service_role;
grant  execute on function public.waiver_post_allocation(uuid, uuid)          to service_role;
grant  execute on function public.waiver_unrecognise_line(uuid, uuid, text)   to service_role;
grant  execute on function public.waive_visit_balance(uuid, uuid, text)       to service_role;
revoke execute on function public.correct_payment(uuid, numeric, text, text, text, text, uuid, uuid, jsonb)
  from public, anon, authenticated;
grant  execute on function public.correct_payment(uuid, numeric, text, text, text, text, uuid, uuid, jsonb)
  to service_role;
