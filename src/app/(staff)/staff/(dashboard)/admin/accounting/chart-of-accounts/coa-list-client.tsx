"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { toggleAccountActiveAction } from "./actions";

interface CoaRow {
  id: string;
  code: string;
  name: string;
  type: string;
  typeLabel: string;
  typeOrder: number;
  parent_id: string | null;
  normal_balance: string;
  is_active: boolean;
  description: string | null;
}

type Filter = "all" | "active" | "inactive";

export function CoaListClient({ rows }: { rows: CoaRow[] }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === "active" && !r.is_active) return false;
      if (filter === "inactive" && r.is_active) return false;
      if (q && !r.code.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [rows, filter, query]);

  const grouped = useMemo(() => {
    const buckets = new Map<string, { typeOrder: number; label: string; rows: CoaRow[] }>();
    for (const r of filtered) {
      const key = r.type;
      if (!buckets.has(key)) {
        buckets.set(key, { typeOrder: r.typeOrder, label: r.typeLabel, rows: [] });
      }
      buckets.get(key)!.rows.push(r);
    }
    return Array.from(buckets.values()).sort((a, b) => a.typeOrder - b.typeOrder);
  }, [filtered]);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          {(["all", "active", "inactive"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`min-h-[44px] rounded-full px-3 text-xs font-bold uppercase tracking-wider ${
                filter === f
                  ? "bg-[color:var(--color-brand-navy)] text-white"
                  : "bg-[color:var(--color-brand-bg)] text-[color:var(--color-brand-text-soft)]"
              }`}
            >
              {f}
            </button>
          ))}
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search code or name…"
          className="min-h-[44px] flex-1 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 text-sm"
        />
      </div>

      {grouped.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-12 text-center text-sm text-[color:var(--color-brand-text-soft)]">
          No accounts match.
        </p>
      ) : (
        grouped.map((group) => (
          <section key={group.label} className="mb-6">
            <h2 className="mb-2 font-[family-name:var(--font-heading)] text-sm font-extrabold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              {group.label} ({group.rows.length})
            </h2>
            <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                  <tr>
                    <th className="px-3 py-2">Code</th>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">Normal</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((r) => (
                    <Row key={r.id} row={r} />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))
      )}
    </>
  );
}

function Row({ row }: { row: CoaRow }) {
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);

  function onToggle() {
    startTransition(async () => {
      setErr(null);
      const result = await toggleAccountActiveAction(row.id);
      if (!result.ok) setErr(result.error);
    });
  }

  return (
    <tr className={`border-t border-[color:var(--color-brand-bg-mid)] ${!row.is_active ? "opacity-60" : ""}`}>
      <td className="px-3 py-2 font-mono text-xs">{row.code}</td>
      <td className="px-3 py-2">
        <div className="font-medium text-[color:var(--color-brand-navy)]">{row.name}</div>
        {row.description ? (
          <div className="text-xs text-[color:var(--color-brand-text-soft)]">{row.description}</div>
        ) : null}
        {err ? <div className="mt-1 text-xs text-red-600">{err}</div> : null}
      </td>
      <td className="px-3 py-2">
        <span
          className={`rounded px-2 py-0.5 text-xs font-bold uppercase ${
            row.normal_balance === "debit" ? "bg-blue-100 text-blue-800" : "bg-amber-100 text-amber-800"
          }`}
        >
          {row.normal_balance}
        </span>
      </td>
      <td className="px-3 py-2 text-xs">
        {row.is_active ? "Active" : "Inactive"}
      </td>
      <td className="px-3 py-2 text-right">
        <Link
          href={`/staff/admin/accounting/chart-of-accounts/${row.id}/edit`}
          className="mr-2 inline-flex min-h-[44px] items-center rounded px-2 text-xs font-semibold text-[color:var(--color-brand-cyan)] hover:underline"
        >
          Edit
        </Link>
        <button
          type="button"
          onClick={onToggle}
          disabled={pending}
          className="inline-flex min-h-[44px] items-center rounded px-2 text-xs font-semibold text-[color:var(--color-brand-text-soft)] hover:underline disabled:opacity-50"
        >
          {pending ? "…" : row.is_active ? "Deactivate" : "Activate"}
        </button>
      </td>
    </tr>
  );
}
