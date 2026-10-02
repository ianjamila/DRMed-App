import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sql = readFileSync(join(process.cwd(), "supabase/migrations/0183_waived_balance_gl.sql"), "utf8");
const fn = (name: string) => {
  const m = sql.match(new RegExp(`create or replace function public\\.${name}\\([\\s\\S]*?\\n\\$(?:function)?\\$;`));
  if (!m) throw new Error(`${name} not defined in 0183`);
  return m[0];
};

describe("migration 0183 — waived balance GL bridge", () => {
  it("asserts zero waived visits under a table lock before changing anything", () => {
    expect(sql).toMatch(/lock table public\.visits in share row exclusive mode;[\s\S]*?payment_status = 'waived'[\s\S]*?raise exception 'STOP 0183/);
    expect(sql.indexOf("STOP 0183")).toBeLessThan(sql.indexOf("add value if not exists 'visit_waiver'"));
  });

  it("adds the source kind, the visit columns and the allocation table", () => {
    expect(sql).toMatch(/alter type public\.je_source_kind add value if not exists 'visit_waiver'/);
    expect(sql).toMatch(/add column if not exists waived_php\s+numeric\(10,2\)/);
    expect(sql).toMatch(/create table if not exists public\.visit_waiver_allocations/);
    expect(sql).toMatch(/discount_account text not null check \(discount_account in \('4910', '4920'\)\)/);
    expect(sql).toMatch(/unique \(test_request_id\)/);
  });

  it("guards INSERT and UPDATE into 'waived', never out of it, and freezes the visit's money fields (P0069)", () => {
    const g = fn("guard_visit_waived_transition");
    expect(g).toMatch(/if tg_op = 'INSERT' then[\s\S]*?errcode = 'P0069'/);
    expect(g).toMatch(/current_setting\('app\.waive_visit', true\)/);
    expect(g).toMatch(/cannot be un-waived/);
    expect(g).toMatch(/new\.total_php\s+is distinct from old\.total_php/);
    // [CR-14] paid_php moves only inside the RPC or the equal-amount edit.
    expect(g).toMatch(/not v_inside and not v_edit\s+and new\.paid_php is distinct from old\.paid_php/);
    expect(g).toMatch(/current_setting\('app\.waived_visit_edit', true\)/);
    expect(sql).toMatch(/before insert or update of payment_status, total_php, paid_php, hmo_provider_id, legacy_import_run_id,\s*waived_php, waived_at, waived_by, waive_reason\s*on public\.visits/);
  });

  it("the payment guard covers insert, void, money-bearing update, provenance and hard delete, both visits, visit lock first", () => {
    const g = fn("guard_payment_on_waived_visit");
    expect(g).toMatch(/new\.amount_php\s+is distinct from old\.amount_php/);
    expect(g).toMatch(/new\.legacy_import_run_id is distinct from old\.legacy_import_run_id/);
    expect(g).toMatch(/unnest\(array\[old\.visit_id, new\.visit_id\]\)/);
    expect(g).toMatch(/tg_op = 'DELETE'/);
    expect(g).toMatch(/from public\.visits where id = v_id for update/);
    expect(g).toMatch(/current_setting\('app\.waived_visit_edit', true\)/);
    expect(g).toMatch(/errcode = 'P0070'/);
    expect(sql).toMatch(/before insert or update or delete on public\.payments/);
  });

  it("the line guard freezes inserts, restores, reactivations, provenance, reprices, reparents and moves on a waived visit", () => {
    const g = fn("guard_test_request_on_waived_visit");
    expect(g).toMatch(/old\.deleted_at is not null and new\.deleted_at is null/);
    expect(g).toMatch(/old\.status = 'cancelled' and new\.status is distinct from 'cancelled'/); // [CR-13]
    expect(g).toMatch(/new\.legacy_import_run_id is distinct from old\.legacy_import_run_id/); // [CR-12]
    expect(g).toMatch(/new\.final_price_php\s+is distinct from old\.final_price_php/);
    expect(g).toMatch(/errcode = 'P0070'/);
    expect(sql).toMatch(/before insert or update of deleted_at, status, legacy_import_run_id, final_price_php, base_price_php,\s*discount_amount_php, clinic_fee_php, doctor_pf_php, parent_id, service_id,\s*visit_id, is_package_header\s*on public\.test_requests/);
  });

  it("waive_visit_balance: visit lock then line locks, admin only, provenance, exact reconciliation, gift codes in flight", () => {
    const w = fn("waive_visit_balance");
    expect(w).toMatch(/select \* into v_visit from public\.visits where id = p_visit_id for update;/);
    expect(w).toMatch(/for update;[\s\S]*?perform 1 from public\.test_requests where visit_id = p_visit_id and deleted_at is null order by id for update;/);
    expect(w).not.toMatch(/from public\.payments[\s\S]*?for update/);
    expect(w).toMatch(/v_role is distinct from 'admin'/);
    expect(w).toMatch(/mixes imported and live rows/);
    expect(w).toMatch(/if v_total_c <> v_sum_c then/);
    expect(w).toMatch(/has no journal entry; reconcile/);
    expect(w).toMatch(/redeemed_payment_id = p\.id/);
    expect(w).toMatch(/order by frac desc, test_request_id limit v_left/);
    expect(w).toMatch(/parent_id is null and coalesce\(tr\.final_price_php, 0\) > 0/);
    expect(w).toMatch(/when s\.kind in \('doctor_consultation', 'doctor_procedure'\) then '4920' else '4910'/);
    expect(w).toMatch(/where t\.status = 'released'[\s\S]*?perform public\.waiver_post_allocation\(r\.id, p_actor_id\)/);
    expect(w).toMatch(/set_config\('app\.waive_visit', 'on', true\)/);
    expect(w).toMatch(/paid_php\s+= v_paid_c \/ 100\.0/); // [CR-14]
    expect(w).toMatch(/'headers_pending'/);
    expect(w).toMatch(/errcode = 'P0071'/);
  });

  it("0220 re-creates waive_visit_balance as 0183's body plus ONLY the patient-lock prologue and re-check", () => {
    // The tests above read 0183's text; 0220 is the live definition. Strip 0220's three marked
    // additions and the rest must be 0183's body byte for byte, so a later edit cannot hide here.
    const live = readFileSync(join(process.cwd(), "supabase/migrations/0220_waive_visit_balance_lock_order.sql"), "utf8");
    const w220 = live.match(/create or replace function public\.waive_visit_balance\([\s\S]*?\n\$\$;/)?.[0];
    expect(w220, "0220 should define waive_visit_balance").toBeTruthy();
    const decl = "  v_patient      uuid;  -- 0220\n";
    const prologue = /  -- 0220: the patient lifecycle lock \(shared, 0184\) BEFORE any row lock[\s\S]*?perform public\.lifecycle_lock_and_assert\(array\[v_patient\], false\);\n\n/;
    const recheck = /  -- 0220: re-read under the patient lock[\s\S]*?using errcode = 'P0072';\n  end if;\n/;
    expect(w220).toContain(decl);
    expect(w220).toMatch(prologue);
    expect(w220).toMatch(recheck);
    // the prologue comes before the visit lock, the re-check right after it
    const at = (re: RegExp | string) => (typeof re === "string" ? w220!.indexOf(re) : w220!.search(re));
    expect(at(prologue)).toBeLessThan(at("select * into v_visit from public.visits where id = p_visit_id for update;"));
    expect(at(recheck)).toBeGreaterThan(at("select * into v_visit from public.visits where id = p_visit_id for update;"));
    expect(w220!.replace(decl, "").replace(prologue, "").replace(recheck, "")).toBe(fn("waive_visit_balance"));
  });

  it("standalone JE: DR discount account / CR 1100, Manila date, idempotent", () => {
    const p = fn("waiver_post_allocation");
    expect(p).toMatch(/coa_uuid_for_code\(a\.discount_account\), a\.amount_php, 0/);
    expect(p).toMatch(/coa_uuid_for_code\('1100'\),\s+0, a\.amount_php/);
    expect(p).toMatch(/\(now\(\) at time zone 'Asia\/Manila'\)::date/);
    expect(p).toMatch(/source_kind = 'visit_waiver'[\s\S]*?status = 'posted'/);
  });

  it("the release bridge folds an unrecognised share and records it", () => {
    const b = fn("bridge_test_request_released");
    expect(b).toMatch(/where test_request_id = new\.id and recognised_at is null/);
    expect(b).toMatch(/new\.final_price_php - v_waived, 0, v_line_order, 'Release receivable'/);
    expect(b).toMatch(/coa_uuid_for_code\(v_waived_account\), v_waived, 0, v_line_order, 'Balance waived'/);
    expect(b).toMatch(/set recognised_at = now\(\), journal_entry_id = v_je_id/);
    expect(b).toMatch(/if NEW\.legacy_import_run_id is not null then\s+return NEW;/);
  });

  it("undo-release and cancel use the 0166 (cogs-free) bodies and take the share back out", () => {
    const u = fn("fn_undo_release_bridge");
    const c = fn("bridge_test_request_cancelled");
    expect(u).toMatch(/waiver_unrecognise_line\(new\.id, v_actor, 'release undone'\)/);
    expect(c).toMatch(/waiver_unrecognise_line\(new\.id, v_actor, 'test request cancelled'\)/);
    expect(u).not.toMatch(/cogs_send_out_entries/);
    expect(c).not.toMatch(/cogs_send_out_entries/);
    const r = fn("waiver_unrecognise_line");
    expect(r).toMatch(/set status = 'reversed', reversed_by = v_rev/);
    expect(r).toMatch(/set recognised_at = null, journal_entry_id = null/);
  });

  it("correct_payment: equal-amount edit only on a waived visit, no move on or off, flag scoped to the replacement", () => {
    const c = fn("correct_payment");
    expect(c).toMatch(/where id in \(v_old\.visit_id, coalesce\(v_target, v_old\.visit_id\)\)\s+order by id for update/);
    expect(c).toMatch(/cannot be moved\.' using errcode = 'P0070'/);
    expect(c).toMatch(/moved onto it\.' using errcode = 'P0070'/);
    expect(c).toMatch(/amount is fixed[\s\S]*?errcode = 'P0070'/);
    expect(c).toMatch(/set_config\('app\.waived_visit_edit', 'on', true\);\s*end if;\s*insert into public\.payments/);
    expect(c).toMatch(/where id = p_payment_id;\s*perform set_config\('app\.waived_visit_edit', 'off', true\);/);
  });

  it("restates every ACL by name (0118/0119)", () => {
    for (const f of [
      "guard_visit_waived_transition\\(\\)",
      "guard_payment_on_waived_visit\\(\\)",
      "guard_test_request_on_waived_visit\\(\\)",
      "waiver_post_allocation\\(uuid, uuid\\)",
      "waiver_unrecognise_line\\(uuid, uuid, text\\)",
      "waive_visit_balance\\(uuid, uuid, text\\)",
      "bridge_test_request_released\\(\\)",
      "fn_undo_release_bridge\\(\\)",
      "bridge_test_request_cancelled\\(\\)",
    ]) {
      expect(sql).toMatch(new RegExp(`revoke execute on function public\\.${f}\\s+from public, anon, authenticated;`));
      expect(sql).toMatch(new RegExp(`grant\\s+execute on function public\\.${f}\\s+to service_role;`));
    }
    expect(sql).toMatch(/revoke all on public\.visit_waiver_allocations from authenticated;/);
    expect(sql).toMatch(/grant select on public\.visit_waiver_allocations to authenticated;/);
  });
});
