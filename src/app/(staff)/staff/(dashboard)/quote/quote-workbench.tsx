"use client";

import {
  Fragment,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { formatPhp } from "@/lib/marketing/format";

export interface QuoteService {
  id: string;
  code: string;
  name: string;
  price_php: number;
  hmo_price_php: number | null;
  senior_discount_php: number | null;
  turnaround_hours: number | null;
  kind: string;
  section: string | null;
  is_send_out: boolean;
}

type Mode = "search" | "builder";

function seniorPrice(s: QuoteService): number | null {
  if (s.senior_discount_php == null) return null;
  return Math.max(0, s.price_php - s.senior_discount_php);
}

function formatSingleQuote(s: QuoteService): string {
  const lines = [s.name];
  const parts: string[] = [`${formatPhp(s.price_php)} (cash)`];
  if (s.hmo_price_php != null) parts.push(`${formatPhp(s.hmo_price_php)} (HMO)`);
  const sp = seniorPrice(s);
  if (sp != null) parts.push(`Senior ${formatPhp(sp)}`);
  lines.push(parts.join(" / "));
  if (s.turnaround_hours) lines.push(`Turnaround: ${s.turnaround_hours} hours`);
  if (s.is_send_out) lines.push("Send-out test (results take longer).");
  return lines.join("\n");
}

interface Props {
  services: QuoteService[];
}

export function QuoteWorkbench({ services }: Props) {
  const [mode, setMode] = useState<Mode>("search");
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [seniorMode, setSeniorMode] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [builderCopied, setBuilderCopied] = useState(false);
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

  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLowerCase();
    if (!q) return services.slice(0, 50);
    return services.filter((s) =>
      `${s.name} ${s.code}`.toLowerCase().includes(q),
    );
  }, [services, deferredQuery]);

  const pickedList = useMemo(
    () => services.filter((s) => picked.has(s.id)),
    [services, picked],
  );

  const builderTotals = useMemo(() => {
    let cash = 0;
    let hmo = 0;
    let hmoMissingCount = 0;
    let senior = 0;
    for (const s of pickedList) {
      cash += s.price_php;
      if (s.hmo_price_php != null) hmo += s.hmo_price_php;
      else hmoMissingCount++;
      const sp = seniorPrice(s);
      senior += sp ?? s.price_php;
    }
    return { cash, hmo, hmoMissingCount, senior };
  }, [pickedList]);

  function togglePicked(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function copyText(text: string, key: "single" | "builder", id?: string) {
    try {
      await navigator.clipboard.writeText(text);
      if (key === "single" && id) {
        setCopiedId(id);
        setTimeout(() => setCopiedId(null), 1500);
      } else {
        setBuilderCopied(true);
        setTimeout(() => setBuilderCopied(false), 1500);
      }
    } catch {
      // Browsers that block clipboard fall back to a manual prompt.
      window.prompt("Copy quote", text);
    }
  }

  function builderSummary(): string {
    if (pickedList.length === 0) return "";
    const lines = pickedList.map((s) => {
      const price = seniorMode ? (seniorPrice(s) ?? s.price_php) : s.price_php;
      return `• ${s.name} — ${formatPhp(price)}`;
    });
    const total = seniorMode ? builderTotals.senior : builderTotals.cash;
    lines.push(
      `\nTotal${seniorMode ? " (Senior/PWD)" : ""}: ${formatPhp(total)}`,
    );
    return lines.join("\n");
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setMode("search")}
          className={
            mode === "search"
              ? "rounded-full bg-[color:var(--color-brand-navy)] px-4 py-1.5 text-xs font-bold text-white"
              : "rounded-full border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-1.5 text-xs font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
          }
        >
          Single quote
        </button>
        <button
          type="button"
          onClick={() => setMode("builder")}
          className={
            mode === "builder"
              ? "rounded-full bg-[color:var(--color-brand-navy)] px-4 py-1.5 text-xs font-bold text-white"
              : "rounded-full border border-[color:var(--color-brand-bg-mid)] bg-white px-4 py-1.5 text-xs font-bold text-[color:var(--color-brand-navy)] hover:border-[color:var(--color-brand-cyan)]"
          }
        >
          Quote builder
          {picked.size > 0 ? (
            <span className="ml-2 rounded-full bg-white/20 px-1.5 text-[10px]">
              {picked.size}
            </span>
          ) : null}
        </button>
      </div>

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
        <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
          {filtered.length} of {services.length} services
        </p>
      </div>

      <div className="overflow-hidden rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white">
        <table className="w-full text-sm">
          <thead className="bg-[color:var(--color-brand-bg)] text-left text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            <tr>
              {mode === "builder" ? (
                <th className="px-3 py-3 w-10" aria-label="Pick" />
              ) : null}
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
                  colSpan={mode === "builder" ? 7 : 6}
                  className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]"
                >
                  No matches.
                </td>
              </tr>
            ) : (
              filtered.map((s) => {
                const sp = seniorPrice(s);
                const expanded = expandedId === s.id && mode === "search";
                return (
                  <Fragment key={s.id}>
                    <tr
                      className="cursor-pointer hover:bg-[color:var(--color-brand-bg)]"
                      onClick={() =>
                        mode === "search"
                          ? setExpandedId(expanded ? null : s.id)
                          : togglePicked(s.id)
                      }
                    >
                      {mode === "builder" ? (
                        <td className="px-3 py-3">
                          <input
                            type="checkbox"
                            checked={picked.has(s.id)}
                            onChange={() => togglePicked(s.id)}
                            onClick={(e) => e.stopPropagation()}
                            aria-label={`Add ${s.name} to quote`}
                          />
                        </td>
                      ) : null}
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
                        {s.hmo_price_php != null
                          ? formatPhp(s.hmo_price_php)
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-right text-[color:var(--color-brand-text-mid)]">
                        {s.senior_discount_php != null
                          ? formatPhp(s.senior_discount_php)
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-[color:var(--color-brand-text-mid)]">
                        {sp != null ? formatPhp(sp) : "—"}
                      </td>
                    </tr>
                    {expanded ? (
                      <tr className="bg-[color:var(--color-brand-bg)]/50">
                        <td colSpan={6} className="px-4 py-3">
                          <pre className="whitespace-pre-wrap rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-3 text-xs leading-relaxed text-[color:var(--color-brand-text-mid)]">
{formatSingleQuote(s)}
                          </pre>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              copyText(formatSingleQuote(s), "single", s.id);
                            }}
                            className="mt-2 rounded-md bg-[color:var(--color-brand-navy)] px-3 py-1.5 text-xs font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
                          >
                            {copiedId === s.id ? "Copied ✓" : "Copy quote"}
                          </button>
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

      {mode === "builder" ? (
        <aside className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-[family-name:var(--font-heading)] text-lg font-extrabold text-[color:var(--color-brand-navy)]">
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
                  const price = seniorMode
                    ? (seniorPrice(s) ?? s.price_php)
                    : s.price_php;
                  return (
                    <li
                      key={s.id}
                      className="flex items-center justify-between py-2"
                    >
                      <span className="text-[color:var(--color-brand-text-mid)]">
                        {s.name}
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
                  <p className="mt-1 font-[family-name:var(--font-heading)] text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
                    {formatPhp(
                      seniorMode ? builderTotals.senior : builderTotals.cash,
                    )}
                  </p>
                  {!seniorMode && builderTotals.hmoMissingCount === 0 ? (
                    <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
                      HMO total: {formatPhp(builderTotals.hmo)}
                    </p>
                  ) : null}
                  {!seniorMode && builderTotals.hmoMissingCount > 0 ? (
                    <p className="mt-1 text-xs text-amber-700">
                      {builderTotals.hmoMissingCount} item
                      {builderTotals.hmoMissingCount === 1 ? "" : "s"} not HMO
                      billable.
                    </p>
                  ) : null}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => copyText(builderSummary(), "builder")}
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
      ) : null}
    </div>
  );
}
