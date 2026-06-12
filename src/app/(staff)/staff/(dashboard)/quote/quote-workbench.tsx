"use client";

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { formatPhp } from "@/lib/marketing/format";
import { Panel } from "@/components/ui/panel";
import {
  isSeniorPwdEligible,
  seniorPwdDiscount,
  seniorPwdPrice,
} from "@/lib/pricing/senior";

export interface QuoteService {
  id: string;
  code: string;
  name: string;
  price_php: number;
  hmo_price_php: number | null;
  senior_discount_php: number | null;
  senior_pwd_eligible: boolean | null;
  turnaround_hours: number | null;
  kind: string;
  section: string | null;
  is_send_out: boolean;
}

/** Senior/PWD price for a service line, or null when the service is ineligible. */
function seniorPriceOf(s: QuoteService): number | null {
  return seniorPwdPrice({
    base: s.price_php,
    seniorDiscountPhp: s.senior_discount_php,
    eligible: isSeniorPwdEligible(s),
  });
}

/** Senior/PWD peso discount for a service line (0 when ineligible). */
function seniorDiscountOf(s: QuoteService): number {
  return seniorPwdDiscount({
    base: s.price_php,
    seniorDiscountPhp: s.senior_discount_php,
    eligible: isSeniorPwdEligible(s),
  });
}

interface Props {
  services: QuoteService[];
}

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200] as const;
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

export function QuoteWorkbench({ services }: Props) {
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [seniorMode, setSeniorMode] = useState(false);
  const [builderCopied, setBuilderCopied] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(50);
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus on mount; re-focus on Cmd/Ctrl+K from anywhere on this page.
  useEffect(() => {
    inputRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Filter the full catalog by query; pagination wraps the filtered set
  // so the page count reflects whatever the user is actually browsing.
  const matched = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    if (!q) return services;
    return services.filter((s) =>
      `${s.name} ${s.code}`.toLowerCase().includes(q),
    );
  }, [services, deferredQuery]);

  const totalPages = Math.max(1, Math.ceil(matched.length / pageSize));
  // Clamp page to the available range during render — when the user
  // narrows the query or shrinks the page size, the previously-selected
  // page index might overshoot. Compute the effective page here instead
  // of reactively resetting via useEffect.
  const currentPage = Math.min(page, totalPages);

  const filtered = useMemo(
    () => matched.slice((currentPage - 1) * pageSize, currentPage * pageSize),
    [matched, currentPage, pageSize],
  );

  const pickedList = useMemo(
    () => services.filter((s) => picked.has(s.id)),
    [services, picked],
  );

  const builderTotals = useMemo(() => {
    let cash = 0;
    let hmo = 0;
    let hmoCount = 0;
    let hmoMissingCount = 0;
    let senior = 0;
    for (const s of pickedList) {
      cash += s.price_php;
      if (s.hmo_price_php != null) {
        hmo += s.hmo_price_php;
        hmoCount++;
      } else {
        hmoMissingCount++;
      }
      // Ineligible services contribute their full cash price to the senior
      // total — they get no senior/PWD discount.
      senior += seniorPriceOf(s) ?? s.price_php;
    }
    return { cash, hmo, hmoCount, hmoMissingCount, senior };
  }, [pickedList]);

  function togglePicked(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function copyBuilder(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setBuilderCopied(true);
      setTimeout(() => setBuilderCopied(false), 1500);
    } catch {
      // Browsers that block clipboard fall back to a manual prompt.
      window.prompt("Copy quote", text);
    }
  }

  // Copyable summary for Viber/SMS. Always carries cash + HMO so HMO rates are
  // never silently dropped; when Senior/PWD mode is on it shows senior prices
  // (and flags items that don't qualify).
  function builderSummary(): string {
    if (pickedList.length === 0) return "";
    const lines = pickedList.map((s) => {
      if (seniorMode) {
        const sp = seniorPriceOf(s);
        const price = sp ?? s.price_php;
        return `• ${s.name} — ${formatPhp(price)}${sp == null ? " (senior N/A)" : ""}`;
      }
      const parts = [`${formatPhp(s.price_php)} cash`];
      if (s.hmo_price_php != null) parts.push(`${formatPhp(s.hmo_price_php)} HMO`);
      return `• ${s.name} — ${parts.join(" · ")}`;
    });
    const out = [...lines, ""];
    if (seniorMode) {
      out.push(`Total (Senior/PWD): ${formatPhp(builderTotals.senior)}`);
    } else {
      out.push(`Total (cash): ${formatPhp(builderTotals.cash)}`);
      if (builderTotals.hmoCount > 0) {
        const note =
          builderTotals.hmoMissingCount > 0
            ? ` (${builderTotals.hmoMissingCount} item${builderTotals.hmoMissingCount === 1 ? "" : "s"} without HMO rate)`
            : "";
        out.push(`HMO total: ${formatPhp(builderTotals.hmo)}${note}`);
      }
    }
    return out.join("\n");
  }

  return (
    <div className="space-y-6">
      <div>
        <label htmlFor="quote-search" className="sr-only">
          Search services
        </label>
        <input
          id="quote-search"
          ref={inputRef}
          type="search"
          placeholder="Search by name or code (CBC, lipid, ultrasound…)"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-lg border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-3 text-sm shadow-sm focus:border-[color:var(--color-brand-cyan)] focus:outline-none focus:ring-2 focus:ring-[color:var(--color-brand-cyan)]/20"
        />
        <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs text-[color:var(--color-brand-text-soft)]">
          <span>
            {matched.length === 0
              ? "No matches"
              : matched.length === services.length
                ? `${services.length} services`
                : `${matched.length} of ${services.length} services match`}
            {matched.length > pageSize
              ? ` · showing ${(currentPage - 1) * pageSize + 1}–${Math.min(currentPage * pageSize, matched.length)}`
              : ""}
          </span>
          <label className="flex items-center gap-1">
            <span>Rows</span>
            <select
              value={pageSize}
              onChange={(e) => setPageSize(Number(e.target.value) as PageSize)}
              className="rounded border border-[color:var(--color-brand-bg-mid)] bg-white px-1.5 py-0.5 text-xs"
            >
              {PAGE_SIZE_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          Tick services to add them to the quote — totals and a copyable summary
          appear below.
        </p>
      </div>

      <Panel className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              <th className="px-3 py-3 w-10" aria-label="Pick" />
              <th className="px-4 py-3">Code</th>
              <th className="px-4 py-3">Name</th>
              <th className="px-4 py-3 text-right">Cash</th>
              <th className="px-4 py-3 text-right">HMO</th>
              <th className="px-4 py-3 text-right">Senior disc.</th>
              <th className="px-4 py-3 text-right">Senior price</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {filtered.length === 0 ? (
              <tr>
                <td
                  colSpan={7}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No matches.
                </td>
              </tr>
            ) : (
              filtered.map((s) => {
                const eligible = isSeniorPwdEligible(s);
                const sp = seniorPriceOf(s);
                return (
                  <tr
                    key={s.id}
                    className="cursor-pointer hover:bg-[color:var(--color-brand-bg)]"
                    onClick={() => togglePicked(s.id)}
                  >
                    <td className="px-3 py-3">
                      <input
                        type="checkbox"
                        checked={picked.has(s.id)}
                        onChange={() => togglePicked(s.id)}
                        onClick={(e) => e.stopPropagation()}
                        aria-label={`Add ${s.name} to quote`}
                      />
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-[color:var(--color-brand-text-mid)]">
                      {s.code}
                    </td>
                    <td className="px-4 py-3 font-semibold text-[color:var(--color-brand-navy)]">
                      {s.name}
                      {s.is_send_out ? (
                        <span className="ml-2 rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-900">
                          Send-out
                        </span>
                      ) : null}
                    </td>
                    <td className="px-4 py-3 text-right font-bold text-[color:var(--color-brand-navy)]">
                      {formatPhp(s.price_php)}
                    </td>
                    <td className="px-4 py-3 text-right text-[color:var(--color-brand-text-mid)]">
                      {s.hmo_price_php != null ? formatPhp(s.hmo_price_php) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right text-[color:var(--color-brand-text-mid)]">
                      {eligible ? formatPhp(seniorDiscountOf(s)) : "—"}
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-[color:var(--color-brand-text-mid)]">
                      {sp != null ? (
                        formatPhp(sp)
                      ) : (
                        <span className="text-[color:var(--color-brand-text-soft)]">
                          Not applicable
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </Panel>

      {totalPages > 1 ? (
        <div className="flex items-center justify-between text-xs text-[color:var(--color-brand-text-soft)]">
          <span>
            Page {currentPage} of {totalPages}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={currentPage === 1}
              onClick={() => setPage(Math.max(1, currentPage - 1))}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1 font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)] disabled:opacity-40"
            >
              ← Prev
            </button>
            <button
              type="button"
              disabled={currentPage === totalPages}
              onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
              className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1 font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)] disabled:opacity-40"
            >
              Next →
            </button>
          </div>
        </div>
      ) : null}

      <aside className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)]">
            Selected ({picked.size})
          </h2>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={seniorMode}
              onChange={(e) => setSeniorMode(e.target.checked)}
            />
            <span>Apply Senior/PWD discount</span>
          </label>
        </div>
        {pickedList.length === 0 ? (
          <p className="mt-3 text-sm text-[color:var(--color-brand-text-soft)]">
            Tick rows above to add them. Totals appear here.
          </p>
        ) : (
          <>
            <ul className="mt-3 divide-y divide-[color:var(--color-brand-bg-mid)] text-sm">
              {pickedList.map((s) => {
                const sp = seniorPriceOf(s);
                const price = seniorMode ? (sp ?? s.price_php) : s.price_php;
                return (
                  <li
                    key={s.id}
                    className="flex items-center justify-between gap-3 py-2"
                  >
                    <span className="text-[color:var(--color-brand-text-mid)]">
                      {s.name}
                      {seniorMode && sp == null ? (
                        <span className="ml-2 rounded bg-[color:var(--color-brand-bg-mid)] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                          No senior disc.
                        </span>
                      ) : null}
                    </span>
                    <span className="font-semibold text-[color:var(--color-brand-navy)]">
                      {formatPhp(price)}
                    </span>
                  </li>
                );
              })}
            </ul>
            <div className="mt-4 flex flex-wrap items-end justify-between gap-3 border-t border-[color:var(--color-brand-bg-mid)] pt-4">
              <div>
                <p className="text-xs uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                  Total {seniorMode ? "(Senior/PWD)" : "(cash)"}
                </p>
                <p className="mt-1 font-heading text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
                  {formatPhp(
                    seniorMode ? builderTotals.senior : builderTotals.cash,
                  )}
                </p>
                {/* HMO total is shown for whatever items DO have an HMO rate
                    (partial), with an explicit count of the ones that don't —
                    instead of suppressing the figure all-or-nothing. */}
                {builderTotals.hmoCount > 0 ? (
                  <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
                    HMO total: {formatPhp(builderTotals.hmo)}
                    {builderTotals.hmoMissingCount > 0
                      ? ` · ${builderTotals.hmoMissingCount} item${builderTotals.hmoMissingCount === 1 ? "" : "s"} without HMO rate`
                      : ""}
                  </p>
                ) : (
                  <p className="mt-1 text-xs text-amber-700">
                    No HMO rate on file for the selected items.
                  </p>
                )}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => copyBuilder(builderSummary())}
                  className="rounded-md bg-[color:var(--color-brand-navy)] px-3 py-2 text-xs font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
                >
                  {builderCopied ? "Copied ✓" : "Copy summary"}
                </button>
                <button
                  type="button"
                  onClick={() => setPicked(new Set())}
                  className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-2 text-xs font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
                >
                  Clear
                </button>
              </div>
            </div>
          </>
        )}
      </aside>
    </div>
  );
}
