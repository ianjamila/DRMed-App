-- 0118: classify-then-revoke EXECUTE on anon/authenticated-reachable
--       SECURITY DEFINER functions (follow-up to 0113).
--
-- BACKGROUND
-- ----------
-- On the hosted Supabase project, default privileges auto-grant EXECUTE on every
-- newly created function to `anon` and `authenticated` *directly* (not via PUBLIC).
-- 0113 fixed this for the two booking RPCs; it was never done for the other 78
-- SECURITY DEFINER functions. Because SECURITY DEFINER runs as the owner and
-- bypasses RLS, anything reachable this way is a hole straight past both RLS and
-- the app's `requireActiveStaff()` / `requireAdminStaff()` gates.
--
-- Two exposures, both closed here:
--   * anon           — anyone holding the public anon key can POST to
--                      /rest/v1/rpc/<name>.
--   * authenticated  — any signed-in staff member (even the lowest role) can call
--                      admin-only RPCs with their own JWT. Worse than anon: these
--                      functions take `p_actor_id` as a parameter, so audit
--                      attribution is caller-controlled and therefore forgeable.
--
-- This is deliberately NOT a blanket revoke. Every function was classified; five
-- keep a grant on purpose. Two facts were verified empirically on Postgres 17
-- before writing this migration:
--
--   FACT 1  Revoking EXECUTE on a *trigger* function does NOT break the trigger.
--           Postgres checks that privilege at CREATE TRIGGER time, not at fire
--           time. (Verified: insert by a role with no EXECUTE still fired the
--           trigger and applied its changes.) -> the 44 trigger/event-trigger
--           functions below are safe to revoke.
--
--   FACT 2  A SECURITY INVOKER function that nest-calls a SECURITY DEFINER helper
--           DOES fail with "permission denied for function ..." when the calling
--           role lacks EXECUTE on the helper. (Verified: insert aborted.) -> this
--           is why bucket B below keeps its `authenticated` grant.
--
-- CLASSIFICATION
-- --------------
-- KEEP (legitimately public, not revoked):
--   has_role(text[]), is_staff(), staff_role()
--     All three are `auth.uid()`-scoped predicates that report only on the
--     caller's own identity — they return false/null for anon and leak nothing.
--     has_role() is load-bearing: 123 RLS policies reference it, 8 of them with
--     role `public` on tables anon holds table grants for. Revoking it would turn
--     those reads into "permission denied for function has_role" instead of the
--     intended empty result. It is also called as literal anon by
--     src/app/api/admin/gift-codes/sales.csv/route.ts, where the call IS the gate.
--
-- BUCKET B — revoke anon, KEEP authenticated (2):
--   eod_lock_check, employee_leave_balance
--     Nest-called by SECURITY INVOKER triggers on payments, eod_cash_adjustments
--     and employee_leave_records. Those tables carry `{authenticated}` RLS write
--     policies (reception/admin), so a staff write reaches the helper as
--     `authenticated` — see FACT 2. No RLS policy lets anon write them, so
--     dropping anon is safe.
--     NB: je_next_number is the same *shape* but is NOT in this bucket —
--     journal_entries has no INSERT/UPDATE/ALL policy at all, so only service_role
--     (which bypasses RLS) ever reaches its trigger. It is revoked from both.
--
-- BUCKET C — revoke both (44): trigger + event-trigger functions.
--     Not reachable over PostgREST (it excludes trigger-returning functions) and
--     safe per FACT 1. Defense in depth.
--
-- BUCKET D — revoke both (29): callable AP/GL/payroll/HMO RPCs and resolvers.
--     Every one is invoked exclusively through the service-role admin client
--     (all 42 `.rpc(` call sites in the repo were traced). Verified that none is
--     referenced by a column DEFAULT, CHECK constraint, generated column, index
--     expression, view, or SECURITY INVOKER function body, so nothing evaluates
--     them as the calling role.
--
-- WHY `public` IS IN EVERY REVOKE LIST
-- -----------------------------------
-- 65 of these 75 functions also carry an EXECUTE grant to PUBLIC (grantee `-` in
-- the ACL), which anon and authenticated inherit. Revoking the *direct* anon and
-- authenticated grants alone — the shape 0113 used — would therefore have been a
-- no-op for security on those 65: both roles would still reach the function
-- through PUBLIC. 0113 was only sufficient because 0112 had already run
-- `revoke all ... from public` on its two functions. Every revoke below names
-- `public` as well.
--
-- Naming `public` has a consequence that differs by environment. On the hosted
-- project all 75 functions hold explicit (non-PUBLIC) EXECUTE grants for both
-- `service_role` and `postgres`, so revoking PUBLIC costs them nothing. On a fresh
-- `supabase db reset` most of the same functions have a NULL ACL — owner only,
-- plus Postgres's built-in default EXECUTE to PUBLIC — so there `service_role`
-- reaches them only *through* PUBLIC and the revoke would strip it. That is why
-- the callable RPCs are re-granted to `service_role` explicitly further down, and
-- why the self-verification block asserts it.
--
-- Revoking a grant that is not present is a harmless no-op, so this migration is
-- safe to replay and safe on the local stack (where the default grants differ).

-- ---------------------------------------------------------------------------
-- Bucket B — revoke anon (and PUBLIC); `authenticated` MUST retain EXECUTE
-- (FACT 2). The grant is re-issued explicitly rather than left to survive as an
-- inherited PUBLIC grant, so the end state is identical on the hosted project and
-- on a fresh `db reset` regardless of how the original grant was made.
-- ---------------------------------------------------------------------------
revoke execute on function public.employee_leave_balance(p_employee_id uuid, p_kind text, p_as_of_date date) from public, anon;
grant  execute on function public.employee_leave_balance(p_employee_id uuid, p_kind text, p_as_of_date date) to authenticated;

revoke execute on function public.eod_lock_check(p_business_date date, p_shift_id uuid) from public, anon;
grant  execute on function public.eod_lock_check(p_business_date date, p_shift_id uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Bucket C — trigger / event-trigger functions (safe per FACT 1).
-- ---------------------------------------------------------------------------
revoke execute on function public.advance_test_on_rtr_insert() from public, anon, authenticated;
revoke execute on function public.ap_assign_bill_number() from public, anon, authenticated;
revoke execute on function public.ap_assign_payment_number() from public, anon, authenticated;
revoke execute on function public.ap_bill_payment_bridge() from public, anon, authenticated;
revoke execute on function public.ap_bill_payment_void_cascade() from public, anon, authenticated;
revoke execute on function public.ap_bill_post_bridge() from public, anon, authenticated;
revoke execute on function public.ap_bill_void_guard() from public, anon, authenticated;
revoke execute on function public.ap_recompute_bill_gross() from public, anon, authenticated;
revoke execute on function public.ap_recompute_bill_paid_and_status() from public, anon, authenticated;
revoke execute on function public.ap_validate_bill_payment_allocations() from public, anon, authenticated;
revoke execute on function public.bridge_cash_adjustment_insert() from public, anon, authenticated;
revoke execute on function public.bridge_cash_adjustment_void() from public, anon, authenticated;
revoke execute on function public.bridge_cogs_send_out_trueup() from public, anon, authenticated;
revoke execute on function public.bridge_eod_close() from public, anon, authenticated;
revoke execute on function public.bridge_hmo_claim_resolution_insert() from public, anon, authenticated;
revoke execute on function public.bridge_hmo_claim_resolution_void() from public, anon, authenticated;
revoke execute on function public.bridge_payment_delete() from public, anon, authenticated;
revoke execute on function public.bridge_payment_insert() from public, anon, authenticated;
revoke execute on function public.bridge_payment_void() from public, anon, authenticated;
revoke execute on function public.bridge_payment_void_pf_cascade() from public, anon, authenticated;
revoke execute on function public.bridge_payroll_13th_month_payout() from public, anon, authenticated;
revoke execute on function public.bridge_payroll_payout_bank() from public, anon, authenticated;
revoke execute on function public.bridge_payroll_run_finalise() from public, anon, authenticated;
revoke execute on function public.bridge_payroll_run_void() from public, anon, authenticated;
revoke execute on function public.bridge_pf_at_hmo_allocation() from public, anon, authenticated;
revoke execute on function public.bridge_pf_at_hmo_writeoff() from public, anon, authenticated;
revoke execute on function public.bridge_pf_disbursement_post() from public, anon, authenticated;
revoke execute on function public.bridge_test_request_cancelled() from public, anon, authenticated;
revoke execute on function public.bridge_test_request_released() from public, anon, authenticated;
revoke execute on function public.enforce_consent_before_release() from public, anon, authenticated;
revoke execute on function public.fn_release_header_when_components_done() from public, anon, authenticated;
revoke execute on function public.fn_release_headers_on_visit_paid() from public, anon, authenticated;
revoke execute on function public.fn_undo_release_bridge() from public, anon, authenticated;
revoke execute on function public.maintain_repeat_patient_flag() from public, anon, authenticated;
revoke execute on function public.snapshot_service_price() from public, anon, authenticated;
revoke execute on function public.staff_advance_sync_insert() from public, anon, authenticated;
revoke execute on function public.staff_advance_sync_void() from public, anon, authenticated;
revoke execute on function public.sync_patient_consent_state() from public, anon, authenticated;
revoke execute on function public.tg_hmo_batch_status_rollup_from_item() from public, anon, authenticated;
revoke execute on function public.tg_hmo_batch_voided_propagate() from public, anon, authenticated;
revoke execute on function public.tg_hmo_item_paid_amount_recompute() from public, anon, authenticated;
revoke execute on function public.tg_hmo_item_resolution_amounts_recompute() from public, anon, authenticated;
revoke execute on function public.tg_payment_void_cascade_allocations() from public, anon, authenticated;

-- public.rls_auto_enable() is schema drift: it exists on the hosted project (event
-- trigger `ensure_rls`, which auto-enables RLS on newly created public tables) but
-- is defined in no migration in this repo, so it is absent from a fresh `db reset`.
-- Guard the revoke so this migration still replays cleanly on a clean database.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Bucket D — callable RPCs; service-role only from here on.
-- ---------------------------------------------------------------------------
revoke execute on function public.ap_create_bill_and_post(p_input jsonb, p_actor_id uuid, p_request_id uuid) from public, anon, authenticated;
revoke execute on function public.ap_create_bill_draft(p_input jsonb, p_actor_id uuid, p_request_id uuid) from public, anon, authenticated;
revoke execute on function public.ap_create_bill_paid_on_entry(p_input jsonb, p_actor_id uuid) from public, anon, authenticated;
revoke execute on function public.ap_create_bill_payment_with_allocations(p_input jsonb, p_actor_id uuid) from public, anon, authenticated;
revoke execute on function public.ap_next_bill_number() from public, anon, authenticated;
revoke execute on function public.ap_next_payment_number() from public, anon, authenticated;
revoke execute on function public.ap_post_recurring_template(p_template_id uuid) from public, anon, authenticated;
revoke execute on function public.ap_reallocate_bill_payment(p_payment_id uuid, p_allocations jsonb, p_actor_id uuid) from public, anon, authenticated;
revoke execute on function public.ap_reverse_je_for_source(p_source_kind text, p_source_id uuid, p_actor_id uuid) from public, anon, authenticated;
revoke execute on function public.ap_update_bill_draft(p_bill_id uuid, p_input jsonb, p_actor_id uuid) from public, anon, authenticated;
revoke execute on function public.ap_void_bill_payment_cascade(p_payment_id uuid, p_reason text, p_actor_id uuid) from public, anon, authenticated;
revoke execute on function public.ap_void_bill_with_guard(p_bill_id uuid, p_reason text, p_actor_id uuid) from public, anon, authenticated;
revoke execute on function public.apply_leave_entitlements(p_year integer) from public, anon, authenticated;
revoke execute on function public.apply_leave_expiry(p_year integer) from public, anon, authenticated;
revoke execute on function public.bridge_replay_summary(p_start timestamp with time zone, p_end timestamp with time zone) from public, anon, authenticated;
revoke execute on function public.cash_drawer_state(p_business_date date, p_shift_id uuid) from public, anon, authenticated;
revoke execute on function public.coa_uuid_for_code(p_code text) from public, anon, authenticated;
revoke execute on function public.je_next_number(p_fiscal_year integer) from public, anon, authenticated;
revoke execute on function public.next_pf_disbursement_batch_number(p_year smallint) from public, anon, authenticated;
revoke execute on function public.recompute_clinic_fee_for_unreleased() from public, anon, authenticated;
revoke execute on function public.recompute_hmo_batch_status(p_batch_id uuid) from public, anon, authenticated;
revoke execute on function public.recompute_hmo_item_paid_amount(p_item_id uuid) from public, anon, authenticated;
revoke execute on function public.recompute_hmo_item_resolution_amounts(p_item_id uuid) from public, anon, authenticated;
revoke execute on function public.resolve_ar_account(p_is_hmo boolean) from public, anon, authenticated;
revoke execute on function public.resolve_cash_account(p_method text) from public, anon, authenticated;
revoke execute on function public.resolve_cash_adjustment_account(p_kind text, p_contra_account_id uuid) from public, anon, authenticated;
revoke execute on function public.resolve_discount_account(p_service_kind text) from public, anon, authenticated;
revoke execute on function public.resolve_revenue_account(p_service_kind text) from public, anon, authenticated;
revoke execute on function public.reverse_petty_cash_entry(p_je_id uuid, p_reason text, p_actor uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Re-assert `service_role` explicitly on every callable RPC above.
--
-- REQUIRED, not cosmetic. On the hosted project these functions carry an explicit
-- service_role grant, but on a fresh `supabase db reset` most of them have a NULL
-- ACL — which in Postgres means "owner only, plus EXECUTE to PUBLIC by default".
-- There, service_role reaches them *through* PUBLIC, so the revokes above would
-- strip the admin client's access and break every accounting / payroll / HMO
-- write on local and in CI. Granting explicitly makes the end state identical in
-- every environment.
--
-- Bucket C (trigger functions) deliberately gets no grant: per FACT 1 nothing
-- checks EXECUTE when a trigger fires, so owner-only is correct and tightest.
-- ---------------------------------------------------------------------------
grant execute on function public.ap_create_bill_and_post(p_input jsonb, p_actor_id uuid, p_request_id uuid) to service_role;
grant execute on function public.ap_create_bill_draft(p_input jsonb, p_actor_id uuid, p_request_id uuid) to service_role;
grant execute on function public.ap_create_bill_paid_on_entry(p_input jsonb, p_actor_id uuid) to service_role;
grant execute on function public.ap_create_bill_payment_with_allocations(p_input jsonb, p_actor_id uuid) to service_role;
grant execute on function public.ap_next_bill_number() to service_role;
grant execute on function public.ap_next_payment_number() to service_role;
grant execute on function public.ap_post_recurring_template(p_template_id uuid) to service_role;
grant execute on function public.ap_reallocate_bill_payment(p_payment_id uuid, p_allocations jsonb, p_actor_id uuid) to service_role;
grant execute on function public.ap_reverse_je_for_source(p_source_kind text, p_source_id uuid, p_actor_id uuid) to service_role;
grant execute on function public.ap_update_bill_draft(p_bill_id uuid, p_input jsonb, p_actor_id uuid) to service_role;
grant execute on function public.ap_void_bill_payment_cascade(p_payment_id uuid, p_reason text, p_actor_id uuid) to service_role;
grant execute on function public.ap_void_bill_with_guard(p_bill_id uuid, p_reason text, p_actor_id uuid) to service_role;
grant execute on function public.apply_leave_entitlements(p_year integer) to service_role;
grant execute on function public.apply_leave_expiry(p_year integer) to service_role;
grant execute on function public.bridge_replay_summary(p_start timestamp with time zone, p_end timestamp with time zone) to service_role;
grant execute on function public.cash_drawer_state(p_business_date date, p_shift_id uuid) to service_role;
grant execute on function public.coa_uuid_for_code(p_code text) to service_role;
grant execute on function public.je_next_number(p_fiscal_year integer) to service_role;
grant execute on function public.next_pf_disbursement_batch_number(p_year smallint) to service_role;
grant execute on function public.recompute_clinic_fee_for_unreleased() to service_role;
grant execute on function public.recompute_hmo_batch_status(p_batch_id uuid) to service_role;
grant execute on function public.recompute_hmo_item_paid_amount(p_item_id uuid) to service_role;
grant execute on function public.recompute_hmo_item_resolution_amounts(p_item_id uuid) to service_role;
grant execute on function public.resolve_ar_account(p_is_hmo boolean) to service_role;
grant execute on function public.resolve_cash_account(p_method text) to service_role;
grant execute on function public.resolve_cash_adjustment_account(p_kind text, p_contra_account_id uuid) to service_role;
grant execute on function public.resolve_discount_account(p_service_kind text) to service_role;
grant execute on function public.resolve_revenue_account(p_service_kind text) to service_role;
grant execute on function public.reverse_petty_cash_entry(p_je_id uuid, p_reason text, p_actor uuid) to service_role;

-- Bucket B likewise — service_role calls employee_leave_balance via the admin
-- client, and reaches eod_lock_check through the payments / EOD trigger path.
grant execute on function public.employee_leave_balance(p_employee_id uuid, p_kind text, p_as_of_date date) to service_role;
grant execute on function public.eod_lock_check(p_business_date date, p_shift_id uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Self-verification. Fails the migration if the end state is wrong in either
-- direction — too much revoked (breaks the app) or too little (leaves a hole).
-- ---------------------------------------------------------------------------
do $$
declare
  v_leaked text;
begin
  -- (1) Nothing beyond the three caller-identity predicates may remain
  --     anon-executable.
  select string_agg(p.proname, ', ' order by p.proname) into v_leaked
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and has_function_privilege('anon', p.oid, 'EXECUTE')
    and p.proname not in ('has_role', 'is_staff', 'staff_role');
  if v_leaked is not null then
    raise exception
      '0118: SECURITY DEFINER function(s) still executable by anon: %', v_leaked;
  end if;

  -- (2) The keep-list predicates must survive — has_role() in particular, or
  --     every RLS policy that calls it starts raising instead of filtering.
  if not has_function_privilege('anon', 'public.has_role(text[])', 'EXECUTE')
     or not has_function_privilege('anon', 'public.is_staff()', 'EXECUTE')
     or not has_function_privilege('anon', 'public.staff_role()', 'EXECUTE') then
    raise exception
      '0118: a caller-identity predicate lost anon EXECUTE — RLS policies that call it will now raise';
  end if;

  -- (3) Bucket B must retain `authenticated` EXECUTE, or staff writes to
  --     payments / eod_cash_adjustments / employee_leave_records break (FACT 2).
  if not has_function_privilege('authenticated', 'public.eod_lock_check(date, uuid)', 'EXECUTE') then
    raise exception
      '0118: eod_lock_check lost authenticated EXECUTE — staff payment and EOD writes would fail';
  end if;
  if not has_function_privilege('authenticated', 'public.employee_leave_balance(uuid, text, date)', 'EXECUTE') then
    raise exception
      '0118: employee_leave_balance lost authenticated EXECUTE — staff leave-record writes would fail';
  end if;

  -- (3b) …and nothing BEYOND that keep-list may remain authenticated-executable.
  --      This mirrors check (1) for `authenticated`. Without it the safety net is
  --      asymmetric with this migration's own threat model, which rates the
  --      authenticated exposure as the worse of the two: a signed-in staff JWT is
  --      a real credential, and these functions take a caller-supplied actor. A
  --      future edit that drops `authenticated` from one `from` clause by mistake
  --      would otherwise pass both `db reset` and the prod apply undetected.
  select string_agg(p.proname, ', ' order by p.proname) into v_leaked
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and has_function_privilege('authenticated', p.oid, 'EXECUTE')
    and p.proname not in ('has_role', 'is_staff', 'staff_role',
                          'eod_lock_check', 'employee_leave_balance');
  if v_leaked is not null then
    raise exception
      '0118: SECURITY DEFINER function(s) still executable by authenticated: %', v_leaked;
  end if;

  -- (4) Every *callable* SECURITY DEFINER function must remain executable by
  --     service_role — that is the role the admin client runs as, so losing it
  --     would break the accounting, payroll and HMO write paths outright. Trigger
  --     and event-trigger functions are excluded: nothing checks EXECUTE when a
  --     trigger fires (FACT 1), so owner-only is correct for them.
  select string_agg(p.proname, ', ' order by p.proname) into v_leaked
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.prosecdef
    and pg_get_function_result(p.oid) not in ('trigger', 'event_trigger')
    and not has_function_privilege('service_role', p.oid, 'EXECUTE');
  if v_leaked is not null then
    raise exception
      '0118: service_role lost EXECUTE on callable SECURITY DEFINER function(s): % — the admin client would break', v_leaked;
  end if;
end $$;
