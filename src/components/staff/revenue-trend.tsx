"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { VISIT_CLASS_LABEL, VISIT_CLASSES, type VisitClass } from "@/lib/visits/classification";
import { trendMonthHref, type RevenueTrendPoint } from "@/lib/visits/revenue-presets";

// Validated with the dataviz palette checker (adjacent stack pairs pass CVD and
// the normal-vision floor on white). The consult violet is under 3:1 against
// the surface, so identity never rests on colour alone: legend, tooltip and
// the table view all name each series.
const SERIES_COLOR: Record<VisitClass, string> = {
  lab: "#0369a1",
  consult: "#a78bfa",
  procedure: "#c026d3",
};

const PHP = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  maximumFractionDigits: 0,
});
const PHP_SHORT = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  notation: "compact",
  maximumFractionDigits: 1,
});

const HEIGHT = 150;
const PLOT_TOP = 18;
const PLOT_BOTTOM = HEIGHT - 20;
const GAP = 2;

type State =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; points: RevenueTrendPoint[] };

function total(p: RevenueTrendPoint): number {
  return p.lab + p.consult + p.procedure;
}

function monthName(p: RevenueTrendPoint): string {
  return `${p.label} ${p.year}${p.partial ? " (to date)" : ""}`;
}

/** A rect whose top corners are rounded — the data end; the base stays square. */
function topRoundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/**
 * The last 12 months of billed revenue per classification, inside the admin
 * "Revenue by classification" dropdown. Fetches only once its <details> is
 * opened, so a collapsed dropdown costs nothing.
 */
export function RevenueTrend({ view = "active" }: { view?: string }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<State>({ kind: "idle" });
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    // Inside the dropdown: wait until it is opened. Standalone (Monthly
    // Trends): load straight away.
    const details = el.closest("details");
    let started = false;
    let cancelled = false;
    const load = () => {
      if (started || (details && !details.open)) return;
      started = true;
      setState({ kind: "loading" });
      fetch(`/api/admin/revenue-trend?view=${encodeURIComponent(view)}`, {
        credentials: "same-origin",
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((body: { ok: boolean; points?: RevenueTrendPoint[] }) => {
          if (cancelled) return;
          if (!body.ok || !body.points) throw new Error("bad body");
          setState({ kind: "ready", points: body.points });
        })
        .catch(() => {
          if (!cancelled) setState({ kind: "error" });
        });
    };
    load();
    details?.addEventListener("toggle", load);
    return () => {
      cancelled = true;
      details?.removeEventListener("toggle", load);
    };
  }, [view]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={wrapRef} className="mt-4 rounded-lg border border-[color:var(--color-brand-bg-mid)] p-3">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Last 12 months
        </h3>
        <ul className="flex flex-wrap gap-3 text-xs text-[color:var(--color-brand-text)]" aria-label="Legend">
          {VISIT_CLASSES.map((c) => (
            <li key={c} className="flex items-center gap-1.5">
              <span
                aria-hidden="true"
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ background: SERIES_COLOR[c] }}
              />
              {VISIT_CLASS_LABEL[c]}
            </li>
          ))}
        </ul>
      </div>

      {state.kind === "error" ? (
        <p role="status" className="text-sm text-red-700">
          Couldn&apos;t load the 12-month trend. Close and reopen to try again.
        </p>
      ) : state.kind !== "ready" ? (
        <p role="status" className="py-10 text-center text-xs text-[color:var(--color-brand-text-soft)]">
          Loading the last 12 months…
        </p>
      ) : (
        <TrendChart
          points={state.points}
          width={width}
          active={active}
          setActive={setActive}
          view={view}
        />
      )}
    </div>
  );
}

function TrendChart({
  points,
  width,
  active,
  setActive,
  view,
}: {
  points: RevenueTrendPoint[];
  width: number;
  active: number | null;
  setActive: (i: number | null) => void;
  view: string;
}) {
  const router = useRouter();
  const max = Math.max(0, ...points.map(total));
  const w = Math.max(width - 2, 240);
  const slot = w / points.length;
  const barW = Math.max(6, Math.min(28, slot * 0.6));
  const plotH = PLOT_BOTTOM - PLOT_TOP;
  const scale = (v: number) => (max > 0 ? (v / max) * plotH : 0);
  const activePoint = active === null ? null : points[active];

  return (
    <>
      <div className="relative">
        <svg
          width={w}
          height={HEIGHT}
          role="img"
          aria-label={`Monthly billed revenue by classification, ${monthName(points[0])} to ${monthName(points[points.length - 1])}. Peak ${PHP.format(max)}. Table view below.`}
          className="block"
          onMouseLeave={() => setActive(null)}
        >
          {/* Recessive scale reference: the peak value and a baseline. */}
          <text x={0} y={10} className="fill-[color:var(--color-brand-text-soft)] text-[10px]">
            {max > 0 ? `Peak ${PHP_SHORT.format(max)}` : "No billed revenue yet"}
          </text>
          <line
            x1={0}
            x2={w}
            y1={PLOT_BOTTOM + 0.5}
            y2={PLOT_BOTTOM + 0.5}
            stroke="var(--color-brand-bg-mid)"
          />
          {points.map((p, i) => {
            const cx = slot * i + slot / 2;
            const x = cx - barW / 2;
            let y = PLOT_BOTTOM;
            const segs = VISIT_CLASSES.map((c) => ({ c, h: scale(p[c]) })).filter((s) => s.h > 0);
            return (
              <g key={p.key} opacity={active === null || active === i ? 1 : 0.45}>
                {segs.map((s, j) => {
                  const isTop = j === segs.length - 1;
                  // 2px surface gap between stacked segments.
                  const h = Math.max(1, s.h - (isTop ? 0 : GAP));
                  y -= s.h;
                  const top = y + (isTop ? 0 : GAP);
                  return isTop ? (
                    <path key={s.c} d={topRoundedRect(x, top, barW, h, 4)} fill={SERIES_COLOR[s.c]} />
                  ) : (
                    <rect key={s.c} x={x} y={top} width={barW} height={h} fill={SERIES_COLOR[s.c]} />
                  );
                })}
                <text
                  x={cx}
                  y={HEIGHT - 5}
                  textAnchor="middle"
                  className={`text-[10px] ${
                    active === i
                      ? "fill-[color:var(--color-brand-navy)] font-semibold"
                      : "fill-[color:var(--color-brand-text-soft)]"
                  }`}
                >
                  {p.label}
                </text>
                {/* Hit target: the whole column, bigger than the mark. */}
                <rect
                  x={slot * i}
                  y={0}
                  width={slot}
                  height={HEIGHT}
                  fill="transparent"
                  tabIndex={0}
                  role="link"
                  aria-label={`${monthName(p)}: ${PHP.format(total(p))} total. Open these visits in Visit Records.`}
                  onMouseEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  // Click (or Enter) opens that month in Visit Records.
                  onClick={() => router.push(trendMonthHref(p, view))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") router.push(trendMonthHref(p, view));
                  }}
                  className="cursor-pointer outline-none focus-visible:stroke-[color:var(--color-brand-cyan)]"
                />
              </g>
            );
          })}
        </svg>
        {activePoint && active !== null ? (
          <div
            role="tooltip"
            className="pointer-events-none absolute top-0 z-10 w-48 rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white p-2 text-xs shadow-md"
            style={{
              left: Math.min(Math.max(slot * active + slot / 2 - 96, 0), Math.max(w - 192, 0)),
              transform: "translateY(-100%)",
            }}
          >
            <p className="mb-1 font-semibold text-[color:var(--color-brand-navy)]">{monthName(activePoint)}</p>
            {VISIT_CLASSES.map((c) => (
              <p key={c} className="flex items-center justify-between gap-2 text-[color:var(--color-brand-text)]">
                <span className="flex items-center gap-1.5">
                  <span
                    aria-hidden="true"
                    className="inline-block h-2 w-2 rounded-sm"
                    style={{ background: SERIES_COLOR[c] }}
                  />
                  {VISIT_CLASS_LABEL[c]}
                </span>
                <span className="font-mono">{PHP.format(activePoint[c])}</span>
              </p>
            ))}
            <p className="mt-1 flex justify-between border-t border-[color:var(--color-brand-bg-mid)] pt-1 font-semibold text-[color:var(--color-brand-navy)]">
              <span>Total</span>
              <span className="font-mono">{PHP.format(total(activePoint))}</span>
            </p>
            <p className="mt-1 text-[10px] text-[color:var(--color-brand-text-soft)]">
              Click to open these visits
            </p>
          </div>
        ) : null}
      </div>

      <details className="mt-2 text-xs">
        <summary className="cursor-pointer text-[color:var(--color-brand-text-soft)]">Show as table</summary>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full text-left">
            <thead className="text-[color:var(--color-brand-text-soft)]">
              <tr>
                <th className="py-1 pr-3 font-semibold">Month</th>
                {VISIT_CLASSES.map((c) => (
                  <th key={c} className="py-1 pr-3 text-right font-semibold">
                    {VISIT_CLASS_LABEL[c]}
                  </th>
                ))}
                <th className="py-1 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody className="font-mono">
              {points.map((p) => (
                <tr key={p.key} className="border-t border-[color:var(--color-brand-bg-mid)]">
                  <td className="py-1 pr-3 font-sans">
                    <Link
                      href={trendMonthHref(p, view)}
                      className="text-[color:var(--color-brand-cyan)] hover:underline"
                    >
                      {monthName(p)}
                    </Link>
                  </td>
                  {VISIT_CLASSES.map((c) => (
                    <td key={c} className="py-1 pr-3 text-right">
                      {PHP.format(p[c])}
                    </td>
                  ))}
                  <td className="py-1 text-right font-semibold">{PHP.format(total(p))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}
