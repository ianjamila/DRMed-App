-- =============================================================================
-- 0077_je_next_number_no_truncate.sql
-- =============================================================================
-- Bug: je_next_number used `lpad(v_next::text, 4, '0')` which truncates rather
-- than pads when v_next exceeds 4 digits. Postgres lpad reduces strings longer
-- than the target width (silently).
--
-- Surfaced by 12.B history import — fiscal_year 2025 consumed >9,999 numbers
-- via the per-row JE inserts, causing later calls to return entry numbers
-- like 'JE-2025-1030' (truncated from 10300) that collide with earlier JEs.
--
-- Fix: pad to the larger of 4 chars or the actual number's length. Keeps
-- existing 4-digit pretty format for normal years while allowing wider
-- numbers when needed.
-- =============================================================================

create or replace function public.je_next_number(p_fiscal_year int)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_next int;
begin
  insert into public.je_year_counters(fiscal_year, next_n)
    values (p_fiscal_year, 1)
    on conflict (fiscal_year) do nothing;

  update public.je_year_counters
    set next_n = next_n + 1
    where fiscal_year = p_fiscal_year
    returning next_n - 1 into v_next;

  return 'JE-' || p_fiscal_year::text || '-'
    || lpad(v_next::text, greatest(4, length(v_next::text)), '0');
end;
$$;
