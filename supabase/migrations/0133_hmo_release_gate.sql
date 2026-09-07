-- =============================================================================
-- 0133_hmo_release_gate.sql
-- =============================================================================
-- Let HMO-billed visits release results before the HMO settles.
--
-- Partner decision: an HMO patient must get their result at the counter like
-- everybody else. HMO money arrives months later through the AR subledger, and
-- releasing is precisely what books the receivable — the GL bridge routes an
-- HMO visit's release to 1110 AR HMO instead of cash (0109/0131). Waiting for
-- payment_status = 'paid' therefore inverts the process: it withholds the
-- result until after a settlement that only the release can trigger. The old
-- paper process released HMO results unpaid (5,621 legacy lines prove it); the
-- system was stricter than the clinic ever was.
--
-- Before: release is allowed only when the visit's payment_status is 'paid' or
-- 'waived'. An HMO visit sits at 'unpaid' indefinitely, so every HMO result is
-- blocked, and the admin-only "waive balance" escape hatch was the only way
-- out — which mislabels a collectible receivable as written off.
--
-- After: release is allowed when the visit is paid, waived, OR billed to an
-- HMO (visits.hmo_provider_id is not null). This is exactly the predicate the
-- lab-queue gate has used since the partner revisions (src/lib/visits/lab-gate.ts,
-- labQueueGate / LAB_QUEUE_GATE_VISITS_OR) — the two gates now agree on one
-- definition of "money is settled", which lab-gate.ts's doc comment already
-- claimed. Unpaid CASH visits stay blocked, unchanged.
--
-- Deliberately NOT changed:
--   * The reception queue's stage helper (src/lib/visits/queue-stage.ts) stays
--     payment-only. "Waiting" there means the counter still has money to
--     collect, and an HMO visit genuinely has nothing to collect — it belongs
--     in "processing", which is where a null balance already puts it.
--   * fn_release_headers_on_visit_paid() (0109) still fires only on a
--     payment_status transition, so an HMO visit's package headers are not
--     auto-released. Nothing regressed: they were never auto-released before
--     either, and a header can be released by hand now that the gate allows it.
--
-- The raised message keeps the substring "payment_status" — both
-- src/lib/accounting/pg-errors.ts and finalise-consolidated.ts match on
-- /payment_status/i to tell the payment gate apart from the consent gate.
-- Errcode stays 'check_violation' (23514) for the same reason.
--
-- Body below is 0001's text with only the visit lookup and the guard changed.
-- =============================================================================

create or replace function public.enforce_payment_before_release()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_payment_status  text;
  v_hmo_provider_id uuid;
begin
  if new.status = 'released' and (old.status is null or old.status <> 'released') then
    select payment_status, hmo_provider_id
      into v_payment_status, v_hmo_provider_id
    from public.visits
    where id = new.visit_id;

    if v_payment_status not in ('paid', 'waived') and v_hmo_provider_id is null then
      raise exception
        'cannot release test result: visit payment_status must be paid or waived, or the visit must be billed to an HMO (current: %)',
        v_payment_status
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Function ACL (0118/0119 rule).
--
-- create or replace preserves the existing ACL, so this changes nothing by
-- accident — it states the end state explicitly, which the skill's per-function
-- checklist asks for.
--
-- This function is absent from 0118 by design, not by oversight: that migration
-- swept SECURITY DEFINER functions, because those run as the owner and bypass
-- RLS. enforce_payment_before_release is SECURITY INVOKER, so it was never in
-- scope. On the hosted project it does still carry the EXECUTE that Supabase's
-- default privileges grant anon/authenticated at create time (0119 changed that
-- default only for functions created afterwards), but that grant is not
-- reachable: PostgREST excludes trigger-returning functions, so there is no
-- /rest/v1/rpc/ path to it. Revoking is defence in depth, not a hole being
-- closed.
--
-- Safe per 0118's FACT 1 and its bucket C (trigger functions): Postgres checks
-- EXECUTE at CREATE TRIGGER time, not at fire time, so the revoke cannot stop
-- trg_test_requests_payment_gate from firing.
--
-- set search_path = public is restated inline in the body above; it was
-- previously carried by 0002_function_search_path.sql, and create or replace
-- would otherwise have been relying on that setting surviving unmentioned.
-- ---------------------------------------------------------------------------
revoke execute on function public.enforce_payment_before_release() from public, anon, authenticated;
