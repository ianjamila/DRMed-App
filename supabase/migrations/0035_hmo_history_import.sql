-- =============================================================================
-- 0035_hmo_history_import.sql
-- =============================================================================
-- 12.A: Historical import of HMO claims from DR MED MASTERSHEET workbook
-- (Dec 2023 → admin-picked cutover, default today).
--
-- This migration:
--   * Adds is_historical flags to patients, visits, test_requests.
--   * Relaxes patients.birthdate NOT NULL when is_historical=true.
--   * Adds four staging tables: hmo_import_runs, hmo_history_staging,
--     hmo_provider_aliases, hmo_service_aliases.
--   * Extends hmo_claim_items with hmo_approval_date.
--   * Extends hmo_claim_batches with import_run_id + historical_source.
--   * Adds a new je_source_kind enum value 'hmo_history_opening'.
--   * Adds a session-flag-driven bypass on two JE-posting bridge functions.
--
-- Bridge bypass mechanism: when current_setting('app.skip_bridge_historical')
-- returns 'true' (set via SET LOCAL inside the commit transaction), the two
-- AFTER-INSERT JE bridges no-op. The importer manually posts opening JEs after
-- unsetting the flag. UPDATE-fired test_requests bridges don't need a bypass
-- because historical test_requests are INSERTed directly with status='released'.
-- =============================================================================

-- =============================================================================
-- Section 1 — Op-table is_historical flags + birthdate relaxation
-- =============================================================================

alter table public.patients      add column is_historical boolean not null default false;
alter table public.visits        add column is_historical boolean not null default false;
alter table public.test_requests add column is_historical boolean not null default false;

-- Birthdate is required for operational patients but allowed NULL for historical
-- (the workbook has no DOB). Existing rows already have non-NULL birthdate.
alter table public.patients alter column birthdate drop not null;
alter table public.patients
  add constraint patients_birthdate_required_when_not_historical
  check (is_historical = true or birthdate is not null);

-- Partial indexes keep the operational paths fast (queries filter is_historical=false).
create index idx_patients_active      on public.patients      (last_name, first_name) where is_historical = false;
create index idx_visits_active        on public.visits        (created_at desc)       where is_historical = false;
create index idx_test_requests_active on public.test_requests (created_at desc)       where is_historical = false;

-- Partial unique index supporting the patient upsert in commit_hmo_history_run.
-- Operational patients are keyed by drm_id (unique); historical patients are
-- deduped by normalized (last_name, first_name).
create unique index idx_patients_historical_one_per_name
  on public.patients (last_name, first_name) where is_historical = true;

-- =============================================================================
-- Section 2 — New tables for staging + alias persistence
-- =============================================================================

-- One row per dry-run or commit. Append-only audit record.
create table public.hmo_import_runs (
  id                       uuid primary key default gen_random_uuid(),
  run_kind                 text not null check (run_kind in ('dry_run', 'commit')),
  file_hash                text not null,
  file_name                text not null,
  cutover_date             date not null,                                  -- admin-supplied at upload time
  uploaded_by              uuid not null references public.staff_profiles(id),
  started_at               timestamptz not null default now(),
  finished_at              timestamptz,
  staging_count            int not null default 0,
  error_count              int not null default 0,
  warning_count            int not null default 0,
  variance_override_reason text,
  summary                  jsonb not null default '{}'::jsonb,
  committed_at             timestamptz
);

create index idx_hmo_import_runs_uploaded_by on public.hmo_import_runs (uploaded_by);
create index idx_hmo_import_runs_file_hash   on public.hmo_import_runs (file_hash);

-- One row per parsed workbook row that survives E='YES' filter + cutover filter.
create table public.hmo_history_staging (
  id                       uuid primary key default gen_random_uuid(),
  run_id                   uuid not null references public.hmo_import_runs(id) on delete cascade,
  source_tab               text not null check (source_tab in ('LAB SERVICE', 'DOCTOR CONSULTATION')),
  source_row_no            int  not null,
  source_date              date not null,
  patient_name_raw         text not null,                                 -- as in workbook, e.g. "Alava, Teresita"
  normalized_patient_name  text not null,                                 -- uppercased, trimmed, "LAST, FIRST"
  last_name_raw            text not null,                                 -- split: "Alava"
  first_name_raw           text not null,                                 -- split: "Teresita"
  provider_name_raw        text not null,
  provider_id_resolved     uuid references public.hmo_providers(id),
  service_name_raw         text not null,
  service_id_resolved      uuid references public.services(id),
  senior_pwd_flag          boolean not null default false,
  hmo_approval_date        date,
  billed_amount            numeric(12,2) not null check (billed_amount > 0),
  paid_amount              numeric(12,2) not null default 0,
  submission_date          date,
  reference_no             text,
  or_number                text,
  payment_received_date    date,
  visit_group_key          text,                                          -- sha256(date|name|provider)
  content_hash             text,                                          -- natural-key idempotency hash
  validation_errors        jsonb not null default '[]'::jsonb,
  status                   text not null default 'parsed'
    check (status in ('parsed', 'validated', 'committed', 'skipped_post_cutover', 'discarded')),
  created_at               timestamptz not null default now()
);

create index idx_hmo_history_staging_run        on public.hmo_history_staging (run_id);
create index idx_hmo_history_staging_visit_key  on public.hmo_history_staging (visit_group_key);
create index idx_hmo_history_staging_content    on public.hmo_history_staging (content_hash);
create index idx_hmo_history_staging_status     on public.hmo_history_staging (status);

-- Partial unique on content_hash only for committed rows — dry-runs can re-stage freely.
create unique index idx_hmo_history_staging_one_commit_per_content
  on public.hmo_history_staging (content_hash) where status = 'committed';

-- Persistent provider name → provider_id mapping. Survives across runs.
create table public.hmo_provider_aliases (
  alias       text primary key,
  provider_id uuid not null references public.hmo_providers(id),
  created_by  uuid not null references public.staff_profiles(id),
  created_at  timestamptz not null default now()
);

-- Persistent service name → service_id mapping. Covers both lab service strings
-- and doctor last names.
create table public.hmo_service_aliases (
  alias       text primary key,
  service_id  uuid not null references public.services(id),
  created_by  uuid not null references public.staff_profiles(id),
  created_at  timestamptz not null default now()
);

-- =============================================================================
-- Section 3 — Subledger extension + new JE source_kind
-- =============================================================================

alter table public.hmo_claim_items
  add column hmo_approval_date date;
comment on column public.hmo_claim_items.hmo_approval_date is
  '12.A: HMO pre-approval date from workbook col G. Captures "approved but unbilled" stuck state.';

alter table public.hmo_claim_batches
  add column import_run_id     uuid references public.hmo_import_runs(id),
  add column historical_source text;
comment on column public.hmo_claim_batches.import_run_id is
  '12.A: nullable; populated only on batches inserted by commit_hmo_history_run.';
comment on column public.hmo_claim_batches.historical_source is
  '12.A: e.g. "mastersheet:LAB SERVICE" or "mastersheet:DOCTOR CONSULTATION". Null for operational batches.';

-- 12.2 added the je_source_kind enum; 12.3 added 'hmo_claim_resolution'.
-- 12.A adds:
alter type public.je_source_kind add value if not exists 'hmo_history_opening';

-- =============================================================================
-- Section 4 — Bridge bypass: bridge_payment_insert
-- =============================================================================
-- Adds a single skip-flag check at the very top. The remainder of the function
-- body is copied verbatim from 0030_op_gl_bridge.sql. When the session-local
-- flag app.skip_bridge_historical = 'true' is set (only inside
-- commit_hmo_history_run), this function returns NEW without posting a JE.
-- =============================================================================

create or replace function public.bridge_payment_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_is_hmo         boolean;
  v_cash_id        uuid;
  v_ar_id          uuid;
  v_je_id          uuid;
  v_existing_je    uuid;
  v_suspense_id    uuid;
  v_used_suspense  boolean := false;
begin
  -- 12.A bypass: when the importer is inserting synthetic historical payments,
  -- no JE should post here — the importer will post per-provider opening JEs
  -- in a separate step after unsetting the flag.
  if coalesce(current_setting('app.skip_bridge_historical', true), '') = 'true' then
    return new;
  end if;

  -- Idempotency check: skip if a posted JE already exists for this payment.
  select id into v_existing_je
    from public.journal_entries
    where source_kind = 'payment'
      and source_id = NEW.id
      and status = 'posted'
    for update;
  if v_existing_je is not null then
    return NEW;
  end if;

  select (v.hmo_provider_id is not null) into v_is_hmo
    from public.visits v
    where v.id = NEW.visit_id;

  v_cash_id := public.resolve_cash_account(NEW.method);
  v_ar_id   := public.resolve_ar_account(coalesce(v_is_hmo, false));

  v_suspense_id := public.coa_uuid_for_code('9999');
  v_used_suspense := (v_cash_id = v_suspense_id);

  -- Insert as draft first so je_lines_balance_check doesn't fire mid-insertion.
  insert into public.journal_entries (
    posting_date, description, status, source_kind, source_id, created_by
  )
  values (
    NEW.received_at::date,
    'Payment received via ' || NEW.method,
    'draft',
    'payment',
    NEW.id,
    NEW.received_by
  )
  returning id into v_je_id;

  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, line_order)
  values
    (v_je_id, v_cash_id, NEW.amount_php, 0, 1),
    (v_je_id, v_ar_id,   0, NEW.amount_php, 2);

  -- Flip to posted — je_status_balance_check validates full balance here.
  update public.journal_entries set status = 'posted' where id = v_je_id;

  if v_used_suspense then
    insert into public.audit_log (actor_id, actor_type, action, resource_type, resource_id, metadata)
    values (
      NEW.received_by,
      'staff',
      'coa.suspense_post',
      'journal_entries',
      v_je_id,
      jsonb_build_object(
        'source_kind', 'payment',
        'source_id', NEW.id,
        'reason', 'no payment_method_account_map row',
        'attempted_lookup', NEW.method
      )
    );
  end if;

  return NEW;
end;
$$;

-- =============================================================================
-- Section 5 — Bridge bypass: bridge_hmo_claim_resolution_insert
-- =============================================================================
-- Defensive: 12.A does NOT insert hmo_claim_resolutions for historical rows,
-- but adding the same skip-flag guard at the top is cheap insurance.
-- The remainder of the function body is copied verbatim from
-- 0034_hmo_ar_subledger.sql.
-- =============================================================================

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
  -- 12.A bypass: defensive guard — historical imports do not insert
  -- hmo_claim_resolutions, but if a future path ever does so under the flag,
  -- skip JE posting and let the importer handle opening entries manually.
  if coalesce(current_setting('app.skip_bridge_historical', true), '') = 'true' then
    return new;
  end if;

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

-- =============================================================================
-- Section 6 — Row Level Security
-- =============================================================================
-- All four new tables are admin-only. Writes happen via Server Actions through
-- the service-role client (which bypasses RLS); reads happen via the SECURITY
-- DEFINER `requireAdminStaff()` gate that the pages call before rendering.
-- The explicit admin-read policy below is a defense-in-depth check.
-- =============================================================================

alter table public.hmo_import_runs        enable row level security;
alter table public.hmo_history_staging    enable row level security;
alter table public.hmo_provider_aliases   enable row level security;
alter table public.hmo_service_aliases    enable row level security;

create policy "hmo_import_runs: admin read"
  on public.hmo_import_runs
  for select to authenticated
  using (public.has_role(array['admin']));

create policy "hmo_history_staging: admin read"
  on public.hmo_history_staging
  for select to authenticated
  using (public.has_role(array['admin']));

create policy "hmo_provider_aliases: admin read"
  on public.hmo_provider_aliases
  for select to authenticated
  using (public.has_role(array['admin']));

create policy "hmo_service_aliases: admin read"
  on public.hmo_service_aliases
  for select to authenticated
  using (public.has_role(array['admin']));

-- =============================================================================
-- Section 7 — Reporting view
-- =============================================================================
-- v_historical_payments surfaces synthetic historical payments by the notes
-- prefix convention from §5B of the design spec. Admin-only via RLS on the
-- underlying payments table.

create view public.v_historical_payments as
  select * from public.payments
   where notes like '[historical-import:%]%';

comment on view public.v_historical_payments is
  '12.A: synthetic HMO payments inserted by commit_hmo_history_run().';
