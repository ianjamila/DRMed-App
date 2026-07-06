-- 0111: payment void recalculates visit payment status (H4).
--
-- recalc_visit_payment (0001) fires only on INSERT and its SUM includes
-- voided rows — a fully-refunded visit stays 'paid' forever and the release
-- gate keeps passing. Fix both: filter voided rows in the SUM, and fire the
-- recalc on the void UPDATE (same WHEN shape as trg_bridge_payment_void, 0030).
--
-- `set search_path = public` is carried over from 0002 — a bare
-- create-or-replace would drop that attribute.

create or replace function public.recalc_visit_payment()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_total numeric(10,2);
  v_paid  numeric(10,2);
  v_calculated_status text;
begin
  select total_php into v_total
  from public.visits where id = new.visit_id for update;

  select coalesce(sum(amount_php), 0) into v_paid
  from public.payments
  where visit_id = new.visit_id
    and voided_at is null;          -- H4: voided payments no longer count

  if v_total = 0 or v_paid >= v_total then
    v_calculated_status := 'paid';
  elsif v_paid > 0 then
    v_calculated_status := 'partial';
  else
    v_calculated_status := 'unpaid';
  end if;

  update public.visits
  set paid_php = v_paid,
      payment_status = case
        when payment_status = 'waived' then 'waived'   -- preserved on void too
        else v_calculated_status
      end,
      updated_at = now()
  where id = new.visit_id;

  return new;
end;
$$;

create trigger trg_payments_recalc_on_void
  after update of voided_at on public.payments
  for each row
  when (old.voided_at is null and new.voided_at is not null)
  execute function public.recalc_visit_payment();
