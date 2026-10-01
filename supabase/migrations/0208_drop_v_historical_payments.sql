-- 0208_drop_v_historical_payments.sql — make the migrations match prod.
--
-- 0035 created public.v_historical_payments (`select * from payments where
-- notes like '[historical-import:%]%'`) for admin reporting. Prod does not
-- have it — it was removed out of band at some point, no migration dropped
-- it — and nothing in src/ or scripts/ reads it (checked 2026-09-30; only the
-- generated types listed it). A read-only compare of every table, view,
-- function, trigger and type the migrations create against prod found no
-- other gap.
--
-- Dropping it here, rather than restoring it on prod, because of what it is
-- on every fresh replay (local stack, isolated stacks, any rebuild): a plain
-- view — no security_invoker — over payments, owned by postgres, with the
-- default grants of its era (anon and authenticated: every privilege). It
-- reads and writes payments with its owner's rights, so payments RLS never
-- applies through it. On prod this is a no-op (`if exists`).

drop view if exists public.v_historical_payments;

do $$
begin
  if to_regclass('public.v_historical_payments') is not null then
    raise exception '0208: public.v_historical_payments still exists';
  end if;
end;
$$;
