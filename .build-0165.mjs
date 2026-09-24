import fs from "node:fs";

const SP = "/private/tmp/claude-501/-Users-jamila/2334d654-3ebf-445c-a347-733e1a6d61b2/scratchpad";
let cancel = fs.readFileSync(`${SP}/cancel.sql`, "utf8");
let undo = fs.readFileSync(`${SP}/undo.sql`, "utf8");

function drop(src, block, label) {
  const n = src.split(block).length - 1;
  if (n < 1) throw new Error(`${label}: block not found`);
  return src.split(block).join("");
}

// bridge_test_request_cancelled: two identical void blocks (one with a comment).
cancel = drop(
  cancel,
  `  -- Void any open cogs_send_out_entries for this test_request.
  update public.cogs_send_out_entries
    set voided_at   = now(),
        voided_by   = v_actor,
        void_reason = 'test_request_cancelled'
    where test_request_id = new.id
      and voided_at is null;

`,
  "cancel commented block",
);
cancel = drop(
  cancel,
  `    update public.cogs_send_out_entries
      set voided_at   = now(),
          voided_by   = v_actor,
          void_reason = 'test_request_cancelled'
      where test_request_id = new.id
        and voided_at is null;

`,
  "cancel indented block",
);
undo = drop(
  undo,
  `  update public.cogs_send_out_entries
     set voided_at = now(), voided_by = v_actor, void_reason = 'release_undone'
   where test_request_id = new.id and voided_at is null;

`,
  "undo block",
);
for (const [n, s] of [["cancel", cancel], ["undo", undo]]) {
  if (s.includes("cogs_send_out")) throw new Error(`${n} still references cogs_send_out`);
}

const sql = `-- 0165_drop_send_out_accrual_tables
--
-- Tidy-up after 0159 (release stopped accruing send-out cost) and 0164 (Send
-- Out expenses carry their partner lab). Owner decision 2026-09-24: send-out
-- cost is the "Send Out" expense, full stop — the accrual subledger is not
-- coming back. On prod at the time: cogs_send_out_entries = 1 row (₱0, no
-- journal entry, from a May 2026 test release), cogs_send_out_trueups = 0 rows,
-- 0 journal lines on 2150 "Accrued send-out". Nothing of value is lost.
--
-- Order matters: the two bridges below still UPDATE cogs_send_out_entries when
-- a test is cancelled or a release is undone, so they are re-created WITHOUT
-- that statement first (bodies otherwise identical to 0141 / 0140, prosrc md5
-- 4852c888… / bd572a52… verified against prod), then the true-up trigger and
-- the tables go, then the per-service unit cost column.
--
-- Deliberately kept:
--   * je_source_kind values 'cogs_send_out_accrual' / 'cogs_send_out_trueup' —
--     removing an enum value means recreating the type under journal_entries;
--     unused values are harmless.
--   * services.send_out_vendor_id — now the service's partner lab (0164).
--   * audit_log rows mentioning send-out cost — history.
--
-- DEPLOY ORDER: push this right before PR #211 merges. The app still on main
-- reads services.send_out_unit_cost_php (service edit form) and the two
-- tables (Outside-Lab pages), so they break between push and merge.

${cancel.trimEnd()}

revoke execute on function public.bridge_test_request_cancelled() from public, anon, authenticated;
grant  execute on function public.bridge_test_request_cancelled() to service_role;

${undo.trimEnd()}

revoke execute on function public.fn_undo_release_bridge() from public, anon, authenticated;
grant  execute on function public.fn_undo_release_bridge() to service_role;

drop trigger if exists trg_bridge_cogs_send_out_trueup on public.cogs_send_out_trueups;
drop function if exists public.bridge_cogs_send_out_trueup();

-- cogs_send_out_entries.trueup_id references cogs_send_out_trueups.
drop table if exists public.cogs_send_out_entries;
drop table if exists public.cogs_send_out_trueups;

alter table public.services drop column if exists send_out_unit_cost_php;

-- 2150 "Accrued send-out" only ever existed for the accrual. Retire it (not
-- delete — chart rows are referenced by history) when nothing uses it.
update public.chart_of_accounts coa
   set is_active = false
 where coa.code = '2150'
   and coa.is_active
   and not exists (select 1 from public.journal_lines              x where x.account_id = coa.id)
   and not exists (select 1 from public.bill_lines                 x where x.account_id = coa.id)
   and not exists (select 1 from public.payment_method_account_map x where x.account_id = coa.id)
   and not exists (select 1 from public.cash_adjustment_account_map x where x.account_id = coa.id)
   and not exists (select 1 from public.vendors                    x where x.default_account_id = coa.id);

-- Post-conditions.
do $$
begin
  if exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and (p.prosrc ilike '%cogs_send_out_entries%' or p.prosrc ilike '%cogs_send_out_trueups%'
            or p.prosrc ilike '%send_out_unit_cost%')
  ) then
    raise exception '0165: a public function still references the dropped send-out objects';
  end if;
  if to_regclass('public.cogs_send_out_entries') is not null
     or to_regclass('public.cogs_send_out_trueups') is not null then
    raise exception '0165: send-out accrual tables still exist';
  end if;
end;
$$;
`;
fs.writeFileSync("supabase/migrations/0165_drop_send_out_accrual_tables.sql", sql);
console.log("written", sql.split("\n").length, "lines");
