/**
 * Period controls shared by the Marketing reports (plan P13): preset pills and
 * a Custom range form. Every link and the form keep the page's other params
 * (mode, grain, channel), so changing the period never resets them. The form
 * is a plain GET, so it carries those params as hidden inputs (CLAUDE.md:
 * "a plain-GET filter form drops whatever it does not carry").
 */
import Link from "next/link";
import { buildMarketingPresets, periodHref } from "@/lib/marketing/period";

const pill =
  "min-h-[36px] rounded-full px-3 py-1.5 text-xs font-bold uppercase tracking-wider";
const pillOn = "bg-[color:var(--color-brand-navy)] text-white";
const pillOff =
  "border border-[color:var(--color-brand-bg-mid)] bg-white text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]";

export function PeriodControls({
  pathname,
  todayISO,
  from,
  to,
  presetKey,
  error,
  params,
}: {
  pathname: string;
  todayISO: string;
  from: string;
  to: string;
  presetKey: string | null;
  error: string | null;
  /** The page's other params to keep (mode, grain, channel…). */
  params: Readonly<Record<string, string | undefined>>;
}) {
  const presets = buildMarketingPresets(todayISO);
  const hidden = Object.entries(params).filter(([k, v]) => k !== "from" && k !== "to" && k !== "page" && v);
  return (
    <div className="mb-4 space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Period
        </span>
        {presets.map((p) => (
          <Link
            key={p.key}
            href={periodHref(pathname, params, { from: p.start, to: p.end, page: null })}
            className={`${pill} ${p.key === presetKey ? pillOn : pillOff}`}
          >
            {p.label}
          </Link>
        ))}
        <span className={`${pill} ${presetKey === null ? pillOn : pillOff}`}>Custom</span>
      </div>
      <form method="get" action={pathname} className="flex flex-wrap items-end gap-2 text-sm">
        {hidden.map(([k, v]) => (
          <input key={k} type="hidden" name={k} value={v} />
        ))}
        <label className="flex flex-col text-xs font-bold text-[color:var(--color-brand-text-soft)]">
          From
          <input type="date" name="from" defaultValue={from} required className="rounded border px-2 py-1 text-sm" />
        </label>
        <label className="flex flex-col text-xs font-bold text-[color:var(--color-brand-text-soft)]">
          To
          <input type="date" name="to" defaultValue={to} required className="rounded border px-2 py-1 text-sm" />
        </label>
        <button type="submit" className={`${pill} ${pillOff}`}>
          Show
        </button>
        <span className="text-xs text-[color:var(--color-brand-text-soft)]">Up to 400 days.</span>
      </form>
      {error ? (
        <p className="text-sm text-amber-700" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
