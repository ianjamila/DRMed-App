-- 0113: lock 0112's booking RPCs to service_role only (security fix).
--
-- 0112 created appointments_insert_slot_guarded + resolve_patient_guarded as
-- service_role-only via `revoke all ... from public; grant ... to service_role`.
-- That is sufficient on the local stack, but on the hosted Supabase project the
-- default privileges auto-grant EXECUTE on new functions to `anon` and
-- `authenticated` directly (not via PUBLIC), so `revoke ... from public` leaves
-- those explicit grants in place — anon could call the SECURITY DEFINER insert
-- and bypass the RLS we just tightened (H6a). Revoke them explicitly. Revoking
-- a grant that isn't present (e.g. on local) is a harmless no-op.

revoke execute on function public.appointments_insert_slot_guarded(jsonb, uuid, timestamptz, boolean) from anon, authenticated;
revoke execute on function public.resolve_patient_guarded(text, text, date, jsonb) from anon, authenticated;
