-- =============================================================================
-- 0029_gl_foundation_fixes.sql
-- =============================================================================
-- Fix-forward patch for 0028_gl_foundation.sql, addressing gaps surfaced in
-- the code-quality review of commit a38ac5c:
--
--   1. Zero-line deletion gap: if all lines of a posted JE are deleted in one
--      statement, SUM(debit)=0 and SUM(credit)=0 so 0=0 passes silently,
--      voiding the entry without error. Both balance triggers now raise P0003
--      when a posted entry has no lines remaining after the operation.
--
--   2. je_period_lock_check error wording: previous message said "Cannot post"
--      but the trigger also fires when editing any field (e.g. description) on
--      an already-posted JE in a now-closed period. Wording changed to
--      "Cannot modify journal entry dated % — that period is closed."
--
--   3. period_status_for comment: documents why `stable` is safe in production
--      (periods are never re-opened mid-transaction in real operations).
--
--   4. je_lines_balance_check return value: AFTER triggers' return value is
--      ignored by Postgres; changed from coalesce(new, old) to null for clarity.
--
-- No triggers are dropped or recreated — CREATE OR REPLACE preserves all
-- existing trigger bindings.
-- =============================================================================

-- ---- Fix #3: comment on period_status_for -----------------------------------
-- Production transactions never re-open a period mid-tx, so `stable` is safe:
-- Postgres may cache the result within a single query, but each new statement
-- in the same tx re-evaluates it. The smoke test's intra-tx reopen is a
-- test-only pattern (test 11 reopens Q1 and recloses in the same DO block).

comment on function public.period_status_for(date) is
  'Returns the period status (''open'', ''closed'', or ''unknown'') for a given date. '
  'Declared STABLE because production transactions never re-open a period mid-tx; '
  'the intra-tx reopen seen in the smoke test (test 11) is a test-only pattern.';

-- ---- Fix #2 + #4: je_period_lock_check — "modify" wording ------------------

create or replace function public.je_period_lock_check()
returns trigger
language plpgsql
as $$
declare
  v_status text;
begin
  if new.status = 'posted' then
    v_status := public.period_status_for(new.posting_date);
    if v_status = 'closed' then
      raise exception 'Cannot modify journal entry dated % — that period is closed.', new.posting_date
        using errcode = 'P0002';
    end if;
  end if;
  return new;
end;
$$;

-- ---- Fix #1 + #6: je_lines_balance_check — zero-line guard + return null ---

create or replace function public.je_lines_balance_check()
returns trigger
language plpgsql
as $$
declare
  v_entry_id     uuid;
  v_status       public.je_status;
  v_number       text;
  v_total_debit  numeric(14,2);
  v_total_credit numeric(14,2);
  v_line_count   int;
begin
  v_entry_id := coalesce(new.entry_id, old.entry_id);

  select status, entry_number into v_status, v_number
    from public.journal_entries
    where id = v_entry_id;

  if v_status is null or v_status <> 'posted' then
    -- AFTER trigger; return value is ignored
    return null;
  end if;

  select
    count(*),
    coalesce(sum(debit_php), 0),
    coalesce(sum(credit_php), 0)
    into v_line_count, v_total_debit, v_total_credit
    from public.journal_lines
    where entry_id = v_entry_id;

  -- Zero-line guard: deleting all lines of a posted JE would yield 0=0,
  -- silently voiding the entry. Catch it explicitly.
  if v_line_count = 0 then
    raise exception 'Journal entry % has no lines after this operation.', v_number
      using errcode = 'P0003';
  end if;

  if v_total_debit <> v_total_credit then
    raise exception
      'Journal entry % is unbalanced: debits ₱% vs credits ₱% (off by ₱%).',
      v_number, v_total_debit, v_total_credit, abs(v_total_debit - v_total_credit)
      using errcode = 'P0001';
  end if;

  -- AFTER trigger; return value is ignored
  return null;
end;
$$;

-- ---- Fix #1: je_status_balance_check — zero-line guard ----------------------

create or replace function public.je_status_balance_check()
returns trigger
language plpgsql
as $$
declare
  v_total_debit  numeric(14,2);
  v_total_credit numeric(14,2);
  v_line_count   int;
begin
  if new.status = 'posted' and (old.status is distinct from 'posted') then
    select
      count(*),
      coalesce(sum(debit_php), 0),
      coalesce(sum(credit_php), 0)
      into v_line_count, v_total_debit, v_total_credit
      from public.journal_lines
      where entry_id = new.id;

    -- Zero-line guard: flipping draft→posted on an entry with no lines is
    -- pathological; 0=0 would otherwise pass silently.
    if v_line_count = 0 then
      raise exception 'Journal entry % has no lines after this operation.', new.entry_number
        using errcode = 'P0003';
    end if;

    if v_total_debit <> v_total_credit then
      raise exception
        'Journal entry % cannot be posted: debits ₱% vs credits ₱% (off by ₱%).',
        new.entry_number, v_total_debit, v_total_credit, abs(v_total_debit - v_total_credit)
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
