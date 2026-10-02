import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { scanLiveFunctions } from "@/lib/db/migration-lock-scan";

vi.mock("server-only", () => ({}));

const { translatePgError } = await import("./pg-errors");

// 0224 pins. The behaviour is proven against a real database by
// scripts/gl-bridge-concurrency-proof.ts; this guards the migration TEXT that proof relies on
// (the order of the locks, the one-column link, the verbatim bodies, the ACLs) and the staff
// wording of the two new codes.

const sql = readFileSync(join(process.cwd(), "supabase/migrations/0224_pf_payout_atomic.sql"), "utf8");
const MIGRATIONS = join(process.cwd(), "supabase/migrations");
const migrations = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort()
  .map((file) => ({ file, sql: readFileSync(join(MIGRATIONS, file), "utf8") }));
// The definition each 0224 function replaced: the LATEST migration before 0224 that defines it, computed so a future
// redefinition between two migrations can never leave the "verbatim" check comparing against a stale body.
const before0224 = scanLiveFunctions(migrations.filter((m) => m.file < "0224"));
const previousBody = (name: string): string => {
  const prev = before0224.find((fn) => fn.name === name);
  if (!prev) throw new Error(`${name} had no definition before 0224`);
  return fnBody(migrations.find((m) => m.file === prev.file)!.sql, name);
};
/** Remove every block 0224 added to a function: a comment starting `-- 0224:` through the `end loop;` / `for update;` that closes it. */
const withoutHunks = (body: string): string =>
  body
    .replace(/  v_pf {11}record; {2}-- 0224\n/, "")
    .replace(/\n *-- 0224:[\s\S]*?(?:end loop;|for update;)\n/g, "");

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
      const was = previousBody(name);

      it("is the previous definition's body VERBATIM except the marked -- 0224 blocks", () => {
        const stripped = withoutHunks(body);
        expect(stripped).not.toContain("0224");
        expect(stripped.replace(/\n{2,}/g, "\n")).toBe(was.replace(/\n{2,}/g, "\n"));
      });

      it("locks the line's live RECOGNISED entries by id and refuses P0084 BEFORE any other write", () => {
        const lock = body.search(/where e\.test_request_id = new\.id\s+and e\.voided_at is null\s+and e\.recognized_at is not null[^\n]*\s+order by e\.id\s+for update/);
        const refuse = body.indexOf("errcode = 'P0084'");
        const firstWrite = body.search(/waiver_unrecognise_line|insert into public\.journal_entries|update public\./);
        expect(lock).toBeGreaterThan(-1);
        expect(refuse).toBeGreaterThan(lock);
        expect(firstWrite).toBeGreaterThan(refuse);
        expect(body).toContain("This doctor''s fee was already paid out — void the payout first.");
      });

      it("re-checks ALL live entries (pending ones included) under the lock right before every void UPDATE", () => {
        const updates = [...body.matchAll(/update public\.doctor_pf_entries\s+set voided_at/g)].map((m) => m.index!);
        expect(updates.length).toBe(name === "bridge_test_request_cancelled" ? 2 : 1);
        for (const at of updates) {
          const before = body.slice(0, at);
          const recheck = before.lastIndexOf("-- 0224: re-check under the lock");
          expect(recheck, "a re-check block precedes the void UPDATE").toBeGreaterThan(-1);
          const block = before.slice(recheck);
          expect(block).toMatch(/where e\.test_request_id = new\.id\s+and e\.voided_at is null\s+order by e\.id\s+for update/);
          expect(block).not.toMatch(/recognized_at/);
          expect(block).toContain("errcode = 'P0084'");
        }
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
  const body = fnBody(sql, "undo_visit_release");
  const was = previousBody("undo_visit_release");

  it("is the previous definition's body VERBATIM except the marked -- 0224 hunk", () => {
    const stripped = withoutHunks(body);
    expect(stripped).not.toContain("0224");
    expect(stripped).toBe(was);
  });

  it("locks RECOGNISED entries only: a pending HMO entry is updated by the HMO bridges after the JE counter, so locking it first would close a 40P01 (K1g)", () => {
    const lock = body.slice(body.indexOf("perform 1\n"), body.indexOf("for update;", body.indexOf("perform 1\n")));
    expect(lock).toMatch(/and e\.recognized_at is not null/);
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
