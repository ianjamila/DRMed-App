-- scripts/smoke-12.4.sql
-- Phase 12.4 AP Subledger smoke. ~72 assertions across 19 groups.
-- Run via local Docker Supabase ONLY (Supabase MCP execute_sql does NOT honor
-- BEGIN/ROLLBACK; smoke writes would leak. Lesson from 12.3.)
--
-- Cleanup pattern for JE-touching tests:
--   update journal_entries set status='draft' where source_id in (...);
--   delete from journal_lines where entry_id in (...);
--   delete from journal_entries where source_id in (...);
-- (Avoids je_status_balance_check trap when a posted JE's last line is deleted.)
--
-- Run: docker exec -i supabase_db_DRMed psql -U postgres -d postgres < scripts/smoke-12.4.sql

\echo '== 12.4 AP smoke starting =='
set search_path = public, pg_temp;

-- ==========================================================================
-- Group 1 — DDL & schema (15 assertions A1-A15)
-- ==========================================================================

do $$ begin
  assert (select count(*) from information_schema.tables
          where table_schema='public' and table_name='vendors') = 1,
    'A1: vendors table missing';
end $$;

do $$ begin
  assert (select count(*) from information_schema.tables
          where table_schema='public' and table_name in
            ('bills','bill_lines','bill_payments','bill_payment_allocations',
             'bill_attachments','recurring_bill_templates',
             'bill_year_counters','bill_payment_year_counters')) = 8,
    'A2: one or more 12.4 tables missing';
end $$;

do $$ begin
  assert exists (select 1 from information_schema.columns
                 where table_name='bills' and column_name='net_payable'
                 and is_generated='ALWAYS'),
    'A3: bills.net_payable not GENERATED';
end $$;

do $$ begin
  assert exists (select 1 from information_schema.columns
                 where table_name='bills' and column_name='outstanding_amount'
                 and is_generated='ALWAYS'),
    'A4: bills.outstanding_amount not GENERATED';
end $$;

do $$ begin
  assert exists (select 1 from information_schema.table_constraints
                 where table_name='bill_payments'
                 and constraint_name='bill_payments_cheque_fields'),
    'A5: cheque CHECK constraint missing';
end $$;

do $$ begin
  assert (select count(*) from pg_indexes
          where schemaname='public' and tablename='vendors'
          and indexname in ('vendors_lower_name_unique','vendors_tin_unique','idx_vendors_name_trgm')) = 3,
    'A6: vendors indexes missing';
end $$;

do $$ begin
  assert exists (select 1 from pg_indexes
                 where indexname='idx_bills_outstanding'),
    'A7: idx_bills_outstanding missing';
end $$;

do $$ begin
  assert exists (select 1 from pg_constraint
                 where conname='bills_wt_amount_range'),
    'A8: wt_amount CHECK missing';
end $$;

do $$ begin
  assert exists (select 1 from pg_constraint
                 where conname='bills_due_after_bill'),
    'A9: due_date >= bill_date CHECK missing';
end $$;

do $$ begin
  assert exists (select 1 from pg_constraint
                 where conname='bill_payments_payment_date_not_future'),
    'A10: payment_date <= today CHECK missing';
end $$;

do $$ begin
  assert exists (select 1 from pg_constraint
                 where conname='bill_payment_allocations_unique_pair'),
    'A11: allocation unique pair missing';
end $$;

do $$ begin
  assert exists (select 1 from pg_constraint
                 where conname='bill_attachments_mime_allowlist'),
    'A12: mime allowlist CHECK missing';
end $$;

do $$ begin
  assert exists (select 1 from pg_constraint
                 where conname='recurring_due_day_range'),
    'A13: due_day_of_month CHECK missing';
end $$;

do $$ begin
  assert exists (select 1 from pg_indexes
                 where indexname='idx_bills_search_trgm'),
    'A14: bills trigram index missing';
end $$;

do $$ begin
  assert exists (select 1 from pg_constraint
                 where conname='bills_template_fk'),
    'A15: bills.template_id FK missing';
end $$;

\echo '== Group 1 passed (A1-A15) =='

-- ==========================================================================
-- Group 2 — Enum extensions (2 assertions A16-A17)
-- ==========================================================================

do $$ begin
  assert exists (select 1 from pg_enum
                 where enumtypid='public.je_source_kind'::regtype and enumlabel='bill_post'),
    'A16: bill_post enum value missing';
end $$;

do $$ begin
  assert exists (select 1 from pg_enum
                 where enumtypid='public.je_source_kind'::regtype and enumlabel='bill_payment'),
    'A17: bill_payment enum value missing';
end $$;

\echo '== Group 2 passed (A16-A17) =='

-- ==========================================================================
-- Group 3 — pg_trgm extension (1 assertion A18)
-- ==========================================================================

do $$ begin
  assert exists (select 1 from pg_extension where extname='pg_trgm'),
    'A18: pg_trgm extension missing';
end $$;

\echo '== Group 3 passed (A18) =='

-- ==========================================================================
-- Group 4 — RLS (3 assertions A19-A21)
-- ==========================================================================

do $$ begin
  assert (select count(*) from pg_tables
          where schemaname='public' and tablename in
            ('vendors','bills','bill_lines','bill_payments','bill_payment_allocations',
             'bill_attachments','recurring_bill_templates',
             'bill_year_counters','bill_payment_year_counters')
          and rowsecurity = true) = 9,
    'A19: RLS not enabled on all 9 tables';
end $$;

do $$ begin
  assert (select count(*) from pg_policies
          where schemaname='public' and tablename in
            ('vendors','bills','bill_lines','bill_payments','bill_payment_allocations',
             'bill_attachments','recurring_bill_templates')) = 7,
    'A20: admin policies missing on 7 operational tables';
end $$;

do $$ begin
  assert (select count(*) from pg_policies
          where schemaname='public' and tablename in
            ('bill_year_counters','bill_payment_year_counters')) = 0,
    'A21: counters should have no policy (deny by default)';
end $$;

\echo '== Group 4 passed (A19-A21) =='

-- ==========================================================================
-- Group 5 — Counters (4 assertions A22-A25)
-- ==========================================================================

do $$
declare v_vendor uuid; v_year int := extract(year from (now() at time zone 'Asia/Manila'))::int;
declare v_bp_id uuid; v_cash uuid;
begin
  -- Setup: seed a vendor + a cash account uuid.
  insert into public.vendors (name) values ('SMOKE-12.4-COUNTER-V1') returning id into v_vendor;
  select id into v_cash from public.chart_of_accounts where code='1010' limit 1;

  -- A22: First bill in current year is BL-YYYY-0001
  insert into public.bills (vendor_id, bill_date, due_date, description)
  values (v_vendor, current_date, current_date, 'smoke counter test 1');

  assert (select bill_number from public.bills where description='smoke counter test 1')
    = format('BL-%s-0001', v_year::text),
    'A22: first bill_number not BL-YYYY-0001';

  -- A23: Second increments
  insert into public.bills (vendor_id, bill_date, due_date, description)
  values (v_vendor, current_date, current_date, 'smoke counter test 2');

  assert (select bill_number from public.bills where description='smoke counter test 2')
    = format('BL-%s-0002', v_year::text),
    'A23: second bill_number not BL-YYYY-0002';

  -- A24: payment number assigned via trigger.
  insert into public.bill_payments (
    vendor_id, payment_date, method, cash_account_id, amount_php
  ) values (v_vendor, current_date, 'cash', v_cash, 100.00)
  returning id into v_bp_id;

  assert (select payment_number from public.bill_payments where id=v_bp_id) like 'BP-' || v_year::text || '-%',
    'A24: payment number not assigned';

  -- A25: bill_year_counter advanced past 1.
  assert (select next_n from public.bill_year_counters where year = v_year) >= 2,
    'A25: bill_year_counter not advanced';

  -- Cleanup. Bills are draft so no JE was emitted; payment got a JE.
  update public.journal_entries set status='draft'
    where source_kind='bill_payment' and source_id=v_bp_id;
  delete from public.journal_lines
    where entry_id in (select id from public.journal_entries
                       where source_kind='bill_payment' and source_id=v_bp_id);
  delete from public.journal_entries
    where source_kind='bill_payment' and source_id=v_bp_id;
  delete from public.bill_payment_allocations where payment_id = v_bp_id;
  delete from public.bill_payments where id = v_bp_id;
  delete from public.bills where description like 'smoke counter test%';
  delete from public.vendors where id = v_vendor;
end $$;

\echo '== Group 5 passed (A22-A25) =='
