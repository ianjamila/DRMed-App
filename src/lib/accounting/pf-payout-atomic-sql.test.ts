import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { translatePgError } = await import("./pg-errors");

// 0224 pins. The behaviour is proven against a real database by
// scripts/gl-bridge-concurrency-proof.ts; this guards the migration TEXT that proof relies on
// (the order of the locks, the one-column link, the verbatim bodies, the ACLs) and the staff
// wording of the two new codes.

const sql = readFileSync(join(process.cwd(), "supabase/migrations/0224_pf_payout_atomic.sql"), "utf8");
const old = readFileSync(join(process.cwd(), "supabase/migrations/0183_waived_balance_gl.sql"), "utf8");

const fnBody = (src: string, name: string): string => {
  const start = src.indexOf(`create or replace function public.${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const open = /\bas\s+(\$[a-z_]*\$)/i.exec(src.slice(start))!;
  const bodyStart = start + open.index + open[0].length;
  return src.slice(bodyStart, src.indexOf(open[1]!, bodyStart));
};

describe("0224 pf_disburse_entries", () => {
  const fn = fnBody(sql, "pf_disburse_entries");

  it("locks the entries in id order, judges them after the lock, then total, batch number, header, link", () => {
    const lock = fn.search(/order by e\.id\s+for update/);
    const judged = fn.indexOf("v_e.disbursement_id is not null or v_e.voided_at is not null or v_e.recognized_at is null");
    const total = fn.indexOf("abs(v_total - p_total_php) > 0.005");
    const batch = fn.indexOf("public.next_pf_disbursement_batch_number(");
    const header = fn.indexOf("insert into public.doctor_pf_disbursements");
    const link = fn.indexOf("update public.doctor_pf_entries");
    for (const [a, b] of [[lock, judged], [judged, total], [total, batch], [batch, header], [header, link]] as const) {
      expect(a).toBeGreaterThan(-1);
      expect(b).toBeGreaterThan(a);
    }
  });

  it("the link updates ONLY disbursement_id (the lifecycle guard exempts exactly that) and re-asserts the filters and the count", () => {
    const link = fn.slice(fn.indexOf("update public.doctor_pf_entries"), fn.indexOf("get diagnostics"));
    expect(link.match(/\bset\b/g)).toHaveLength(1);
    expect(link).toMatch(/set disbursement_id = v_disb\s+where id = any \(p_entry_ids\)/);
    expect(link).toMatch(/and voided_at is null\s+and disbursement_id is null\s+and recognized_at is not null/);
    expect(fn).toMatch(/v_linked <> cardinality\(p_entry_ids\)/);
  });

  it("every refusal is P0085 with the text the app used to return", () => {
    expect(fn.match(/raise exception/g)).toHaveLength(5);
    expect(fn.match(/errcode = 'P0085'/g)).toHaveLength(5);
    for (const text of [
      "One or more PF entries not found",
      "PF entries must all belong to the same physician",
      "One or more PF entries are not open for disbursement",
      "Total mismatch: expected %, got %",
    ]) {
      expect(fn).toContain(text);
    }
  });

  it("is SECURITY DEFINER with a pinned search_path and EXECUTE for service_role only", () => {
    expect(sql).toMatch(/create or replace function public\.pf_disburse_entries\([\s\S]*?\)\s+returns jsonb\s+language plpgsql\s+security definer\s+set search_path = pg_catalog, public, pg_temp/);
    const sig = "public.pf_disburse_entries(uuid, uuid[], date, text, numeric, uuid, text)";
    expect(sql).toContain(`revoke all     on function ${sig} from public;`);
    expect(sql).toContain(`revoke execute on function ${sig} from anon, authenticated;`);
    expect(sql).toContain(`grant  execute on function ${sig} to service_role;`);
  });
});

describe("0224 cancel / undo bridges refuse a disbursed entry", () => {
  for (const name of ["bridge_test_request_cancelled", "fn_undo_release_bridge"]) {
    describe(name, () => {
      const body = fnBody(sql, name);
      const was = fnBody(old, name);

      it("is 0183's body VERBATIM except the marked -- 0224 lines", () => {
        const stripped = body
          .replace(/  v_pf {11}record; {2}-- 0224\n/, "")
          .replace(/\n  -- 0224: a line whose[\s\S]*?  end loop;\n(?:\n)?/, "\n");
        expect(stripped).not.toContain("0224");
        expect(stripped.replace(/\n{2,}/g, "\n")).toBe(was.replace(/\n{2,}/g, "\n"));
      });

      it("locks the line's live entries by id and refuses P0084 BEFORE any other write", () => {
        const lock = body.search(/where e\.test_request_id = new\.id\s+and e\.voided_at is null\s+order by e\.id\s+for update/);
        const refuse = body.indexOf("errcode = 'P0084'");
        const firstWrite = body.search(/waiver_unrecognise_line|insert into public\.journal_entries|update public\./);
        expect(lock).toBeGreaterThan(-1);
        expect(refuse).toBeGreaterThan(lock);
        expect(firstWrite).toBeGreaterThan(refuse);
        expect(body).toContain("This doctor''s fee was already paid out — void the payout first.");
      });
    });
  }

  it("keeps the trigger functions closed to every signed-in role (EXECUTE service_role only, as 0183 left them)", () => {
    for (const name of ["fn_undo_release_bridge", "bridge_test_request_cancelled"]) {
      expect(sql).toContain(`revoke execute on function public.${name}() from public, anon, authenticated;`);
      expect(sql).toContain(`grant  execute on function public.${name}() to service_role;`);
    }
  });
});

describe("0224 undo_visit_release pre-locks every candidate line's PF entries", () => {
  const prev = readFileSync(join(process.cwd(), "supabase/migrations/0214_release_notice_enqueue.sql"), "utf8");
  const body = fnBody(sql, "undo_visit_release");
  const was = fnBody(prev, "undo_visit_release");

  it("is 0214's body VERBATIM except the marked -- 0224 hunk", () => {
    const stripped = body.replace(/  -- 0224: pre-lock the doctor PF entries[\s\S]*?      for update;\n\n/, "");
    expect(stripped).not.toContain("0224");
    expect(stripped).toBe(was);
  });

  it("locks the entries by id AFTER the candidate lines are known and BEFORE the line UPDATE", () => {
    const cands = body.indexOf("v_cands := array(");
    const lock = body.search(/perform 1\s+from public\.doctor_pf_entries e[\s\S]*?order by e\.id\s+for update;/);
    const upd = body.indexOf("update public.test_requests t");
    expect(cands).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(cands);
    expect(upd).toBeGreaterThan(lock);
    expect(body).toMatch(/t\.parent_id from public\.test_requests t/);
  });

  it("keeps EXECUTE for authenticated + service_role only (0198 / 0205 / 0214)", () => {
    const sig = "public.undo_visit_release(uuid, uuid[], uuid, jsonb, text, jsonb)";
    expect(sql).toContain(`revoke all on function ${sig} from public, anon, authenticated, service_role;`);
    expect(sql).toContain(`grant execute on function ${sig} to authenticated, service_role;`);
  });
});

describe("staff wording of the new codes", () => {
  it("P0084 is always the paid-out message", () => {
    const msg = "This doctor's fee was already paid out — void the payout first.";
    expect(translatePgError({ code: "P0084", message: "anything" })).toBe(msg);
    expect(translatePgError({ code: "P0084" })).toBe(msg);
  });

  it("P0085 passes the hand-written refusal through, with a fallback", () => {
    expect(translatePgError({ code: "P0085", message: "Total mismatch: expected 600, got 500" })).toBe(
      "Total mismatch: expected 600, got 500",
    );
    expect(translatePgError({ code: "P0085" })).toMatch(/refresh the list and try again/);
  });
});
