"use client";

import {
  Fragment,
  useDeferredValue,
  useMemo,
  useState,
  useTransition,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatPhp } from "@/lib/marketing/format";
import { updateServicePricesAction } from "./actions";
import { ServiceHistoryPanel } from "./service-history-panel";

export interface PriceRow {
  id: string;
  code: string;
  name: string;
  kind: string;
  section: string | null;
  description: string | null;
  price_php: number;
  hmo_price_php: number | null;
  senior_discount_php: number | null;
  is_active: boolean;
  is_send_out: boolean;
  last_changed_at: string | null;
  last_changed_by: string | null;
}

const SECTION_LABEL: Record<string, string> = {
  package: "Packages",
  chemistry: "Chemistry",
  hematology: "Hematology",
  immunology: "Immunology",
  urinalysis: "Urinalysis",
  microbiology: "Microbiology",
  imaging_xray: "X-Ray",
  imaging_ultrasound: "Ultrasound",
  vaccine: "Vaccines",
  send_out: "Send-out",
  consultation: "Consultations",
  procedure: "Procedures",
  home_service: "Home service",
};

const KIND_LABEL: Record<string, string> = {
  lab_test: "Test",
  lab_package: "Package",
  doctor_consultation: "Consultation",
  doctor_procedure: "Procedure",
  home_service: "Home service",
  vaccine: "Vaccine",
};

const RELATIVE_FMT = new Intl.RelativeTimeFormat("en-PH", { numeric: "auto" });
function relativeFromNow(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const sec = Math.round(ms / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);
  if (sec < 60) return RELATIVE_FMT.format(-sec, "second");
  if (min < 60) return RELATIVE_FMT.format(-min, "minute");
  if (hr < 48) return RELATIVE_FMT.format(-hr, "hour");
  return RELATIVE_FMT.format(-day, "day");
}

function toInputValue(v: number | null): string {
  return v == null ? "" : String(v);
}

function nullableNumber(v: string): number | null {
  const t = v.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

interface Props {
  rows: PriceRow[];
}

export function PricesTable({ rows }: Props) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [section, setSection] = useState<string>("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [edits, setEdits] = useState<
    Record<
      string,
      { price: string; hmo: string; senior: string }
    >
  >({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [errorById, setErrorById] = useState<Record<string, string | null>>({});
  const [confirming, setConfirming] = useState<{
    row: PriceRow;
    next: { price: number; hmo: number | null; senior: number | null };
  } | null>(null);
  const [isPending, startTransition] = useTransition();

  const sections = useMemo(() => {
    const s = new Set<string>();
    for (const r of rows) s.add(r.section ?? "uncategorized");
    return Array.from(s).sort();
  }, [rows]);

  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    return rows.filter((r) => {
      if (section !== "all") {
        const s = r.section ?? "uncategorized";
        if (s !== section) return false;
      }
      if (q && !`${r.name} ${r.code}`.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [rows, section, deferredQuery]);

  function getEdit(r: PriceRow) {
    return (
      edits[r.id] ?? {
        price: toInputValue(r.price_php),
        hmo: toInputValue(r.hmo_price_php),
        senior: toInputValue(r.senior_discount_php),
      }
    );
  }

  function patchEdit(id: string, patch: Partial<{ price: string; hmo: string; senior: string }>) {
    setEdits((prev) => {
      const cur = prev[id] ?? { price: "", hmo: "", senior: "" };
      return { ...prev, [id]: { ...cur, ...patch } };
    });
  }

  function isDirty(r: PriceRow): boolean {
    const e = edits[r.id];
    if (!e) return false;
    const ePrice = nullableNumber(e.price);
    return (
      ePrice !== r.price_php ||
      nullableNumber(e.hmo) !== r.hmo_price_php ||
      nullableNumber(e.senior) !== r.senior_discount_php
    );
  }

  function requestSave(r: PriceRow) {
    const e = getEdit(r);
    const ePrice = nullableNumber(e.price);
    if (ePrice == null) {
      setErrorById((prev) => ({
        ...prev,
        [r.id]: "DRMed price is required.",
      }));
      return;
    }
    setErrorById((prev) => ({ ...prev, [r.id]: null }));
    setConfirming({
      row: r,
      next: {
        price: ePrice,
        hmo: nullableNumber(e.hmo),
        senior: nullableNumber(e.senior),
      },
    });
  }

  async function handleConfirm() {
    if (!confirming) return;
    const { row: r, next } = confirming;
    setSavingId(r.id);
    const result = await updateServicePricesAction({
      service_id: r.id,
      price_php: next.price,
      hmo_price_php: next.hmo,
      senior_discount_php: next.senior,
    });
    setSavingId(null);
    setConfirming(null);
    if (!result.ok) {
      setErrorById((prev) => ({ ...prev, [r.id]: result.error }));
      return;
    }
    setEdits((prev) => {
      const next = { ...prev };
      delete next[r.id];
      return next;
    });
    setSavedId(r.id);
    setTimeout(() => setSavedId((cur) => (cur === r.id ? null : cur)), 1800);
    startTransition(() => router.refresh());
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="search"
          placeholder="Search by name or code"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="min-w-64 flex-1 rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2.5 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-cyan)]/20"
        />
        <select
          value={section}
          onChange={(e) => setSection(e.target.value)}
          className="rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2.5 text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none"
        >
          <option value="all">All sections ({rows.length})</option>
          {sections.map((s) => {
            const count = rows.filter(
              (r) => (r.section ?? "uncategorized") === s,
            ).length;
            return (
              <option key={s} value={s}>
                {SECTION_LABEL[s] ?? s} ({count})
              </option>
            );
          })}
        </select>
        <p className="text-xs text-[color:var(--color-brand-text-soft)]">
          Showing {filtered.length} of {rows.length}
        </p>
      </div>

      <div className="overflow-x-auto rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-3 py-3 w-8" aria-label="expand" />
              <th className="px-4 py-3">Code / name</th>
              <th className="px-4 py-3">Type</th>
              <th className="px-4 py-3 w-32">DRMed (₱)</th>
              <th className="px-4 py-3 w-32">HMO (₱)</th>
              <th className="px-4 py-3 w-32">Senior disc. (₱)</th>
              <th className="px-4 py-3">Last changed</th>
              <th className="px-4 py-3 w-24" aria-label="save" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={8}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No services match your filters.
                </td>
              </tr>
            ) : (
              filtered.map((r) => {
                const edit = getEdit(r);
                const dirty = isDirty(r);
                const saving = savingId === r.id;
                const justSaved = savedId === r.id;
                const expanded = expandedId === r.id;
                const err = errorById[r.id];
                return (
                  <Fragment key={r.id}>
                    <tr
                      className={
                        dirty
                          ? "bg-amber-50/50"
                          : "hover:bg-[color:var(--color-brand-bg)]/40"
                      }
                    >
                      <td className="px-3 py-2 align-middle">
                        <button
                          type="button"
                          aria-expanded={expanded}
                          aria-label={expanded ? "Hide history" : "Show history"}
                          onClick={() =>
                            setExpandedId(expanded ? null : r.id)
                          }
                          className="rounded p-1 text-[color:var(--color-brand-text-soft)] hover:bg-[color:var(--color-brand-bg-mid)]"
                        >
                          {expanded ? "▾" : "▸"}
                        </button>
                      </td>
                      <td className="px-4 py-2 align-middle">
                        <Link
                          href={`/staff/services/${r.id}/edit`}
                          title={
                            r.kind === "lab_package" && r.description
                              ? `Includes: ${r.description}`
                              : undefined
                          }
                          className="block rounded -mx-1 px-1 hover:bg-[color:var(--color-brand-bg-mid)]/50"
                        >
                          <div className="font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                            {r.code}
                          </div>
                          <div className="font-semibold text-[color:var(--color-brand-navy)] hover:text-[color:var(--color-brand-cyan)]">
                            {r.name}
                            {r.is_send_out ? (
                              <span className="ml-2 rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-900">
                                Send-out
                              </span>
                            ) : null}
                            {!r.is_active ? (
                              <span className="ml-2 rounded-md bg-slate-200 px-1.5 py-0.5 text-[10px] font-bold uppercase text-slate-700">
                                Inactive
                              </span>
                            ) : null}
                          </div>
                        </Link>
                      </td>
                      <td className="px-4 py-2 align-middle text-xs text-[color:var(--color-brand-text-mid)]">
                        <div>{KIND_LABEL[r.kind] ?? r.kind}</div>
                        <div className="text-[color:var(--color-brand-text-soft)]">
                          {r.section
                            ? (SECTION_LABEL[r.section] ?? r.section)
                            : "—"}
                        </div>
                      </td>
                      <td className="px-4 py-2 align-middle">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          value={edit.price}
                          onChange={(e) =>
                            patchEdit(r.id, { price: e.target.value })
                          }
                          className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1 text-right text-sm font-semibold focus:border-[color:var(--color-brand-cyan)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-brand-cyan)]"
                        />
                      </td>
                      <td className="px-4 py-2 align-middle">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="—"
                          value={edit.hmo}
                          onChange={(e) =>
                            patchEdit(r.id, { hmo: e.target.value })
                          }
                          className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1 text-right text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-brand-cyan)]"
                        />
                      </td>
                      <td className="px-4 py-2 align-middle">
                        <input
                          type="number"
                          step="0.01"
                          min="0"
                          placeholder="—"
                          value={edit.senior}
                          onChange={(e) =>
                            patchEdit(r.id, { senior: e.target.value })
                          }
                          className="w-full rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-2 py-1 text-right text-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none focus:ring-1 focus:ring-[color:var(--color-brand-cyan)]"
                        />
                      </td>
                      <td className="px-4 py-2 align-middle text-xs text-[color:var(--color-brand-text-mid)]">
                        {r.last_changed_at ? (
                          <>
                            <div>{relativeFromNow(r.last_changed_at)}</div>
                            <div className="text-[color:var(--color-brand-text-soft)]">
                              {r.last_changed_by ?? "system"}
                            </div>
                          </>
                        ) : (
                          <span className="text-[color:var(--color-brand-text-soft)]">
                            —
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 align-middle text-right">
                        {dirty ? (
                          <button
                            type="button"
                            disabled={saving}
                            onClick={() => requestSave(r)}
                            className="rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
                          >
                            {saving ? "Saving…" : "Save"}
                          </button>
                        ) : justSaved ? (
                          <span className="text-xs font-semibold text-emerald-700">
                            Saved ✓
                          </span>
                        ) : null}
                      </td>
                    </tr>
                    {err ? (
                      <tr className="bg-red-50">
                        <td colSpan={8} className="px-4 py-2 text-xs text-red-700">
                          {err}
                        </td>
                      </tr>
                    ) : null}
                    {expanded ? (
                      <tr>
                        <td
                          colSpan={8}
                          className="bg-[color:var(--color-brand-bg)]/40 px-4 py-3"
                        >
                          <ServiceHistoryPanel
                            serviceId={r.id}
                            currentPrice={r.price_php}
                            currentHmo={r.hmo_price_php}
                            currentSenior={r.senior_discount_php}
                          />
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-[color:var(--color-brand-text-soft)]">
        Tip: leave HMO or Senior empty if the service isn&apos;t HMO billable
        or has no senior discount. Saved changes are recorded in price history
        with your name automatically.
        {isPending ? " Refreshing…" : ""}
      </p>

      {confirming ? (
        <ConfirmModal
          row={confirming.row}
          next={confirming.next}
          saving={savingId === confirming.row.id}
          onCancel={() => setConfirming(null)}
          onConfirm={handleConfirm}
        />
      ) : null}
    </div>
  );
}

interface ConfirmProps {
  row: PriceRow;
  next: { price: number; hmo: number | null; senior: number | null };
  saving: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmModal({ row, next, saving, onCancel, onConfirm }: ConfirmProps) {
  const lines: { label: string; before: number | null; after: number | null }[] = [
    { label: "DRMed", before: row.price_php, after: next.price },
    { label: "HMO", before: row.hmo_price_php, after: next.hmo },
    { label: "Senior disc.", before: row.senior_discount_php, after: next.senior },
  ];
  const changedLines = lines.filter((l) => (l.before ?? null) !== (l.after ?? null));

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-price-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2
          id="confirm-price-title"
          className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]"
        >
          Confirm price change
        </h2>
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          {row.code} · {row.name}
        </p>
        <p className="mt-3 text-sm text-[color:var(--color-brand-text-mid)]">
          Double-check this isn&apos;t a typo. The change will be recorded in
          price history with your name.
        </p>
        <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {changedLines.map((l) => (
            <Fragment key={l.label}>
              <dt className="text-[color:var(--color-brand-text-soft)]">
                {l.label}
              </dt>
              <dd className="text-right">
                <span className="text-[color:var(--color-brand-text-soft)] line-through">
                  {l.before != null ? formatPhp(l.before) : "—"}
                </span>{" "}
                <span className="font-bold text-[color:var(--color-brand-navy)]">
                  → {l.after != null ? formatPhp(l.after) : "—"}
                </span>
              </dd>
            </Fragment>
          ))}
        </dl>
        <div className="mt-6 flex justify-end gap-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={saving}
            className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-2 text-sm font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={saving}
            className="rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)] disabled:opacity-50"
          >
            {saving ? "Saving…" : "Confirm save"}
          </button>
        </div>
      </div>
    </div>
  );
}

export { formatPhp };
