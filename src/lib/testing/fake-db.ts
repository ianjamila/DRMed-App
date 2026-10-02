// A small in-memory stand-in for the Supabase query builder, for behavioural
// tests of server code (see queue/actions.undo-behaviour.test.ts and
// audit/bulk-batch.test.ts). Test-only: nothing in the app imports it.
//
// It is deliberately just real enough that the code under test's OWN filters
// matter: an update only touches rows that satisfy every `.eq` / `.is` /
// `.in` / `.not` predicate, a select only returns the columns it asked for,
// and timestamps compare as INSTANTS (as Postgres does), so a "Z" and a
// "+00:00" spelling of one moment are equal. A predicate dropped from the code
// therefore changes the resulting rows, and a test that asserts them fails.
//
// Not modelled: RLS, joins beyond an embedded object already placed on the row
// (`row.visits = {...}`), types, unique constraints. Reads never fail unless a
// hook says so.

export type Row = Record<string, unknown>;
export type DbError = { code?: string; message?: string } | null;

export interface CallRecord {
  table: string;
  op: "select" | "update";
  select: string | null;
  patch: Row | null;
  filters: Array<[string, unknown[]]>;
  /** update only: ids of the rows the predicates matched (after any beforeWrite hook ran). */
  matchedIds: string[];
}

export interface RpcRecord {
  fn: string;
  args: Record<string, unknown>;
}

const ISO = /^\d{4}-\d{2}-\d{2}T/;

function pathGet(row: Row, col: string): unknown {
  // PostgREST JSON operator: metadata->>key
  const json = col.match(/^(\w+)->>(\w+)$/);
  if (json) {
    const obj = row[json[1]!] as Record<string, unknown> | null | undefined;
    const v = obj?.[json[2]!];
    return v === undefined || v === null ? null : String(v);
  }
  let cur: unknown = row;
  for (const part of col.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return null;
    cur = (cur as Row)[part];
  }
  return cur === undefined ? null : cur;
}

function eqLoose(a: unknown, b: unknown): boolean {
  if (typeof a === "string" && typeof b === "string" && ISO.test(a) && ISO.test(b)) {
    return Date.parse(a) === Date.parse(b);
  }
  return a === b;
}

function cmp(a: unknown, b: unknown): number {
  if (typeof a === "string" && typeof b === "string" && ISO.test(a) && ISO.test(b)) {
    return Date.parse(a) - Date.parse(b);
  }
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  return (a as string | number) < (b as string | number) ? -1 : 1;
}

/** Split a select list on top-level commas (embedded `x ( a, b )` stays whole). */
function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function project(row: Row, select: string): Row {
  if (select.trim() === "*") return structuredClone(row);
  const out: Row = {};
  for (const item of splitTop(select)) {
    const embed = item.match(/^(\w+)(?:!\w+)?\s*\(([\s\S]*)\)$/);
    if (embed) {
      const key = embed[1]!;
      const nested = row[key];
      out[key] =
        nested && typeof nested === "object" && !Array.isArray(nested)
          ? project(nested as Row, embed[2]!)
          : (nested ?? null);
    } else {
      out[item] = row[item] === undefined ? null : structuredClone(row[item]);
    }
  }
  return out;
}

type Pred = (row: Row) => boolean;

export interface FakeDbHooks {
  /** Runs BEFORE an update matches its rows — may mutate `db.tables` (a race) or return an error (write fails). */
  beforeWrite?: (call: Omit<CallRecord, "matchedIds">, db: FakeDb) => DbError | void;
  /** Runs before a select resolves; return an error to fail that read. */
  readError?: (call: Omit<CallRecord, "matchedIds">) => DbError | void;
  rpc?: (rec: RpcRecord, db: FakeDb) => { data?: unknown; error: DbError } | Promise<{ data?: unknown; error: DbError }>;
}

export class FakeDb {
  tables: Record<string, Row[]> = {};
  calls: CallRecord[] = [];
  rpcCalls: RpcRecord[] = [];
  hooks: FakeDbHooks = {};

  seed(table: string, rows: Row[]): this {
    this.tables[table] = [...(this.tables[table] ?? []), ...rows.map((r) => structuredClone(r))];
    return this;
  }

  rows(table: string): Row[] {
    return this.tables[table] ?? [];
  }

  row(table: string, id: string): Row {
    const r = this.rows(table).find((x) => x.id === id);
    if (!r) throw new Error(`fake-db: no ${table} row ${id}`);
    return r;
  }

  updates(table: string): CallRecord[] {
    return this.calls.filter((c) => c.table === table && c.op === "update");
  }

  selects(table: string): CallRecord[] {
    return this.calls.filter((c) => c.table === table && c.op === "select");
  }

  client() {
    return {
      from: (table: string) => new Builder(this, table),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        const rec = { fn, args };
        this.rpcCalls.push(rec);
        const out = this.hooks.rpc ? await this.hooks.rpc(rec, this) : { data: null, error: null };
        return { data: out.data ?? null, error: out.error };
      },
    };
  }
}

class Builder implements PromiseLike<unknown> {
  private op: "select" | "update" = "select";
  private selectCols: string | null = null;
  private returning = false;
  private head = false;
  private count = false;
  private patch: Row | null = null;
  private preds: Pred[] = [];
  private filters: Array<[string, unknown[]]> = [];
  private orders: Array<{ col: string; asc: boolean }> = [];
  private lim: number | null = null;
  private rng: [number, number] | null = null;
  private single: "maybe" | "one" | null = null;

  constructor(
    private db: FakeDb,
    private table: string,
  ) {}

  private f(name: string, args: unknown[], pred: Pred): this {
    this.filters.push([name, args]);
    this.preds.push(pred);
    return this;
  }

  select(cols = "*", opts?: { count?: string; head?: boolean }): this {
    if (this.op === "update") this.returning = true;
    this.selectCols = cols;
    this.head = !!opts?.head;
    this.count = !!opts?.count;
    return this;
  }

  update(patch: Row): this {
    this.op = "update";
    this.patch = patch;
    return this;
  }

  eq(col: string, val: unknown): this {
    return this.f("eq", [col, val], (r) => val !== null && eqLoose(pathGet(r, col), val));
  }
  neq(col: string, val: unknown): this {
    // SQL <>: a NULL column never matches.
    return this.f("neq", [col, val], (r) => {
      const v = pathGet(r, col);
      return v !== null && !eqLoose(v, val);
    });
  }
  is(col: string, val: unknown): this {
    return this.f("is", [col, val], (r) => pathGet(r, col) === val);
  }
  in(col: string, vals: readonly unknown[]): this {
    return this.f("in", [col, vals], (r) => vals.some((v) => eqLoose(pathGet(r, col), v)));
  }
  not(col: string, op: string, val: unknown): this {
    if (op === "is") return this.f("not", [col, op, val], (r) => pathGet(r, col) !== val);
    if (op === "in") {
      const list = String(val)
        .replace(/^\(|\)$/g, "")
        .split(",")
        .map((s) => s.trim());
      return this.f("not", [col, op, val], (r) => !list.includes(String(pathGet(r, col))));
    }
    throw new Error(`fake-db: not(${op}) unsupported`);
  }
  gte(col: string, val: unknown): this {
    return this.f("gte", [col, val], (r) => cmp(pathGet(r, col), val) >= 0);
  }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orders.push({ col, asc: opts?.ascending !== false });
    this.filters.push(["order", [col, opts]]);
    return this;
  }
  limit(n: number): this {
    this.lim = n;
    this.filters.push(["limit", [n]]);
    return this;
  }
  range(from: number, to: number): this {
    this.rng = [from, to];
    this.filters.push(["range", [from, to]]);
    return this;
  }
  maybeSingle(): this {
    this.single = "maybe";
    return this;
  }

  private run(): { data: unknown; error: DbError; count?: number | null } {
    const call = {
      table: this.table,
      op: this.op,
      select: this.selectCols,
      patch: this.patch,
      filters: this.filters,
    };
    const all = this.db.rows(this.table);
    if (this.op === "select") {
      const err = this.db.hooks.readError?.(call);
      this.db.calls.push({ ...call, matchedIds: [] });
      if (err) return { data: null, error: err };
      let rows = all.filter((r) => this.preds.every((p) => p(r)));
      const total = rows.length;
      if (this.orders.length > 0) {
        rows = [...rows].sort((a, b) => {
          for (const o of this.orders) {
            const c = cmp(pathGet(a, o.col), pathGet(b, o.col));
            if (c !== 0) return o.asc ? c : -c;
          }
          return 0;
        });
      }
      if (this.rng) rows = rows.slice(this.rng[0], this.rng[1] + 1);
      if (this.lim !== null) rows = rows.slice(0, this.lim);
      if (this.head) return { data: null, error: null, count: this.count ? total : null };
      const data = rows.map((r) => project(r, this.selectCols ?? "*"));
      if (this.single === "maybe") return { data: data[0] ?? null, error: null };
      return { data, error: null };
    }
    // update
    const err = this.db.hooks.beforeWrite?.(call, this.db);
    const matched = err ? [] : this.db.rows(this.table).filter((r) => this.preds.every((p) => p(r)));
    this.db.calls.push({ ...call, matchedIds: matched.map((r) => String(r.id)) });
    if (err) return { data: null, error: err };
    for (const r of matched) Object.assign(r, structuredClone(this.patch));
    if (!this.returning) return { data: null, error: null };
    const data = matched.map((r) => project(r, this.selectCols ?? "*"));
    if (this.single === "maybe") return { data: data[0] ?? null, error: null };
    return { data, error: null };
  }

  then<T1 = unknown, T2 = never>(
    onfulfilled?: ((value: unknown) => T1 | PromiseLike<T1>) | null,
    onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    return Promise.resolve()
      .then(() => this.run())
      .then(onfulfilled, onrejected);
  }
}
