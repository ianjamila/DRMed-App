-- 0048_ap_subledger_schema.sql
-- Phase 12.4 — Operating-Expense / AP Subledger — Schema layer.
-- Design spec: docs/superpowers/specs/2026-05-20-12.4-ap-subledger-design.md
-- Behavior (functions + triggers) lives in 0049.
-- Builds on 12.1 (GL foundation), 12.2 (Op→GL bridge), 12.3 (HMO AR subledger).

-- ==========================================================================
-- Section 0 — Enum extensions (must precede any function referencing them).
-- ==========================================================================

alter type public.je_source_kind add value if not exists 'bill_post';
alter type public.je_source_kind add value if not exists 'bill_payment';

-- ==========================================================================
-- Section 1 — Extensions (defense; likely already enabled by 0034).
-- ==========================================================================

create extension if not exists pg_trgm;

-- ==========================================================================
-- Section 2 — Tables.
-- ==========================================================================

-- Vendor master.
create table public.vendors (
  id                            uuid primary key default gen_random_uuid(),
  name                          text not null,
  tin                           text,
  email                         text,
  phone                         text,
  default_account_id            uuid references public.chart_of_accounts(id),
  default_wt_classification     text,
  default_wt_rate               numeric(5,4),
  notes                         text,
  is_active                     boolean not null default true,
  created_at                    timestamptz not null default now(),
  created_by                    uuid references auth.users(id),
  updated_at                    timestamptz not null default now(),
  updated_by                    uuid references auth.users(id),
  constraint vendors_default_wt_rate_range
    check (default_wt_rate is null or (default_wt_rate >= 0 and default_wt_rate <= 1))
);

-- Counters (year, next_n). Touched only by SECURITY DEFINER trigger functions.
create table public.bill_year_counters (
  year     int primary key,
  next_n   int not null default 1
);

create table public.bill_payment_year_counters (
  year     int primary key,
  next_n   int not null default 1
);

-- AP invoice header. template_id FK added later in this section (recurring_bill_templates
-- is defined below; PG requires the target table to exist at CREATE TABLE time).
create table public.bills (
  id                       uuid primary key default gen_random_uuid(),
  bill_number              text not null unique,                     -- BL-YYYY-NNNN, trigger-assigned
  vendor_id                uuid not null references public.vendors(id),
  vendor_invoice_number    text,
  bill_date                date not null,
  due_date                 date not null,
  status                   text not null default 'draft',
  description              text,
  gross_amount             numeric(12,2) not null default 0,         -- denorm from bill_lines
  wt_classification        text,
  wt_rate                  numeric(5,4),
  wt_exempt                boolean not null default false,
  wt_amount                numeric(12,2) not null default 0,
  net_payable              numeric(12,2) generated always as (gross_amount - wt_amount) stored,
  paid_amount              numeric(12,2) not null default 0,         -- denorm from allocations
  outstanding_amount       numeric(12,2) generated always as ((gross_amount - wt_amount) - paid_amount) stored,
  template_id              uuid,                                     -- FK added in sub-step 4 below
  posted_at                timestamptz,
  posted_by                uuid references auth.users(id),
  voided_at                timestamptz,
  voided_by                uuid references auth.users(id),
  void_reason              text,
  created_at               timestamptz not null default now(),
  created_by               uuid references auth.users(id),
  updated_at               timestamptz not null default now(),
  updated_by               uuid references auth.users(id),
  constraint bills_status_check       check (status in ('draft','posted','partially_paid','paid','voided')),
  constraint bills_due_after_bill     check (due_date >= bill_date),
  constraint bills_wt_amount_range    check (wt_amount >= 0 and wt_amount <= gross_amount),
  constraint bills_wt_rate_range      check (wt_rate is null or (wt_rate >= 0 and wt_rate <= 1)),
  constraint bills_gross_nonneg       check (gross_amount >= 0),
  constraint bills_paid_nonneg        check (paid_amount >= 0)
);

-- Bill line items.
create table public.bill_lines (
  id            uuid primary key default gen_random_uuid(),
  bill_id       uuid not null references public.bills(id) on delete cascade,
  line_no       int not null,
  description   text,
  amount_php    numeric(12,2) not null,
  account_id    uuid not null references public.chart_of_accounts(id),
  created_at    timestamptz not null default now(),
  constraint bill_lines_line_no_positive check (line_no >= 1),
  constraint bill_lines_amount_positive  check (amount_php > 0),
  constraint bill_lines_unique_line unique (bill_id, line_no)
);

-- Payment outflow events.
create table public.bill_payments (
  id                   uuid primary key default gen_random_uuid(),
  payment_number       text not null unique,                         -- BP-YYYY-NNNN, trigger-assigned
  vendor_id            uuid not null references public.vendors(id),  -- denorm of allocation vendors
  payment_date         date not null,
  method               text not null,
  cash_account_id      uuid not null references public.chart_of_accounts(id),
  amount_php           numeric(12,2) not null,
  reference            text,
  cheque_number        text,
  cheque_date          date,
  voided_at            timestamptz,
  voided_by            uuid references auth.users(id),
  void_reason          text,
  created_at           timestamptz not null default now(),
  created_by           uuid references auth.users(id),
  updated_at           timestamptz not null default now(),
  updated_by           uuid references auth.users(id),
  constraint bill_payments_method_check check (method in ('cash','bank_transfer','gcash','cheque')),
  constraint bill_payments_amount_positive check (amount_php > 0),
  constraint bill_payments_payment_date_not_future
    check (payment_date <= ((now() at time zone 'Asia/Manila')::date)),
  constraint bill_payments_cheque_fields
    check ((method = 'cheque') = (cheque_number is not null and cheque_date is not null))
);

-- M:N allocation linking payments to bills.
create table public.bill_payment_allocations (
  id                  uuid primary key default gen_random_uuid(),
  payment_id          uuid not null references public.bill_payments(id) on delete cascade,
  bill_id             uuid not null references public.bills(id),  -- no on-delete cascade: bills are voided not deleted; allocations are audit-preserved
  allocated_amount    numeric(12,2) not null,
  voided_at           timestamptz,
  created_at          timestamptz not null default now(),
  constraint bill_payment_allocations_amount_positive check (allocated_amount > 0),
  constraint bill_payment_allocations_unique_pair unique (payment_id, bill_id)
);

-- File attachments (lives in storage bucket bill-attachments).
create table public.bill_attachments (
  id              uuid primary key default gen_random_uuid(),
  bill_id         uuid not null references public.bills(id) on delete cascade,
  storage_path    text not null,
  filename        text not null,
  mime_type       text not null,
  size_bytes      int not null,
  uploaded_at     timestamptz not null default now(),
  uploaded_by     uuid not null references auth.users(id),
  constraint bill_attachments_mime_allowlist
    check (mime_type in ('application/pdf','image/jpeg','image/png')),
  constraint bill_attachments_size_cap
    check (size_bytes > 0 and size_bytes <= 10485760)
);

-- Recurring bill templates — cron-fired to auto-create drafts.
create table public.recurring_bill_templates (
  id                          uuid primary key default gen_random_uuid(),
  vendor_id                   uuid not null references public.vendors(id),
  description                 text not null,
  cadence                     text not null default 'monthly',
  due_day_of_month            int not null,
  bill_date_offset_days       int not null default 0,
  amount_php                  numeric(12,2),
  default_account_id          uuid not null references public.chart_of_accounts(id),
  default_wt_classification   text,
  default_wt_rate             numeric(5,4),
  default_wt_exempt           boolean not null default false,
  next_run_date               date not null,
  is_active                   boolean not null default true,
  created_at                  timestamptz not null default now(),
  created_by                  uuid references auth.users(id),
  updated_at                  timestamptz not null default now(),
  updated_by                  uuid references auth.users(id),
  constraint recurring_cadence_check    check (cadence = 'monthly'),
  constraint recurring_due_day_range    check (due_day_of_month between 1 and 31),
  constraint recurring_offset_range     check (bill_date_offset_days between -30 and 0),
  constraint recurring_wt_rate_range    check (default_wt_rate is null or (default_wt_rate >= 0 and default_wt_rate <= 1)),
  constraint recurring_amount_positive  check (amount_php is null or amount_php > 0)
);

-- Now that recurring_bill_templates exists, add the FK from bills.
alter table public.bills
  add constraint bills_template_fk
  foreign key (template_id) references public.recurring_bill_templates(id) on delete set null;

-- ==========================================================================
-- Section 3 — Indexes.
-- ==========================================================================

-- vendors: case-insensitive uniqueness on name; partial unique on tin; trigram for search.
create unique index vendors_lower_name_unique on public.vendors (lower(name));
create unique index vendors_tin_unique        on public.vendors (tin) where tin is not null;
create index idx_vendors_name_trgm            on public.vendors using gin (name gin_trgm_ops);
create index idx_vendors_active               on public.vendors (is_active) where is_active = true;

-- bills: aging queries hit (vendor_id, status, due_date); outstanding > 0 hot path is its own partial index.
create index idx_bills_vendor_status_due      on public.bills (vendor_id, status, due_date);
create index idx_bills_outstanding            on public.bills (outstanding_amount) where outstanding_amount > 0;
create index idx_bills_status                 on public.bills (status);
create index idx_bills_search_trgm            on public.bills using gin (vendor_invoice_number gin_trgm_ops, description gin_trgm_ops);
create index idx_bills_template               on public.bills (template_id) where template_id is not null;
create index idx_bills_bill_date              on public.bills (bill_date);

-- bill_lines: by-account aggregation.
create index idx_bill_lines_account           on public.bill_lines (account_id);

-- bill_payments: filter views by vendor/method/date.
create index idx_bill_payments_vendor         on public.bill_payments (vendor_id);
create index idx_bill_payments_method         on public.bill_payments (method);
create index idx_bill_payments_date           on public.bill_payments (payment_date);

-- bill_payment_allocations: paid_amount denorm hot path.
create index idx_bill_payment_allocations_bill_active
  on public.bill_payment_allocations (bill_id) where voided_at is null;

-- bill_attachments: list-by-bill.
create index idx_bill_attachments_bill        on public.bill_attachments (bill_id);

-- recurring_bill_templates: cron query hot path.
create index idx_recurring_bill_templates_active_next_run
  on public.recurring_bill_templates (next_run_date) where is_active = true;

-- ==========================================================================
-- Section 4 — Row Level Security.
-- ==========================================================================

alter table public.vendors                    enable row level security;
alter table public.bills                      enable row level security;
alter table public.bill_lines                 enable row level security;
alter table public.bill_payments              enable row level security;
alter table public.bill_payment_allocations   enable row level security;
alter table public.bill_attachments           enable row level security;
alter table public.recurring_bill_templates   enable row level security;
alter table public.bill_year_counters         enable row level security;
alter table public.bill_payment_year_counters enable row level security;

-- Admin-only policies on the 7 operational tables.
create policy vendors_admin_all on public.vendors
  for all using (public.has_role(array['admin'])) with check (public.has_role(array['admin']));

create policy bills_admin_all on public.bills
  for all using (public.has_role(array['admin'])) with check (public.has_role(array['admin']));

create policy bill_lines_admin_all on public.bill_lines
  for all using (public.has_role(array['admin'])) with check (public.has_role(array['admin']));

create policy bill_payments_admin_all on public.bill_payments
  for all using (public.has_role(array['admin'])) with check (public.has_role(array['admin']));

create policy bill_payment_allocations_admin_all on public.bill_payment_allocations
  for all using (public.has_role(array['admin'])) with check (public.has_role(array['admin']));

create policy bill_attachments_admin_all on public.bill_attachments
  for all using (public.has_role(array['admin'])) with check (public.has_role(array['admin']));

create policy recurring_bill_templates_admin_all on public.recurring_bill_templates
  for all using (public.has_role(array['admin'])) with check (public.has_role(array['admin']));

-- Counters (bill_year_counters, bill_payment_year_counters): RLS enabled,
-- no policy granted. Only SECURITY DEFINER trigger functions (owned by
-- supabase_admin / postgres superuser) touch them. Admin never reads
-- or writes directly.

-- ==========================================================================
-- Section 5 — Storage bucket for bill attachments.
-- Path convention: bills/<bill_id>/<uuid>-<sanitized_filename>
-- All access goes through service-role-issued signed URLs (5-minute TTL)
-- from Server Actions. No bucket-level RLS policies (matches 0001 results
-- bucket pattern).
-- ==========================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'bill-attachments',
  'bill-attachments',
  false,
  10485760,                                                          -- 10 MB
  array['application/pdf','image/jpeg','image/png']
)
on conflict (id) do nothing;
