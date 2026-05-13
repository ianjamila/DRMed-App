-- =============================================================================
-- 0034_hmo_ar_subledger.sql
-- =============================================================================
-- Phase 12.3 — HMO AR subledger + unbilled / stuck-claim detection.
--
-- Design spec: docs/superpowers/specs/2026-05-13-12.3-hmo-ar-subledger-design.md
-- Implementation plan: docs/superpowers/plans/2026-05-13-12.3-hmo-ar-subledger.md
--
-- Builds on 12.1 (GL foundation, 0028+0029) and 12.2 (Op→GL bridge, 0030-0033).
--
-- Adds:
--   * 6920 Bad Debt — HMO Write-offs (CoA seed).
--   * 5 missing HMO providers (Cocolife, Med Asia, Generali, Amaphil, Pacific Cross).
--   * hmo_providers.unbilled_threshold_days (default 14).
--   * 4 subledger tables: hmo_claim_batches, hmo_claim_items,
--     hmo_payment_allocations, hmo_claim_resolutions.
--   * 5 denormalization / rollup triggers (paid_amount, resolution amounts,
--     batch_voided propagation, payment-void cascade, batch status rollup).
--   * Bridge trigger: hmo_claim_resolutions → JE (mirrors 12.2's inline pattern,
--     no shared post_balanced_je helper — adapted because 12.2 never exposed one).
--   * Reversal trigger: voided resolution → reversal JE.
--   * 5 guard triggers (P0008–P0012).
--   * 4 detection views (v_hmo_unbilled, v_hmo_stuck, v_hmo_ar_aging,
--     v_hmo_provider_summary).
--   * Adds 'hmo_claim_resolution' to je_source_kind enum and extends
--     bridge_replay_summary to include it.
--
-- NOTE on JE posting helpers: the plan referenced `post_balanced_je` and
-- `reverse_je_for_source` as if they existed in 12.2, but 12.2 inlines this
-- pattern in each bridge function (see bridge_payment_insert in 0030). We
-- mirror that style here so the 12.3 bridge is consistent with 12.2.
-- =============================================================================

-- ==========================================================================
-- Section 0 — Extend je_source_kind enum to include 'hmo_claim_resolution'
-- ==========================================================================

alter type public.je_source_kind add value if not exists 'hmo_claim_resolution';

-- ==========================================================================
-- Section 1 — CoA seed: 6920 Bad Debt — HMO Write-offs
-- ==========================================================================

insert into public.chart_of_accounts (code, name, type, normal_balance, is_active, description)
values (
  '6920',
  'Bad Debt — HMO Write-offs',
  'expense',
  'debit',
  true,
  'Used when admin resolves a rejected HMO claim item to write_off. Auto-posted by 12.3 subledger trigger tg_hmo_claim_resolution_to_je.'
)
on conflict (code) do nothing;

-- ==========================================================================
-- Section 2 — Missing HMO providers (Cocolife, Med Asia, Generali, Amaphil, Pacific Cross)
-- ==========================================================================
-- hmo_providers.name already has a UNIQUE constraint (verified in preflight).

insert into public.hmo_providers (name, is_active, due_days_for_invoice)
values
  ('Cocolife',      true, 30),
  ('Med Asia',      true, 30),
  ('Generali',      true, 30),
  ('Amaphil',       true, 30),
  ('Pacific Cross', true, 30)
on conflict (name) do nothing;

-- ==========================================================================
-- Section 3 — Add hmo_providers.unbilled_threshold_days
-- ==========================================================================

alter table public.hmo_providers
  add column if not exists unbilled_threshold_days int not null default 14;

-- ==========================================================================
-- Section 4 — hmo_claim_batches
-- ==========================================================================

create table public.hmo_claim_batches (
  id              uuid primary key default gen_random_uuid(),
  provider_id     uuid not null references public.hmo_providers(id),
  status          text not null default 'draft'
    check (status in ('draft', 'submitted', 'acknowledged', 'partial_paid', 'paid', 'rejected', 'voided')),
  reference_no    text,
  submitted_at    date,
  submitted_by    uuid references public.staff_profiles(id),
  medium          text check (medium is null or medium in ('mail', 'courier', 'email', 'portal', 'fax', 'in_person')),
  hmo_ack_ref     text,
  notes           text,
  voided_at       timestamptz,
  voided_by       uuid references public.staff_profiles(id),
  void_reason     text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index idx_hmo_claim_batches_provider on public.hmo_claim_batches (provider_id);
create index idx_hmo_claim_batches_status on public.hmo_claim_batches (status)
  where voided_at is null;

create trigger tg_hmo_claim_batches_updated_at
  before update on public.hmo_claim_batches
  for each row execute function public.touch_updated_at();

alter table public.hmo_claim_batches enable row level security;

create policy "hmo_claim_batches: admin read"
  on public.hmo_claim_batches
  for select to authenticated
  using (public.has_role(array['admin']));

-- ==========================================================================
-- Section 5 — hmo_claim_items (amounts model, no status enum)
-- ==========================================================================

create table public.hmo_claim_items (
  id                            uuid primary key default gen_random_uuid(),
  batch_id                      uuid not null references public.hmo_claim_batches(id),
  test_request_id               uuid not null references public.test_requests(id),
  billed_amount_php             numeric(12,2) not null check (billed_amount_php > 0),
  paid_amount_php               numeric(12,2) not null default 0 check (paid_amount_php >= 0),
  patient_billed_amount_php     numeric(12,2) not null default 0 check (patient_billed_amount_php >= 0),
  written_off_amount_php        numeric(12,2) not null default 0 check (written_off_amount_php >= 0),
  hmo_response                  text not null default 'pending'
    check (hmo_response in ('pending', 'paid', 'rejected', 'no_response')),
  hmo_response_date             date,
  hmo_response_notes            text,
  batch_voided                  boolean not null default false,
  created_at                    timestamptz not null default now(),
  updated_at                    timestamptz not null default now(),
  constraint amounts_within_billed
    check (paid_amount_php + patient_billed_amount_php + written_off_amount_php <= billed_amount_php)
);

create index idx_hmo_claim_items_batch on public.hmo_claim_items (batch_id);
create index idx_hmo_claim_items_test_request on public.hmo_claim_items (test_request_id);
create unique index idx_hmo_claim_items_one_active_per_tr
  on public.hmo_claim_items (test_request_id) where batch_voided = false;

create trigger tg_hmo_claim_items_updated_at
  before update on public.hmo_claim_items
  for each row execute function public.touch_updated_at();

alter table public.hmo_claim_items enable row level security;

create policy "hmo_claim_items: admin read"
  on public.hmo_claim_items
  for select to authenticated
  using (public.has_role(array['admin']));

-- ==========================================================================
-- Section 6 — hmo_payment_allocations (soft-voidable; cascade from payment void)
-- ==========================================================================

create table public.hmo_payment_allocations (
  id             uuid primary key default gen_random_uuid(),
  payment_id     uuid not null references public.payments(id),
  item_id        uuid not null references public.hmo_claim_items(id),
  amount_php     numeric(12,2) not null check (amount_php > 0),
  voided_at      timestamptz,
  voided_by      uuid references public.staff_profiles(id),
  void_reason    text,
  created_at     timestamptz not null default now()
);

create index idx_hmo_payment_allocations_item on public.hmo_payment_allocations (item_id)
  where voided_at is null;
create index idx_hmo_payment_allocations_payment on public.hmo_payment_allocations (payment_id);

alter table public.hmo_payment_allocations enable row level security;

create policy "hmo_payment_allocations: admin read"
  on public.hmo_payment_allocations
  for select to authenticated
  using (public.has_role(array['admin']));

-- ==========================================================================
-- Section 7 — hmo_claim_resolutions (one row per resolution event)
-- ==========================================================================

create table public.hmo_claim_resolutions (
  id             uuid primary key default gen_random_uuid(),
  item_id        uuid not null references public.hmo_claim_items(id),
  destination    text not null check (destination in ('patient_bill', 'write_off')),
  amount_php     numeric(12,2) not null check (amount_php > 0),
  resolved_at    timestamptz not null default now(),
  resolved_by    uuid references public.staff_profiles(id),
  notes          text,
  voided_at      timestamptz,
  voided_by      uuid references public.staff_profiles(id),
  void_reason    text
);

create index idx_hmo_claim_resolutions_item on public.hmo_claim_resolutions (item_id)
  where voided_at is null;

alter table public.hmo_claim_resolutions enable row level security;

create policy "hmo_claim_resolutions: admin read"
  on public.hmo_claim_resolutions
  for select to authenticated
  using (public.has_role(array['admin']));

-- ==========================================================================
-- Section 8 — Denormalization triggers
-- ==========================================================================

-- 8.1 — Recompute hmo_claim_items.paid_amount_php from non-voided allocations.

create or replace function public.recompute_hmo_item_paid_amount(p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.hmo_claim_items
     set paid_amount_php = coalesce((
           select sum(amount_php)
             from public.hmo_payment_allocations
            where item_id = p_item_id
              and voided_at is null
         ), 0),
         updated_at = now()
   where id = p_item_id;
end;
$$;

create or replace function public.tg_hmo_item_paid_amount_recompute()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    perform public.recompute_hmo_item_paid_amount(NEW.item_id);
  elsif TG_OP = 'UPDATE'
        and (
          coalesce(OLD.voided_at, 'epoch'::timestamptz) is distinct from coalesce(NEW.voided_at, 'epoch'::timestamptz)
          or OLD.amount_php is distinct from NEW.amount_php
          or OLD.item_id is distinct from NEW.item_id
        ) then
    perform public.recompute_hmo_item_paid_amount(NEW.item_id);
    if OLD.item_id is distinct from NEW.item_id then
      perform public.recompute_hmo_item_paid_amount(OLD.item_id);
    end if;
  elsif TG_OP = 'DELETE' then
    perform public.recompute_hmo_item_paid_amount(OLD.item_id);
    return OLD;
  end if;
  return NULL;
end;
$$;

create trigger tg_hmo_alloc_paid_recompute
  after insert or update or delete on public.hmo_payment_allocations
  for each row execute function public.tg_hmo_item_paid_amount_recompute();

-- 8.2 — Recompute hmo_claim_items.patient_billed_amount_php / written_off_amount_php.

create or replace function public.recompute_hmo_item_resolution_amounts(p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.hmo_claim_items
     set patient_billed_amount_php = coalesce((
           select sum(amount_php)
             from public.hmo_claim_resolutions
            where item_id = p_item_id
              and destination = 'patient_bill'
              and voided_at is null
         ), 0),
         written_off_amount_php = coalesce((
           select sum(amount_php)
             from public.hmo_claim_resolutions
            where item_id = p_item_id
              and destination = 'write_off'
              and voided_at is null
         ), 0),
         updated_at = now()
   where id = p_item_id;
end;
$$;

create or replace function public.tg_hmo_item_resolution_amounts_recompute()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if TG_OP = 'INSERT' then
    perform public.recompute_hmo_item_resolution_amounts(NEW.item_id);
  elsif TG_OP = 'UPDATE' then
    perform public.recompute_hmo_item_resolution_amounts(NEW.item_id);
    if OLD.item_id is distinct from NEW.item_id then
      perform public.recompute_hmo_item_resolution_amounts(OLD.item_id);
    end if;
  end if;
  return NULL;
end;
$$;

create trigger tg_hmo_resolution_amounts_recompute
  after insert or update on public.hmo_claim_resolutions
  for each row execute function public.tg_hmo_item_resolution_amounts_recompute();

-- 8.3 — Propagate hmo_claim_batches.voided_at → hmo_claim_items.batch_voided.

create or replace function public.tg_hmo_batch_voided_propagate()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(OLD.voided_at, 'epoch'::timestamptz) is distinct from coalesce(NEW.voided_at, 'epoch'::timestamptz) then
    update public.hmo_claim_items
       set batch_voided = (NEW.voided_at is not null),
           updated_at = now()
     where batch_id = NEW.id;
  end if;
  return NULL;
end;
$$;

create trigger tg_hmo_batch_voided_propagate
  after update on public.hmo_claim_batches
  for each row execute function public.tg_hmo_batch_voided_propagate();

-- 8.4 — Cascade soft-void from payments to allocations.

create or replace function public.tg_payment_void_cascade_allocations()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Belt-and-suspenders: the trigger's WHEN clause already filters to the
  -- NULL → non-NULL voided_at transition; this IF mirrors that and is harmless.
  if OLD.voided_at is null and NEW.voided_at is not null then
    update public.hmo_payment_allocations
       set voided_at = NEW.voided_at,
           voided_by = NEW.voided_by,
           void_reason = 'cascade from payment void: ' || coalesce(NEW.void_reason, '(no reason)')
     where payment_id = NEW.id
       and voided_at is null;
  end if;
  return NULL;
end;
$$;

-- Mirrors 12.2's trg_bridge_payment_void (0030_op_gl_bridge.sql:629-633): use a
-- WHEN clause so the trigger only fires on the NULL → non-NULL voided_at
-- transition, keeping it off the hot path of normal payment updates.
create trigger tg_payment_void_cascade_allocations
  after update on public.payments
  for each row
  when (OLD.voided_at is null and NEW.voided_at is not null)
  execute function public.tg_payment_void_cascade_allocations();

-- ==========================================================================
-- Section 9 — Batch status rollup
-- ==========================================================================
-- After any item-amount change, recompute parent batch.status.
-- Rules:
--   - If batch is draft/voided → unchanged.
--   - If all items fully resolved AND all paid_amount = billed → 'paid'.
--   - If all items fully resolved AND all paid_amount = 0 → 'rejected'.
--   - If any item resolved partially OR mix of paid/rejected → 'partial_paid'.
--   - Else (some items still open) → keep existing 'submitted' or 'acknowledged'.

create or replace function public.recompute_hmo_batch_status(p_batch_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current        text;
  v_total_items    int;
  v_resolved_items int;
  v_total_billed   numeric;
  v_total_paid     numeric;
begin
  select status into v_current
    from public.hmo_claim_batches
   where id = p_batch_id;

  if v_current in ('draft', 'voided') then
    return;
  end if;

  select
    count(*),
    count(*) filter (
      where paid_amount_php + patient_billed_amount_php + written_off_amount_php = billed_amount_php
    ),
    coalesce(sum(billed_amount_php), 0),
    coalesce(sum(paid_amount_php), 0)
    into v_total_items, v_resolved_items, v_total_billed, v_total_paid
    from public.hmo_claim_items
   where batch_id = p_batch_id;

  if v_total_items = 0 or v_resolved_items < v_total_items then
    return;
  end if;

  if v_total_paid = v_total_billed then
    update public.hmo_claim_batches set status = 'paid', updated_at = now() where id = p_batch_id;
  elsif v_total_paid = 0 then
    update public.hmo_claim_batches set status = 'rejected', updated_at = now() where id = p_batch_id;
  else
    update public.hmo_claim_batches set status = 'partial_paid', updated_at = now() where id = p_batch_id;
  end if;
end;
$$;

create or replace function public.tg_hmo_batch_status_rollup_from_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.recompute_hmo_batch_status(NEW.batch_id);
  return NULL;
end;
$$;

create trigger tg_hmo_batch_status_rollup_from_item
  after update on public.hmo_claim_items
  for each row
  when (
    OLD.paid_amount_php is distinct from NEW.paid_amount_php
    or OLD.patient_billed_amount_php is distinct from NEW.patient_billed_amount_php
    or OLD.written_off_amount_php is distinct from NEW.written_off_amount_php
  )
  execute function public.tg_hmo_batch_status_rollup_from_item();

-- ==========================================================================
-- Section 10 — Bridge trigger: hmo_claim_resolutions → JE
-- ==========================================================================
-- New source_kind: 'hmo_claim_resolution'.
-- patient_bill → DR 1100 AR Patients / CR 1110 AR HMO
-- write_off    → DR 6920 Bad Debt    / CR 1110 AR HMO
--
-- Inlines the same draft→lines→posted pattern used by bridge_payment_insert
-- and bridge_test_request_released. The plan referenced a `post_balanced_je`
-- helper that doesn't exist in 12.2 — we adopt 12.2's actual inline style.

create or replace function public.bridge_hmo_claim_resolution_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item            public.hmo_claim_items%rowtype;
  v_batch           public.hmo_claim_batches%rowtype;
  v_dr_account      uuid;
  v_cr_account      uuid;
  v_dr_code         text;
  v_cr_code         text := '1110';
  v_desc            text;
  v_je_id           uuid;
  v_existing_je     uuid;
begin
  -- Idempotency guard (mirrors 12.2).
  select id into v_existing_je
    from public.journal_entries
   where source_kind = 'hmo_claim_resolution'
     and source_id = NEW.id
     and status = 'posted'
   for update;
  if v_existing_je is not null then
    return NEW;
  end if;

  select * into v_item  from public.hmo_claim_items   where id = NEW.item_id;
  select * into v_batch from public.hmo_claim_batches where id = v_item.batch_id;

  if NEW.destination = 'patient_bill' then
    v_dr_code := '1100';
  else
    v_dr_code := '6920';
  end if;

  -- Note on error handling for the three calls below:
  --
  -- These three CoA codes (1100 AR Patients, 6920 Bad Debt — HMO Write-offs,
  -- 1110 AR HMO) are seed-required by 0028 + 0034 and are not allowed to be
  -- deactivated. P0006 (in 0028) guards against CoA DELETE; deactivation would
  -- require an admin to manually flip is_active=false on a seeded row, which
  -- is not exposed in the UI. If any of these three were ever deactivated,
  -- coa_uuid_for_code would still return the uuid, but the subsequent
  -- journal_lines insert would trip P0005
  -- (journal_lines_block_inactive_account) and roll back the admin's
  -- transaction — a hard failure on the resolution write.
  --
  -- If a future migration ever needs to make these accounts dynamic per HMO
  -- provider (e.g. per-provider AR subaccounts), swap in a resolve_*_account
  -- helper that falls through to 9999 Suspense on lookup miss, mirroring
  -- resolve_cash_account in 0030_op_gl_bridge.sql:101-119.
  v_dr_account := public.coa_uuid_for_code(v_dr_code);
  v_cr_account := public.coa_uuid_for_code(v_cr_code);

  v_desc := format(
    'HMO claim resolved → %s — batch %s item %s',
    case NEW.destination when 'patient_bill' then 'patient bill' else 'write-off' end,
    coalesce(v_batch.reference_no, v_batch.id::text),
    NEW.item_id::text
  );

  -- Insert as draft first to defer balance-check until all lines exist.
  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, created_by
  )
  values (
    coalesce(NEW.resolved_at::date, current_date),
    v_desc,
    'draft',
    'hmo_claim_resolution',
    NEW.id,
    NEW.resolved_by
  )
  returning id into v_je_id;

  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
  values
    (v_je_id, v_dr_account, NEW.amount_php, 0, 1),
    (v_je_id, v_cr_account, 0, NEW.amount_php, 2);

  update public.journal_entries set status = 'posted' where id = v_je_id;

  return NEW;
end;
$$;

create trigger trg_bridge_hmo_claim_resolution_insert
  after insert on public.hmo_claim_resolutions
  for each row execute function public.bridge_hmo_claim_resolution_insert();

-- Reversal: when a resolution is soft-voided (voided_at flips NULL → non-NULL),
-- post a paired reversal JE and flip original to 'reversed'.

create or replace function public.bridge_hmo_claim_resolution_void()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_original_je   uuid;
  v_orig_number   text;
  v_reversal_je   uuid;
begin
  if not (OLD.voided_at is null and NEW.voided_at is not null) then
    return NEW;
  end if;

  select id, entry_number into v_original_je, v_orig_number
    from public.journal_entries
   where source_kind = 'hmo_claim_resolution'
     and source_id = NEW.id
     and status = 'posted'
   for update;
  if v_original_je is null then
    return NEW;
  end if;

  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, reverses, created_by
  )
  values (
    coalesce(NEW.voided_at::date, current_date),
    'Reversal of ' || v_orig_number || ': ' || coalesce(NEW.void_reason, 'resolution voided'),
    'draft',
    'reversal',
    null,
    v_original_je,
    NEW.voided_by
  )
  returning id into v_reversal_je;

  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
  select v_reversal_je, account_id, credit_php, debit_php, line_order
    from public.journal_lines
   where entry_id = v_original_je
   order by line_order;

  update public.journal_entries set status = 'posted' where id = v_reversal_je;

  update public.journal_entries
     set status = 'reversed',
         reversed_by = v_reversal_je
   where id = v_original_je;

  return NEW;
end;
$$;

create trigger trg_bridge_hmo_claim_resolution_void
  after update on public.hmo_claim_resolutions
  for each row
  when (OLD.voided_at is null and NEW.voided_at is not null)
  execute function public.bridge_hmo_claim_resolution_void();

-- ==========================================================================
-- Section 11 — Guard triggers P0008–P0012
-- ==========================================================================

-- P0008: can't edit billed_amount_php after any non-voided allocation or resolution exists.

create or replace function public.tg_hmo_item_p0008_guard()
returns trigger
language plpgsql
as $$
begin
  if OLD.billed_amount_php is distinct from NEW.billed_amount_php then
    if exists (
      select 1 from public.hmo_payment_allocations
       where item_id = NEW.id and voided_at is null
    ) or exists (
      select 1 from public.hmo_claim_resolutions
       where item_id = NEW.id and voided_at is null
    ) then
      raise exception
        'Cannot change billed amount: item has non-voided allocations or resolutions.'
        using errcode = 'P0008';
    end if;
  end if;
  return NEW;
end;
$$;

create trigger tg_hmo_item_p0008_guard
  before update on public.hmo_claim_items
  for each row execute function public.tg_hmo_item_p0008_guard();

-- P0009: no DELETE on hmo_claim_resolutions (must soft-void).

create or replace function public.tg_hmo_resolution_p0009_guard()
returns trigger
language plpgsql
as $$
begin
  raise exception
    'Cannot delete resolution: soft-void by setting voided_at instead.'
    using errcode = 'P0009';
end;
$$;

create trigger tg_hmo_resolution_p0009_guard
  before delete on public.hmo_claim_resolutions
  for each row execute function public.tg_hmo_resolution_p0009_guard();

-- P0010: can't void a batch with non-voided allocations or resolutions on any item.

create or replace function public.tg_hmo_batch_p0010_guard()
returns trigger
language plpgsql
as $$
begin
  if OLD.voided_at is null and NEW.voided_at is not null then
    if exists (
      select 1
        from public.hmo_claim_items i
       where i.batch_id = NEW.id
         and (
           exists (select 1 from public.hmo_payment_allocations
                    where item_id = i.id and voided_at is null)
           or exists (select 1 from public.hmo_claim_resolutions
                       where item_id = i.id and voided_at is null)
         )
    ) then
      raise exception
        'Cannot void batch: items have non-voided allocations or resolutions. Reverse those first.'
        using errcode = 'P0010';
    end if;
  end if;
  return NEW;
end;
$$;

create trigger tg_hmo_batch_p0010_guard
  before update on public.hmo_claim_batches
  for each row execute function public.tg_hmo_batch_p0010_guard();

-- P0011: resolution amount must not exceed item's unresolved balance.

create or replace function public.tg_hmo_resolution_p0011_guard()
returns trigger
language plpgsql
as $$
declare
  v_item        public.hmo_claim_items%rowtype;
  v_unresolved  numeric;
begin
  select * into v_item from public.hmo_claim_items where id = NEW.item_id;
  v_unresolved := v_item.billed_amount_php
                - v_item.paid_amount_php
                - v_item.patient_billed_amount_php
                - v_item.written_off_amount_php;
  if NEW.amount_php > v_unresolved then
    raise exception
      'Resolution amount % exceeds unresolved balance %.', NEW.amount_php, v_unresolved
      using errcode = 'P0011';
  end if;
  return NEW;
end;
$$;

create trigger tg_hmo_resolution_p0011_guard
  before insert on public.hmo_claim_resolutions
  for each row execute function public.tg_hmo_resolution_p0011_guard();

-- P0012: allocation amount must not push paid_amount_php above billed_amount_php.

create or replace function public.tg_hmo_allocation_p0012_guard()
returns trigger
language plpgsql
as $$
declare
  v_item public.hmo_claim_items%rowtype;
begin
  select * into v_item from public.hmo_claim_items where id = NEW.item_id;
  if (v_item.paid_amount_php + NEW.amount_php) > v_item.billed_amount_php then
    raise exception
      'Allocation amount % would push paid above billed %.', NEW.amount_php, v_item.billed_amount_php
      using errcode = 'P0012';
  end if;
  return NEW;
end;
$$;

create trigger tg_hmo_allocation_p0012_guard
  before insert on public.hmo_payment_allocations
  for each row execute function public.tg_hmo_allocation_p0012_guard();

-- ==========================================================================
-- Section 12 — Detection views
-- ==========================================================================

create or replace view public.v_hmo_unbilled as
select
  tr.id                                          as test_request_id,
  tr.visit_id,
  v.hmo_provider_id                              as provider_id,
  hp.name                                        as provider_name,
  tr.released_at,
  tr.hmo_approved_amount_php                     as billed_amount_php,
  (current_date - tr.released_at::date)          as days_since_release,
  ((current_date - tr.released_at::date) > hp.unbilled_threshold_days)
                                                 as past_threshold
from public.test_requests tr
join public.visits v          on v.id = tr.visit_id
join public.hmo_providers hp  on hp.id = v.hmo_provider_id
where tr.status = 'released'
  and v.hmo_provider_id is not null
  and coalesce(tr.hmo_approved_amount_php, 0) > 0
  and not exists (
    select 1 from public.hmo_claim_items i
     where i.test_request_id = tr.id
       and i.batch_voided = false
  );

create or replace view public.v_hmo_stuck as
select
  i.id                                                          as item_id,
  i.batch_id,
  b.provider_id,
  hp.name                                                       as provider_name,
  b.submitted_at,
  (current_date - b.submitted_at)                               as days_since_submission,
  (i.billed_amount_php - i.paid_amount_php
     - i.patient_billed_amount_php - i.written_off_amount_php)  as unresolved_balance_php
from public.hmo_claim_items i
join public.hmo_claim_batches b on b.id = i.batch_id
join public.hmo_providers hp    on hp.id = b.provider_id
where b.status in ('submitted', 'acknowledged', 'partial_paid')
  and b.voided_at is null
  and (i.billed_amount_php - i.paid_amount_php
       - i.patient_billed_amount_php - i.written_off_amount_php) > 0
  and b.submitted_at is not null
  and (current_date - b.submitted_at) > hp.due_days_for_invoice;

create or replace view public.v_hmo_ar_aging as
with unioned as (
  -- Batched but not fully resolved: age from test_request.released_at
  select
    b.provider_id,
    hp.name                                                       as provider_name,
    (i.billed_amount_php - i.paid_amount_php
       - i.patient_billed_amount_php - i.written_off_amount_php)  as unresolved_balance_php,
    (current_date - tr.released_at::date)                         as age_days
  from public.hmo_claim_items i
  join public.hmo_claim_batches b on b.id = i.batch_id
  join public.test_requests tr    on tr.id = i.test_request_id
  join public.hmo_providers hp    on hp.id = b.provider_id
  where b.voided_at is null
    and (i.billed_amount_php - i.paid_amount_php
         - i.patient_billed_amount_php - i.written_off_amount_php) > 0
    and tr.released_at is not null
  union all
  -- Unbatched: age from test_request.released_at
  select
    v.hmo_provider_id,
    hp.name,
    tr.hmo_approved_amount_php,
    (current_date - tr.released_at::date)
  from public.test_requests tr
  join public.visits v          on v.id = tr.visit_id
  join public.hmo_providers hp  on hp.id = v.hmo_provider_id
  where tr.status = 'released'
    and v.hmo_provider_id is not null
    and coalesce(tr.hmo_approved_amount_php, 0) > 0
    and not exists (
      select 1 from public.hmo_claim_items i2
       where i2.test_request_id = tr.id and i2.batch_voided = false
    )
)
select
  provider_id,
  provider_name,
  case
    when age_days <= 30  then '0-30'
    when age_days <= 60  then '31-60'
    when age_days <= 90  then '61-90'
    when age_days <= 180 then '91-180'
    else '180+'
  end                                       as bucket,
  sum(unresolved_balance_php)               as total_php,
  count(*)                                  as item_count
from unioned
group by provider_id, provider_name, bucket;

create or replace view public.v_hmo_provider_summary as
select
  hp.id                                       as provider_id,
  hp.name                                     as provider_name,
  hp.due_days_for_invoice,
  hp.unbilled_threshold_days,
  coalesce((
    select sum(i.billed_amount_php - i.paid_amount_php
                - i.patient_billed_amount_php - i.written_off_amount_php)
      from public.hmo_claim_items i
      join public.hmo_claim_batches b on b.id = i.batch_id
     where b.provider_id = hp.id
       and b.voided_at is null
       and (i.billed_amount_php - i.paid_amount_php
            - i.patient_billed_amount_php - i.written_off_amount_php) > 0
  ), 0) as total_unresolved_ar_php,
  coalesce((select sum(billed_amount_php) from public.v_hmo_unbilled where provider_id = hp.id), 0)
    as total_unbilled_php,
  coalesce((select sum(unresolved_balance_php) from public.v_hmo_stuck where provider_id = hp.id), 0)
    as total_stuck_php,
  (select min(tr.released_at)
     from public.hmo_claim_items i
     join public.hmo_claim_batches b on b.id = i.batch_id
     join public.test_requests tr   on tr.id = i.test_request_id
    where b.provider_id = hp.id
      and b.voided_at is null
      and (i.billed_amount_php - i.paid_amount_php
           - i.patient_billed_amount_php - i.written_off_amount_php) > 0
  ) as oldest_open_released_at,
  coalesce((
    select sum(a.amount_php)
      from public.hmo_payment_allocations a
      join public.hmo_claim_items i   on i.id = a.item_id
      join public.hmo_claim_batches b on b.id = i.batch_id
     where b.provider_id = hp.id
       and a.voided_at is null
       and a.created_at >= date_trunc('year', current_date)
  ), 0) as paid_ytd_php,
  coalesce((
    select sum(r.amount_php)
      from public.hmo_claim_resolutions r
      join public.hmo_claim_items i   on i.id = r.item_id
      join public.hmo_claim_batches b on b.id = i.batch_id
     where b.provider_id = hp.id
       and r.destination = 'patient_bill'
       and r.voided_at is null
       and r.resolved_at >= date_trunc('year', current_date)
  ), 0) as patient_billed_ytd_php,
  coalesce((
    select sum(r.amount_php)
      from public.hmo_claim_resolutions r
      join public.hmo_claim_items i   on i.id = r.item_id
      join public.hmo_claim_batches b on b.id = i.batch_id
     where b.provider_id = hp.id
       and r.destination = 'write_off'
       and r.voided_at is null
       and r.resolved_at >= date_trunc('year', current_date)
  ), 0) as written_off_ytd_php
from public.hmo_providers hp
where hp.is_active = true;

-- ==========================================================================
-- Section 13 — Extend bridge_replay_summary to include hmo_claim_resolution
-- ==========================================================================
-- 12.2's bridge_replay_summary already counts every posted JE in the window
-- via its `je_count` field — so 'hmo_claim_resolution' postings are already
-- included implicitly. We add an explicit per-source-kind breakdown so the
-- caller can see how many JEs came from each source kind. The original
-- output shape is preserved (window/je_count/suspense_postings/totals_by_account/
-- unbalanced_count) and a new `by_source_kind` key is added.

create or replace function public.bridge_replay_summary(
  p_start timestamptz,
  p_end   timestamptz
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'window', jsonb_build_object('start', p_start, 'end', p_end),
    'je_count', (
      select count(*) from public.journal_entries
      where created_at between p_start and p_end and status = 'posted'
    ),
    'by_source_kind', coalesce((
      select jsonb_object_agg(source_kind::text, n)
      from (
        select je.source_kind, count(*) as n
          from public.journal_entries je
         where je.created_at between p_start and p_end
           and je.status = 'posted'
         group by je.source_kind
      ) bsk
    ), '{}'::jsonb),
    'suspense_postings', coalesce((
      select jsonb_agg(jsonb_build_object(
        'entry_number', je.entry_number,
        'source_kind', je.source_kind,
        'source_id', je.source_id,
        'amount', jl.debit_php + jl.credit_php
      ))
      from public.journal_entries je
      join public.journal_lines jl on jl.entry_id = je.id
      join public.chart_of_accounts coa on coa.id = jl.account_id
      where je.created_at between p_start and p_end
        and coa.code = '9999'
        and je.status = 'posted'
    ), '[]'::jsonb),
    'totals_by_account', coalesce((
      select jsonb_object_agg(coa.code,
        jsonb_build_object('debit', sum_d, 'credit', sum_c))
      from (
        select jl.account_id,
          sum(jl.debit_php) as sum_d,
          sum(jl.credit_php) as sum_c
        from public.journal_lines jl
        join public.journal_entries je on je.id = jl.entry_id
        where je.created_at between p_start and p_end
          and je.status = 'posted'
        group by jl.account_id
      ) agg
      join public.chart_of_accounts coa on coa.id = agg.account_id
    ), '{}'::jsonb),
    'unbalanced_count', (
      select count(*) from (
        select je.id
        from public.journal_entries je
        join public.journal_lines jl on jl.entry_id = je.id
        where je.created_at between p_start and p_end
          and je.status = 'posted'
        group by je.id
        having sum(jl.debit_php) <> sum(jl.credit_php)
      ) unbal
    )
  );
$$;

-- =============================================================================
-- End of 0034_hmo_ar_subledger.sql
-- =============================================================================
