-- =============================================================================
-- 0064_pf_cogs_schema.sql
-- =============================================================================
-- 12.5 sub-project — COGS + Doctor PF subledger.
-- Authoritative spec: docs/superpowers/specs/2026-05-26-12.5-cogs-doctor-pf-design.md
--
-- Companion: this migration ships AFTER the four enum migrations 0060-0063.
-- See spec §8 for the deploy order.
--
-- Adds:
--   * 2 new CoA accounts (2150 Accrued Send-Out, 2160 Doctor PF Pending HMO)
--   * 5 new columns on existing tables (physicians, visits, test_requests, services x2)
--   * 4 new subledger tables (doctor_pf_entries, doctor_pf_disbursements,
--     cogs_send_out_entries, cogs_send_out_trueups) + 1 counter table
--   * RLS policies (admin-only reads; SECURITY DEFINER triggers for writes)
--   * 6 new bridge triggers + 1 modified (bridge_test_request_released) [Sections 6-7 added by T10-T17]
--   * P0034 typed error for missing attending_physician_id at release [trigger code in §6]
-- =============================================================================


-- =============================================================================
-- Section 1 — Chart of Accounts additions.
-- =============================================================================

insert into public.chart_of_accounts (code, name, type, normal_balance, description, is_active)
values
  ('2150', 'Accrued Send-Out',
   'liability', 'credit',
   'COGS accrued for released send-outs awaiting Hi Precision bill (12.5).',
   true),
  ('2160', 'Doctor PF Pending HMO Settlement',
   'liability', 'credit',
   'PF accrued at HMO consult release; reclassed to 2110 at HMO payment (12.5).',
   true)
on conflict (code) do nothing;


-- =============================================================================
-- Section 2 — New columns on existing tables.
-- =============================================================================

-- physicians.compensation_arrangement drives the visit form's clinic_fee_php
-- default for each doctor. Default is 'pf_split' (today's behavior — clinic
-- keeps a clinic_fee, doctor gets PF). Rent-paying and shareholder doctors
-- keep 100% of the consult amount (clinic_fee=0 by default).
alter table public.physicians
  add column compensation_arrangement text not null default 'pf_split'
    check (compensation_arrangement in ('pf_split', 'rent_paying', 'shareholder'));

-- Visit-level attending physician. Most visits have one doctor; per-line
-- override via test_requests.attending_physician_id below for rare cases.
alter table public.visits
  add column attending_physician_id uuid references public.physicians(id);

create index idx_visits_attending_physician
  on public.visits(attending_physician_id)
  where attending_physician_id is not null;

-- Per-line override for multi-doctor visits (rare). Trigger logic reads
-- COALESCE(test_requests.attending_physician_id, visits.attending_physician_id).
alter table public.test_requests
  add column attending_physician_id uuid references public.physicians(id);

create index idx_test_requests_attending_physician
  on public.test_requests(attending_physician_id)
  where attending_physician_id is not null;

-- services: send-out unit cost (snapshot at release) + vendor FK to 12.4 vendors.
alter table public.services
  add column send_out_unit_cost_php numeric(10,2)
    check (send_out_unit_cost_php is null or send_out_unit_cost_php >= 0),
  add column send_out_vendor_id uuid references public.vendors(id);


-- =============================================================================
-- Section 3 — Subledger tables.
-- =============================================================================

-- doctor_pf_entries: one row per consult/procedure test_request with PF > 0.
-- Cash entries fire at release; HMO entries deferred until hmo_payment_allocations
-- inserts the settlement payment. Clawback rows are NEGATIVE pf_php (Risk #2).
create table public.doctor_pf_entries (
  id                    uuid primary key default gen_random_uuid(),
  test_request_id       uuid not null references public.test_requests(id),
  physician_id          uuid not null references public.physicians(id),
  pf_php                numeric(10,2) not null check (pf_php != 0),
  recognition_basis     text not null check (recognition_basis in
    ('cash_at_release', 'hmo_at_settlement', 'clawback')),
  recognized_at         timestamptz,
  journal_entry_id      uuid references public.journal_entries(id),
  hmo_allocation_id     uuid references public.hmo_payment_allocations(id),
  disbursement_id       uuid,
  -- disbursement_id FK added below after doctor_pf_disbursements is created.
  voided_at             timestamptz,
  voided_by             uuid references public.staff_profiles(id),
  void_reason           text,
  created_at            timestamptz not null default now()
);

-- One non-clawback entry per test_request at a time.
create unique index uq_doctor_pf_entries_one_per_test_request
  on public.doctor_pf_entries(test_request_id)
  where voided_at is null and recognition_basis != 'clawback';

-- Hot path: EOD payouts grouped by physician.
create index idx_doctor_pf_entries_physician_open
  on public.doctor_pf_entries(physician_id, recognized_at)
  where disbursement_id is null and voided_at is null;

-- Hot path: Pending HMO tab + visit-detail badge.
create index idx_doctor_pf_entries_pending_hmo
  on public.doctor_pf_entries(test_request_id)
  where recognition_basis = 'hmo_at_settlement' and recognized_at is null;

-- doctor_pf_disbursements: header for EOD batch payouts. One row per doctor
-- per batch. JE fires from the after-insert trigger.
create table public.doctor_pf_disbursements (
  id                  uuid primary key default gen_random_uuid(),
  batch_number        bigint unique not null,
  physician_id        uuid not null references public.physicians(id),
  posted_date         date not null,
  method              text not null check (method in
    ('cash', 'gcash', 'bank_transfer')),
  total_php           numeric(10,2) not null check (total_php != 0),
  recorded_by         uuid not null references public.staff_profiles(id),
  recorded_at         timestamptz not null default now(),
  journal_entry_id    uuid references public.journal_entries(id),
  notes               text,
  voided_at           timestamptz,
  voided_by           uuid references public.staff_profiles(id),
  void_reason         text
);

create index idx_doctor_pf_disbursements_physician_date
  on public.doctor_pf_disbursements(physician_id, posted_date desc);
create index idx_doctor_pf_disbursements_posted_date
  on public.doctor_pf_disbursements(posted_date desc)
  where voided_at is null;

-- Close the forward-declared FK from doctor_pf_entries → doctor_pf_disbursements
-- (column was declared as bare uuid above because the disbursements table
-- didn't exist at that point).
alter table public.doctor_pf_entries
  add constraint doctor_pf_entries_disbursement_id_fkey
    foreign key (disbursement_id) references public.doctor_pf_disbursements(id);

-- Counter table for batch numbering. SECURITY DEFINER triggers are the only
-- writers; RLS prevents direct access from anon/authenticated roles.
create table public.pf_disbursement_year_counters (
  year   smallint primary key,
  next_n bigint not null default 1
);

-- cogs_send_out_entries: one row per released send-out test_request. unit_cost_php
-- is snapshotted at release time (immutable); admin edits to services.send_out_unit_cost_php
-- after the fact do NOT propagate. The trueup_id link sets when matched against
-- a Hi Precision bill (Section 4 trigger).
create table public.cogs_send_out_entries (
  id                  uuid primary key default gen_random_uuid(),
  test_request_id     uuid not null references public.test_requests(id),
  service_id          uuid not null references public.services(id),
  vendor_id           uuid references public.vendors(id),
  unit_cost_php       numeric(10,2) not null check (unit_cost_php >= 0),
  accrued_at          timestamptz not null default now(),
  journal_entry_id    uuid references public.journal_entries(id),
  trueup_id           uuid,
  -- trueup_id FK added below after cogs_send_out_trueups is created.
  trued_up_at         timestamptz,
  voided_at           timestamptz,
  voided_by           uuid references public.staff_profiles(id),
  void_reason         text
);

-- One non-voided entry per test_request.
create unique index uq_cogs_send_out_entries_one_per_test_request
  on public.cogs_send_out_entries(test_request_id)
  where voided_at is null;

-- Hot path: "Accrued (unbilled)" tab.
create index idx_cogs_send_out_entries_vendor_open
  on public.cogs_send_out_entries(vendor_id, accrued_at)
  where trueup_id is null and voided_at is null;

-- Hot path: "unit cost missing" badge / banner.
create index idx_cogs_send_out_entries_missing_cost
  on public.cogs_send_out_entries(service_id)
  where unit_cost_php = 0 and voided_at is null;

-- cogs_send_out_trueups: one row per Hi Precision bill→period match event.
-- variance_php is signed: positive = under-accrued (book more COGS), negative
-- = over-accrued (reverse some). bill_id is nullable for the future "manual
-- writeoff" path (no bill exists).
create table public.cogs_send_out_trueups (
  id                  uuid primary key default gen_random_uuid(),
  vendor_id           uuid not null references public.vendors(id),
  bill_id             uuid references public.bills(id),
  period_start_date   date not null,
  period_end_date     date not null,
  accrued_total_php   numeric(12,2) not null check (accrued_total_php >= 0),
  billed_total_php    numeric(12,2) not null check (billed_total_php >= 0),
  variance_php        numeric(12,2) not null,
  journal_entry_id    uuid references public.journal_entries(id),
  matched_at          timestamptz not null default now(),
  matched_by          uuid not null references public.staff_profiles(id),
  voided_at           timestamptz,
  voided_by           uuid references public.staff_profiles(id),
  void_reason         text,
  check (period_end_date >= period_start_date)
);

create index idx_cogs_send_out_trueups_vendor
  on public.cogs_send_out_trueups(vendor_id, matched_at desc);

-- Close the forward-declared FK from entries → trueups.
alter table public.cogs_send_out_entries
  add constraint cogs_send_out_entries_trueup_id_fkey
    foreign key (trueup_id) references public.cogs_send_out_trueups(id);


-- =============================================================================
-- Section 4 — RLS.
-- =============================================================================

alter table public.doctor_pf_entries enable row level security;
create policy "doctor_pf_entries: admin read"
  on public.doctor_pf_entries for select to authenticated
  using (public.has_role(array['admin']));

alter table public.doctor_pf_disbursements enable row level security;
create policy "doctor_pf_disbursements: admin read"
  on public.doctor_pf_disbursements for select to authenticated
  using (public.has_role(array['admin']));

alter table public.cogs_send_out_entries enable row level security;
create policy "cogs_send_out_entries: admin read"
  on public.cogs_send_out_entries for select to authenticated
  using (public.has_role(array['admin']));

alter table public.cogs_send_out_trueups enable row level security;
create policy "cogs_send_out_trueups: admin read"
  on public.cogs_send_out_trueups for select to authenticated
  using (public.has_role(array['admin']));

-- Counter table: RLS enabled, NO policies. Only SECURITY DEFINER triggers touch
-- it. This matches the bill_payment_year_counters pattern from 12.4.
alter table public.pf_disbursement_year_counters enable row level security;

-- Reception/medtech does not read the subledger tables directly. Visit-detail
-- page PF status badge is computed server-side under requireAdminStaff() when
-- shown; reception sees the rendered output, not raw rows.


-- =============================================================================
-- Section 5 — Helpers.
-- =============================================================================

-- Increment-and-return for PF disbursement batch numbers. Called by
-- trg_bridge_pf_disbursement_post (Section 6) before drafting the JE.
-- Returns the assigned batch_number; updates the counter row atomically.
create or replace function public.next_pf_disbursement_batch_number(p_year smallint)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_n bigint;
begin
  insert into public.pf_disbursement_year_counters(year, next_n)
    values (p_year, 1)
    on conflict (year) do update set next_n = pf_disbursement_year_counters.next_n + 1
    returning next_n into v_n;
  -- The ON CONFLICT branch returns the incremented next_n; the INSERT branch
  -- returns 1. Both are correct: first row of year = 1, second = 2, etc.
  -- Actually wait — INSERT branch returns the inserted 1, then NEXT call hits
  -- conflict and returns 2. That's right.
  return v_n;
end;
$$;

revoke all on function public.next_pf_disbursement_batch_number(smallint) from public;


-- =============================================================================
-- Section 6 — Bridge triggers. Section 6.1 rewrites the existing function from
-- 0030; 6.2 extends the existing cancellation function. 6.3-6.7 (other new
-- triggers) follow in T12-T16.
-- =============================================================================

-- =============================================================================
-- Section 6.1 — bridge_test_request_released (rewrite)
-- =============================================================================
-- Rewrites the function last defined in 0033_op_gl_bridge_polish.sql. Key
-- changes from 0030/0033:
--   * Raises P0034 if attending_physician_id is unresolvable for consult/procedure.
--   * Splits the consult/procedure revenue JE: (clinic_fee_php + discount) → 4200/4500,
--     doctor_pf_php → 2110 (cash visits) or 2160 (HMO holding, per D11).
--   * Inserts doctor_pf_entries row with recognition_basis='cash_at_release' or
--     'hmo_at_settlement' depending on visit type.
--   * For is_send_out services: appends DR 6420 / CR 2150 lines if unit_cost > 0;
--     inserts cogs_send_out_entries in both cases (D10 governs zero-cost path).
--   * Non-consult/procedure kinds: simplified to DR AR / CR revenue for
--     base_price_php (= final + discount; single AR line). This is the correct
--     contra-revenue pattern: DR cash = final, DR discount = discount, CR revenue = base.
--   * JE balance model for discounted consults (policy decision, 12.5.1c):
--     discount is absorbed by the clinic share, not the doctor PF.
--     DR cash   = final_price_php
--     DR 4920   = discount_amount_php  (contra-revenue)
--     CR 4200   = clinic_fee_php + discount_amount_php  (base clinic portion)
--     CR 2110   = doctor_pf_php  (full PF, discount does not reduce PF)
--     Sum CR    = (clinic_fee + discount) + doctor_pf = final + discount = base ✓
--   * All line INSERTs guarded by `if v_amount > 0` to satisfy the
--     journal_lines CHECK `debit_php > 0 or credit_php > 0` and to produce
--     clean JEs for shareholder doctors (clinic_fee=0).
--   * Calls je_next_number explicitly (matches §6.3-6.7 + 12.4 pattern).
-- =============================================================================

create or replace function public.bridge_test_request_released()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
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
begin
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

  -- auth.uid() may be null when called from a SECURITY DEFINER Server Action
  -- via the service-role client. The journal_entries.created_by column is a
  -- nullable FK to staff_profiles(id), so null is acceptable.
  v_actor := auth.uid();

  select * into v_visit   from public.visits   where id = new.visit_id;
  select * into v_service from public.services where id = new.service_id;

  -- ---- P0034 guard ---------------------------------------------------------
  -- attending_physician_id is required for consult/procedure at release.
  -- COALESCE reads the per-line override first, then the visit-level default.
  if v_service.kind in ('doctor_consultation', 'doctor_procedure') then
    v_physician_id := coalesce(new.attending_physician_id, v_visit.attending_physician_id);
    if v_physician_id is null then
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

  v_posting_date := coalesce(new.released_at::date, current_date);

  -- ---- JE header (draft) ---------------------------------------------------
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
    -- Split JE for consult/procedure:
    --   DR cash_account                          final_price_php    (receivable)
    --   CR revenue account (4200/4500)           clinic_fee_php + discount_amount_php
    --   CR 2110 or 2160                          doctor_pf_php       (cash: AP-Doctors / HMO: holding)
    --   DR discount account (4920)               discount_amount_php (if > 0; contra-revenue)
    --
    -- Balance check (12.5.1c policy: discount absorbed by clinic share, not PF):
    --   DR = final_price_php + discount_amount_php
    --   CR = (clinic_fee_php + discount_amount_php) + doctor_pf_php
    --      = clinic_fee_php + doctor_pf_php + discount_amount_php
    --      = final_price_php + discount_amount_php  ✓  (because clinic_fee + pf = final)
    --
    -- Zero-amount lines are skipped (shareholder doctors have clinic_fee=0;
    -- edge cases may have doctor_pf=0).

    -- DR: receivable for the full final_price_php (what patient/HMO owes).
    if coalesce(new.final_price_php, 0) > 0 then
      insert into public.journal_lines (
        entry_id, account_id, debit_php, credit_php, line_order, description
      ) values (
        v_je_id,
        public.coa_uuid_for_code(v_cash_account),
        new.final_price_php, 0,
        v_line_order,
        'Release receivable'
      );
      v_line_order := v_line_order + 1;
    end if;

    -- CR: clinic fee + discount → revenue account (4200 or 4500).
    -- Clinic absorbs the full discount (doctor PF is always at full amount).
    -- Skipped for shareholder doctors where clinic_fee_php = 0 AND discount = 0.
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
    -- Also insert the doctor_pf_entries subledger row.
    if coalesce(new.doctor_pf_php, 0) > 0 then
      if v_visit.hmo_provider_id is null then
        -- Cash visit: accrue directly to 2110 AP — Doctors (recognized immediately).
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
        -- HMO visit: park PF in 2160 Doctor PF Pending HMO Settlement.
        -- Recognition + 2160→2110 reclassification fires later via
        -- trg_bridge_pf_at_hmo_allocation (Section 6.3, T12).
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
          null,  -- recognized_at fires at hmo_payment_allocations INSERT
          null   -- journal_entry_id populated at that time too
        );
      end if;
    end if;

  else
    -- All other kinds (lab_test, lab_package, vaccine, home_service, etc.):
    -- Standard contra-revenue pattern:
    --   DR cash_account       final_price_php    (receivable = what patient/HMO owes)
    --   CR revenue_account    base_price_php     (= final + discount; pre-discount revenue)
    --   DR discount_account   discount_amount_php (if > 0; contra-revenue 4910)
    -- Balance: DR = final + discount = base = CR ✓
    -- Uses base_price_php (not final_price_php) to correctly credit revenue at the
    -- pre-discount amount, matching the 0030 pattern.

    -- DR: receivable for the final_price_php (what patient owes after discount).
    if coalesce(new.final_price_php, 0) > 0 then
      insert into public.journal_lines (
        entry_id, account_id, debit_php, credit_php, line_order, description
      ) values (
        v_je_id,
        public.coa_uuid_for_code(v_cash_account),
        new.final_price_php, 0,
        v_line_order,
        'Release receivable'
      );
      v_line_order := v_line_order + 1;
    end if;

    -- CR: revenue for the base_price_php (pre-discount amount).
    -- base_price_php = final_price_php + discount_amount_php.
    -- When no discount, base = final. Falls back to final_price_php if base is null
    -- (should not happen for well-formed data, but defensive).
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
  -- Standard contra-revenue debit. Guards against zero-amount line.
  -- For consults: discount absorbed by clinic share (CR revenue already includes
  -- discount in the clinic_fee + discount line above). For non-consults: revenue
  -- was credited at base_price_php so this DR restores the net to final.
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

  -- ---- Send-out COGS accrual -----------------------------------------------
  -- Appended to the same JE for ALL service kinds where is_send_out=true.
  -- D10: if unit_cost is NULL or 0, do NOT emit COGS JE lines. Still insert
  -- a cogs_send_out_entries row (unit_cost_php=0, journal_entry_id=null) for
  -- admin visibility and the missing-cost banner/badge count.
  if v_service.is_send_out then
    if v_service.send_out_unit_cost_php is not null
       and v_service.send_out_unit_cost_php > 0 then

      -- DR 6420 Send Out / CR 2150 Accrued Send-Out
      insert into public.journal_lines (
        entry_id, account_id, debit_php, credit_php, line_order, description
      ) values (
        v_je_id,
        public.coa_uuid_for_code('6420'),
        v_service.send_out_unit_cost_php, 0,
        v_line_order,
        'Send-out COGS'
      );
      v_line_order := v_line_order + 1;

      insert into public.journal_lines (
        entry_id, account_id, debit_php, credit_php, line_order, description
      ) values (
        v_je_id,
        public.coa_uuid_for_code('2150'),
        0, v_service.send_out_unit_cost_php,
        v_line_order,
        'Accrued send-out'
      );
      v_line_order := v_line_order + 1;

      insert into public.cogs_send_out_entries (
        test_request_id, service_id, vendor_id, unit_cost_php, journal_entry_id
      ) values (
        new.id, v_service.id, v_service.send_out_vendor_id,
        v_service.send_out_unit_cost_php, v_je_id
      );

    else
      -- D10 fallback: unit_cost is NULL or 0. Record subledger row for visibility;
      -- emit no JE lines (avoids blocking the release at the counter). Admin
      -- resolves via /staff/admin/accounting/cogs/send-outs/unconfigured.
      insert into public.cogs_send_out_entries (
        test_request_id, service_id, vendor_id, unit_cost_php, journal_entry_id
      ) values (
        new.id, v_service.id, null, 0, null
      );

      -- Audit for RA 10173 traceability + admin banner count.
      -- actor_id=null is intentional: auth.uid() may be null in SECURITY DEFINER
      -- context called by the service-role client; audit_log.actor_id is nullable.
      insert into public.audit_log (
        actor_id, actor_type, action, resource_type, resource_id, metadata
      ) values (
        null,
        'system',
        'send_out.unit_cost_missing',
        'test_request',
        new.id,
        jsonb_build_object(
          'service_id',   v_service.id,
          'service_code', v_service.code
        )
      );
    end if;
  end if;

  -- ---- Flip to posted -------------------------------------------------------
  -- je_status_balance_check fires on this UPDATE and validates that
  -- sum(debit_php) = sum(credit_php) across all lines. If the JE is unbalanced
  -- (e.g., clinic_fee + doctor_pf_php != final_price_php due to bad data), it
  -- will raise P0001 here and the trigger will roll back cleanly.
  update public.journal_entries
    set status = 'posted'
    where id = v_je_id;

  return new;
end;
$$;

revoke all on function public.bridge_test_request_released() from public;


-- =============================================================================
-- Section 6.2 — bridge_test_request_cancelled (extension)
-- =============================================================================
-- Rewrites the function from 0030. Preserves the original reversal-JE pattern
-- exactly (mirror each line with debit/credit swapped, source_kind='reversal').
-- Adds the 12.5 extension: soft-void any doctor_pf_entries and
-- cogs_send_out_entries rows tied to the cancelled test_request.
--
-- The reversal-JE shape is correct for the new split JE from 6.1: each line
-- (clinic_fee CR, doctor_pf CR, AR DR, discount DR, COGS DR/CR) is reversed
-- 1:1 by the mirror INSERT. No extra logic is needed here.
--
-- voided_by is set to auth.uid() which may be null when the trigger fires from
-- a SECURITY DEFINER Server Action under the service-role client. The
-- doctor_pf_entries.voided_by and cogs_send_out_entries.voided_by columns are
-- nullable FKs to staff_profiles(id), so null is acceptable.
-- =============================================================================

create or replace function public.bridge_test_request_cancelled()
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
begin
  -- Only proceed on released→cancelled transition. The trigger definition in
  -- 0030 already constrains: WHEN (OLD.status = 'released' AND NEW.status = 'cancelled')
  -- but the guard below makes the function self-consistent if called directly.
  if not (old.status = 'released' and new.status = 'cancelled') then
    return new;
  end if;

  v_actor := auth.uid();

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

    update public.cogs_send_out_entries
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
    current_date,
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
  update public.doctor_pf_entries
    set voided_at   = now(),
        voided_by   = v_actor,
        void_reason = 'test_request_cancelled'
    where test_request_id = new.id
      and voided_at is null;

  -- Void any open cogs_send_out_entries for this test_request.
  update public.cogs_send_out_entries
    set voided_at   = now(),
        voided_by   = v_actor,
        void_reason = 'test_request_cancelled'
    where test_request_id = new.id
      and voided_at is null;

  return new;
end;
$$;

revoke all on function public.bridge_test_request_cancelled() from public;


-- Section 6.3 — Fire PF settlement JE when HMO actually pays. Trigger fires
-- on hmo_payment_allocations INSERT (NOT hmo_claim_resolutions — see spec §4.3).
create or replace function public.bridge_pf_at_hmo_allocation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor          uuid := auth.uid();
  v_item           record;
  v_tr             record;
  v_pfe            record;
  v_payment        record;
  v_settlement_ratio numeric(10,6);
  v_pf_to_accrue   numeric(10,2);
  v_je_id          uuid;
  v_je_number      text;
  v_year           smallint;
  v_posting_date   date;
begin
  -- Look up the item and its test_request.
  select * into v_item from public.hmo_claim_items where id = new.item_id;
  if v_item.test_request_id is null then return new; end if;

  select * into v_tr from public.test_requests where id = v_item.test_request_id;

  -- Find a pending HMO PF entry for this test_request.
  select * into v_pfe from public.doctor_pf_entries
  where test_request_id = v_tr.id
    and recognition_basis = 'hmo_at_settlement'
    and recognized_at is null
    and voided_at is null
  limit 1;

  if v_pfe.id is null then return new; end if;  -- no pending PF; nothing to do

  -- Compute proportional accrual. In practice the ratio is 1.0 or 0.0 (per
  -- spec D7); the formula handles partials gracefully.
  if v_item.billed_amount_php = 0 then return new; end if;
  v_settlement_ratio := new.amount_php / v_item.billed_amount_php;
  v_pf_to_accrue := round(coalesce(v_tr.doctor_pf_php, 0) * v_settlement_ratio, 2);

  if v_pf_to_accrue <= 0 then return new; end if;

  -- Derive posting_date from parent payment.
  -- payments.received_at is the recording timestamp; cast to date for the JE.
  -- (payments has no posting_date column; received_at::date is the equivalent.)
  select * into v_payment from public.payments where id = new.payment_id;
  v_posting_date := coalesce(v_payment.received_at::date, current_date);
  v_year := extract(year from v_posting_date)::smallint;

  -- Draft + post JE: DR 2160 / CR 2110.
  v_je_number := public.je_next_number(v_year::int);
  insert into public.journal_entries(
    entry_number, posting_date, status, source_kind, source_id,
    description, created_by
  ) values (
    v_je_number, v_posting_date, 'draft', 'doctor_pf_accrual', v_pfe.id,
    'HMO PF settlement: 2160 → 2110', v_actor
  ) returning id into v_je_id;

  insert into public.journal_lines(entry_id, line_order, account_id, debit_php, credit_php, description)
  values (v_je_id, 1, public.coa_uuid_for_code('2160'),
          v_pf_to_accrue, 0, 'Reclass from PF pending');
  insert into public.journal_lines(entry_id, line_order, account_id, debit_php, credit_php, description)
  values (v_je_id, 2, public.coa_uuid_for_code('2110'),
          0, v_pf_to_accrue, 'Doctor PF accrued at HMO settlement');

  update public.journal_entries set status = 'posted' where id = v_je_id;

  -- Update the PF entry with settlement details + snapshot the actual accrued amount.
  update public.doctor_pf_entries
    set recognized_at    = now(),
        journal_entry_id = v_je_id,
        hmo_allocation_id = new.id,
        pf_php           = v_pf_to_accrue
    where id = v_pfe.id;

  return new;
end;
$$;

revoke all on function public.bridge_pf_at_hmo_allocation() from public;


-- Section 6.4 — When HMO denies (hmo_claim_resolutions destination='write_off'),
-- clear the PF pending entry to bad debt. See spec §4.4.
create or replace function public.bridge_pf_at_hmo_writeoff()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor          uuid := auth.uid();
  v_item           record;
  v_tr             record;
  v_pfe            record;
  v_writeoff_ratio numeric(10,6);
  v_pf_to_clear    numeric(10,2);
  v_je_id          uuid;
  v_je_number      text;
  v_year           smallint;
  v_posting_date   date;
begin
  -- Only fire for write_off resolutions (also enforced by WHEN clause on trigger).
  if new.destination != 'write_off' then return new; end if;

  select * into v_item from public.hmo_claim_items where id = new.item_id;
  if v_item.test_request_id is null then return new; end if;

  select * into v_tr from public.test_requests where id = v_item.test_request_id;

  select * into v_pfe from public.doctor_pf_entries
  where test_request_id = v_tr.id
    and recognition_basis = 'hmo_at_settlement'
    and recognized_at is null
    and voided_at is null
  limit 1;

  if v_pfe.id is null then return new; end if;

  if v_item.billed_amount_php = 0 then return new; end if;
  v_writeoff_ratio := new.amount_php / v_item.billed_amount_php;
  v_pf_to_clear := round(coalesce(v_tr.doctor_pf_php, 0) * v_writeoff_ratio, 2);

  if v_pf_to_clear <= 0 then return new; end if;

  v_posting_date := coalesce(new.resolved_at::date, current_date);
  v_year := extract(year from v_posting_date)::smallint;

  -- DR 2160 / CR 6920 — clear the holding into bad debt.
  v_je_number := public.je_next_number(v_year::int);
  insert into public.journal_entries(
    entry_number, posting_date, status, source_kind, source_id,
    description, created_by
  ) values (
    v_je_number, v_posting_date, 'draft', 'doctor_pf_accrual', v_pfe.id,
    'HMO PF writeoff: 2160 → 6920', v_actor
  ) returning id into v_je_id;

  insert into public.journal_lines(entry_id, line_order, account_id, debit_php, credit_php, description)
  values (v_je_id, 1, public.coa_uuid_for_code('2160'),
          v_pf_to_clear, 0, 'Clear PF pending (writeoff)');
  insert into public.journal_lines(entry_id, line_order, account_id, debit_php, credit_php, description)
  values (v_je_id, 2, public.coa_uuid_for_code('6920'),
          0, v_pf_to_clear, 'Bad debt (HMO denied)');

  update public.journal_entries set status = 'posted' where id = v_je_id;

  -- Soft-void the PF entry (records the actual cleared amount).
  update public.doctor_pf_entries
    set voided_at        = now(),
        voided_by        = v_actor,
        void_reason      = 'hmo_writeoff',
        pf_php           = v_pf_to_clear,
        journal_entry_id = v_je_id
    where id = v_pfe.id;

  return new;
end;
$$;

revoke all on function public.bridge_pf_at_hmo_writeoff() from public;


-- Section 6.5 — When a cash payment is voided AND the visit becomes un-paid,
-- reverse PF accruals on cash entries OR insert clawback rows if PF was
-- already disbursed (Risk #2 (b)). See spec §4.5.
create or replace function public.bridge_payment_void_pf_cascade()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor       uuid := auth.uid();
  v_visit       record;
  v_tr          record;
  v_pfe         record;
  v_je_id       uuid;
  v_je_number   text;
  v_year        smallint;
begin
  -- Only act on payments going from active to voided
  -- (also enforced by WHEN clause on trigger).
  if not (old.voided_at is null and new.voided_at is not null) then
    return new;
  end if;

  -- If visit is still paid via other payments, do nothing.
  select * into v_visit from public.visits where id = new.visit_id;
  if v_visit.payment_status = 'paid' then return new; end if;

  -- Walk all test_requests on this visit; for each PF entry that can be reversed,
  -- either reverse-JE-and-soft-void OR insert a clawback row.
  --
  -- Two PF entry types are handled:
  -- (a) cash_at_release: PF was recognized at release to 2110 (cash) or 2160 (HMO
  --     pending, settled later → now in 2110). For already-disbursed entries, insert
  --     clawback. For undisbursed entries, reverse with JE.
  -- (b) hmo_at_settlement with recognized_at IS NULL: PF is still in 2160 (not yet
  --     settled). When the payment that backs the visit is voided, withdraw the pending
  --     entry and reverse the 2160/1110 lines from the original release JE.
  for v_tr in (select * from public.test_requests where visit_id = new.visit_id) loop

    -- (a) Cash-recognized entries (cash_at_release).
    for v_pfe in (
      select * from public.doctor_pf_entries
      where test_request_id = v_tr.id
        and recognition_basis = 'cash_at_release'
        and voided_at is null
    ) loop
      if v_pfe.disbursement_id is not null then
        -- PF already paid out. Insert clawback row + audit; surface in UI.
        insert into public.doctor_pf_entries(
          test_request_id, physician_id, pf_php, recognition_basis,
          recognized_at, journal_entry_id
        ) values (
          v_pfe.test_request_id, v_pfe.physician_id, -v_pfe.pf_php,
          'clawback', now(), null
        );
        insert into public.audit_log(actor_id, actor_type, action, resource_type, resource_id, metadata)
        values (v_actor, 'system', 'pf_clawback.alert',
                'doctor_pf_entries', v_pfe.id,
                jsonb_build_object('visit_id', new.visit_id,
                                   'physician_id', v_pfe.physician_id,
                                   'pf_php', v_pfe.pf_php));
      else
        -- PF not yet disbursed. Draft a partial reversal JE (just the PF lines).
        -- Preserve 4200 revenue — clinic_fee is unrelated to payment status.
        -- The existing payment-void bridge handles the primary payment JE reversal.
        --
        -- Account resolution mirrors §6.1: use HMO accounts for HMO visits.
        -- For cash visits: PF was in 2110 (AP-Doctors), AR was 1100 (AR Patients).
        -- For HMO visits: PF was in 2160 (Doctor PF Pending HMO), AR was 1110 (AR HMO).
        v_year := extract(year from now())::smallint;
        v_je_number := public.je_next_number(v_year::int);
        insert into public.journal_entries(
          entry_number, posting_date, status, source_kind, source_id,
          description, created_by, reverses
        ) values (
          v_je_number, current_date, 'draft', 'reversal', null,
          'PF partial reversal due to payment void', v_actor, v_pfe.journal_entry_id
        ) returning id into v_je_id;

        -- Reverse PF credit: DR the account where PF was originally accrued.
        -- Reverse AR debit: CR the AR account originally debited at release.
        insert into public.journal_lines(entry_id, line_order, account_id, debit_php, credit_php, description)
        values (v_je_id, 1,
                public.coa_uuid_for_code(case when v_visit.hmo_provider_id is not null then '2160' else '2110' end),
                v_pfe.pf_php, 0, 'Reverse PF (payment voided)');
        insert into public.journal_lines(entry_id, line_order, account_id, debit_php, credit_php, description)
        values (v_je_id, 2,
                public.coa_uuid_for_code(case when v_visit.hmo_provider_id is not null then '1110' else '1100' end),
                0, v_pfe.pf_php, 'Reverse AR (PF portion)');

        update public.journal_entries set status = 'posted' where id = v_je_id;

        update public.doctor_pf_entries
          set voided_at   = now(),
              voided_by   = v_actor,
              void_reason = 'payment_voided'
          where id = v_pfe.id;
      end if;
    end loop;

    -- (b) HMO pending entries (hmo_at_settlement, recognized_at IS NULL).
    -- PF is still in 2160 (HMO settlement never fired). Reverse 2160/1110.
    for v_pfe in (
      select * from public.doctor_pf_entries
      where test_request_id = v_tr.id
        and recognition_basis = 'hmo_at_settlement'
        and recognized_at is null
        and voided_at is null
    ) loop
      v_year := extract(year from now())::smallint;
      v_je_number := public.je_next_number(v_year::int);
      insert into public.journal_entries(
        entry_number, posting_date, status, source_kind, source_id,
        description, created_by, reverses
      ) values (
        v_je_number, current_date, 'draft', 'reversal', null,
        'PF pending reversal: payment voided before HMO settlement', v_actor,
        v_pfe.journal_entry_id
      ) returning id into v_je_id;

      -- DR 2160 / CR 1110 — mirrors §6.1 HMO release lines.
      insert into public.journal_lines(entry_id, line_order, account_id, debit_php, credit_php, description)
      values (v_je_id, 1, public.coa_uuid_for_code('2160'),
              v_pfe.pf_php, 0, 'Reverse HMO PF pending (payment voided)');
      insert into public.journal_lines(entry_id, line_order, account_id, debit_php, credit_php, description)
      values (v_je_id, 2, public.coa_uuid_for_code('1110'),
              0, v_pfe.pf_php, 'Reverse HMO AR (PF portion)');

      update public.journal_entries set status = 'posted' where id = v_je_id;

      update public.doctor_pf_entries
        set voided_at   = now(),
            voided_by   = v_actor,
            void_reason = 'payment_voided_before_hmo_settlement'
        where id = v_pfe.id;
    end loop;

  end loop;

  return new;
end;
$$;

revoke all on function public.bridge_payment_void_pf_cascade() from public;


-- Section 6.6 — On INSERT into doctor_pf_disbursements, draft + post JE
-- (DR 2110 / CR cash account). See spec §4.6.
-- Cash account routing: cash→1010, gcash→1030, bank_transfer→1020.
create or replace function public.bridge_pf_disbursement_post()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor        uuid := auth.uid();
  v_cash_account text;
  v_je_id        uuid;
  v_je_number    text;
  v_year         smallint := extract(year from new.posted_date)::smallint;
begin
  v_cash_account := case new.method
    when 'cash'          then '1010'
    when 'gcash'         then '1030'
    when 'bank_transfer' then '1020'
  end;

  v_je_number := public.je_next_number(v_year::int);
  insert into public.journal_entries(
    entry_number, posting_date, status, source_kind, source_id,
    description, created_by
  ) values (
    v_je_number, new.posted_date, 'draft', 'doctor_pf_disbursement', new.id,
    'Doctor PF payout (' || new.method || ', batch PF-' || new.batch_number || ')', v_actor
  ) returning id into v_je_id;

  insert into public.journal_lines(entry_id, line_order, account_id, debit_php, credit_php, description)
  values (v_je_id, 1, public.coa_uuid_for_code('2110'),
          new.total_php, 0, 'Clear AP — Doctors');
  insert into public.journal_lines(entry_id, line_order, account_id, debit_php, credit_php, description)
  values (v_je_id, 2, public.coa_uuid_for_code(v_cash_account),
          0, new.total_php, 'Cash out');

  update public.journal_entries set status = 'posted' where id = v_je_id;

  update public.doctor_pf_disbursements set journal_entry_id = v_je_id where id = new.id;

  return new;
end;
$$;

revoke all on function public.bridge_pf_disbursement_post() from public;


-- Section 6.7 — On INSERT into cogs_send_out_trueups, emit variance JE
-- (4 cases per spec §4.7). When billed=accrued, no JE — just mark entries.
create or replace function public.bridge_cogs_send_out_trueup()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor       uuid := auth.uid();
  v_variance    numeric(12,2);
  v_je_id       uuid;
  v_je_number   text;
  v_year        smallint := extract(year from new.matched_at)::smallint;
begin
  -- Mark matching entries trued-up regardless of variance direction.
  update public.cogs_send_out_entries
    set trueup_id    = new.id,
        trued_up_at  = now()
    where vendor_id           = new.vendor_id
      and accrued_at::date between new.period_start_date and new.period_end_date
      and trueup_id is null
      and voided_at is null;

  v_variance := new.variance_php;  -- signed: billed − accrued

  if v_variance = 0 then return new; end if;  -- exact match; no JE needed

  v_je_number := public.je_next_number(v_year::int);
  insert into public.journal_entries(
    entry_number, posting_date, status, source_kind, source_id,
    description, created_by
  ) values (
    v_je_number, new.matched_at::date, 'draft', 'cogs_send_out_trueup', new.id,
    'Send-out variance true-up (vendor ' || new.vendor_id || ')', v_actor
  ) returning id into v_je_id;

  if v_variance > 0 then
    -- Under-accrued: billed > accrued → book additional COGS.
    insert into public.journal_lines(entry_id, line_order, account_id, debit_php, credit_php, description)
    values (v_je_id, 1, public.coa_uuid_for_code('6420'),
            v_variance, 0, 'COGS under-accrual catchup');
    insert into public.journal_lines(entry_id, line_order, account_id, debit_php, credit_php, description)
    values (v_je_id, 2, public.coa_uuid_for_code('2150'),
            0, v_variance, 'Top up accrued send-out');
  else
    -- Over-accrued: accrued > billed → reverse excess COGS.
    insert into public.journal_lines(entry_id, line_order, account_id, debit_php, credit_php, description)
    values (v_je_id, 1, public.coa_uuid_for_code('2150'),
            abs(v_variance), 0, 'Reverse over-accrual');
    insert into public.journal_lines(entry_id, line_order, account_id, debit_php, credit_php, description)
    values (v_je_id, 2, public.coa_uuid_for_code('6420'),
            0, abs(v_variance), 'Reverse COGS');
  end if;

  update public.journal_entries set status = 'posted' where id = v_je_id;
  update public.cogs_send_out_trueups set journal_entry_id = v_je_id where id = new.id;

  return new;
end;
$$;

revoke all on function public.bridge_cogs_send_out_trueup() from public;


-- =============================================================================
-- Section 7 — Trigger declarations.
-- =============================================================================

-- The existing bridge_test_request_released and bridge_test_request_cancelled
-- triggers (from 0030) remain; their functions were replaced above via
-- CREATE OR REPLACE and will be picked up automatically — no DROP/RECREATE needed.

-- New: PF settlement on HMO payment allocation insert.
drop trigger if exists trg_bridge_pf_at_hmo_allocation on public.hmo_payment_allocations;
create trigger trg_bridge_pf_at_hmo_allocation
  after insert on public.hmo_payment_allocations
  for each row execute function public.bridge_pf_at_hmo_allocation();

-- New: PF writeoff on HMO resolution insert — only for write_off destination.
drop trigger if exists trg_bridge_pf_at_hmo_writeoff on public.hmo_claim_resolutions;
create trigger trg_bridge_pf_at_hmo_writeoff
  after insert on public.hmo_claim_resolutions
  for each row
  when (new.destination = 'write_off')
  execute function public.bridge_pf_at_hmo_writeoff();

-- New: PF cascade on payment void.
drop trigger if exists trg_bridge_payment_void_pf_cascade on public.payments;
create trigger trg_bridge_payment_void_pf_cascade
  after update of voided_at on public.payments
  for each row
  when (old.voided_at is null and new.voided_at is not null)
  execute function public.bridge_payment_void_pf_cascade();

-- New: PF disbursement → JE.
drop trigger if exists trg_bridge_pf_disbursement_post on public.doctor_pf_disbursements;
create trigger trg_bridge_pf_disbursement_post
  after insert on public.doctor_pf_disbursements
  for each row execute function public.bridge_pf_disbursement_post();

-- New: send-out true-up → variance JE.
drop trigger if exists trg_bridge_cogs_send_out_trueup on public.cogs_send_out_trueups;
create trigger trg_bridge_cogs_send_out_trueup
  after insert on public.cogs_send_out_trueups
  for each row execute function public.bridge_cogs_send_out_trueup();

-- End of 0064_pf_cogs_schema.sql
