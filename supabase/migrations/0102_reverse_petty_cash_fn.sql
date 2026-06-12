-- 0102_reverse_petty_cash_fn.sql
--
-- Atomic reversal for reception petty-cash entries.
--
-- Voiding a petty-cash entry must, in ONE transaction: post a balanced reversal
-- JE (lines swapped) and mark the original `reversed`. Doing this as separate
-- app-side writes risks a half-done reversal (reversal posted but original still
-- `posted` → the expense is double-counted) and a double-void race (two
-- reversals against one entry). This function mirrors `bridge_cash_adjustment_void`
-- (0043): it locks the original row `for update`, so concurrent voids serialise,
-- and the whole thing commits or rolls back atomically.
--
-- Separate migration from 0101 so the `petty_cash` enum value is committed first.

create or replace function public.reverse_petty_cash_entry(
  p_je_id  uuid,
  p_reason text,
  p_actor  uuid
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id          uuid;
  v_number      text;
  v_status      public.je_status;
  v_kind        public.je_source_kind;
  v_reversal    uuid;
  v_next        text;
  v_today       date := (now() at time zone 'Asia/Manila')::date;
begin
  -- Lock the original so concurrent voids can't both pass the status check.
  select id, entry_number, status, source_kind
    into v_id, v_number, v_status, v_kind
    from public.journal_entries
    where id = p_je_id
    for update;

  if v_id is null or v_kind <> 'petty_cash' then
    raise exception 'Petty-cash entry not found.'
      using errcode = 'P0037';
  end if;
  if v_status <> 'posted' then
    raise exception 'This entry is already reversed.'
      using errcode = 'P0038';
  end if;
  if coalesce(btrim(p_reason), '') = '' then
    raise exception 'A reason is required for the reversal.'
      using errcode = 'P0039';
  end if;

  v_next := public.je_next_number(extract(year from v_today)::int);

  insert into public.journal_entries (
    entry_number, posting_date, description, notes,
    status, source_kind, source_id, reverses, created_by
  )
  values (
    v_next,
    v_today,
    left('Reversal of ' || v_number || ': ' || p_reason, 500),
    'petty_cash_void | actor=' || coalesce(p_actor::text, 'unknown'),
    'draft',
    'reversal',
    null,
    v_id,
    p_actor
  )
  returning id into v_reversal;

  -- Swap debit/credit of every original line.
  insert into public.journal_lines (entry_id, account_id, debit_php, credit_php, description, line_order)
  select v_reversal, account_id, credit_php, debit_php, description, line_order
    from public.journal_lines
    where entry_id = v_id
    order by line_order;

  -- Post the reversal (balance check fires here), then mark the original.
  update public.journal_entries set status = 'posted', posted_at = now() where id = v_reversal;
  update public.journal_entries set status = 'reversed', reversed_by = v_reversal where id = v_id;

  return v_reversal;
end;
$$;

-- Service-role (the app's admin client) calls this; lock it down otherwise.
revoke all on function public.reverse_petty_cash_entry(uuid, text, uuid) from public;
