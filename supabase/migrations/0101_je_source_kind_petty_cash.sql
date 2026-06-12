-- 0101_je_source_kind_petty_cash.sql
--
-- Reception "Petty cash" expense form (partner feedback, Open item #2 reading b).
--
-- Reception records small same-day cash expenses (transport, courier, office /
-- lab supplies, minor repairs). These post the SAME balanced, posted journal
-- entry the admin "Quick expense" form posts — DR <expense category> / CR 1010
-- Clinic Cash — but are tagged with their own source_kind so the reception
-- read-back list (and the bookkeeper) can tell petty-cash entries apart from
-- admin quick expenses and other manual JEs.
--
-- Like the other enum-extension migrations (0060/0061/0062/0074), this only
-- adds an enum value. `add value` cannot run inside a txn that then uses the
-- value, so this migration does nothing but extend the type; the app uses it
-- at runtime. Idempotent via `if not exists`.

alter type public.je_source_kind add value if not exists 'petty_cash';
