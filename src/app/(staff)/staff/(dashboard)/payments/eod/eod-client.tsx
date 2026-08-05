"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { closeEodAction } from "../cash-drawer/actions";
import { reopenEodCloseAction } from "@/app/(staff)/staff/(dashboard)/admin/accounting/cash-routing/actions";
import { PaymentsTabs } from "../_components/payments-tabs";
import {
  BILL_DENOMINATIONS,
  COIN_DENOMINATIONS,
  CASH_DENOMINATIONS,
  denominationsTotal,
  parseDenominations,
  type CashDenomination,
  type DenominationCounts,
  type DenominationKey,
} from "@/lib/accounting/cash-denominations";

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);

const formatBusinessDate = (isoDate: string) => {
  const d = new Date(`${isoDate}T12:00:00+08:00`);
  const longDate = new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "Asia/Manila",
  }).format(d);
  const weekday = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    timeZone: "Asia/Manila",
  }).format(d);
  return `${longDate} · ${weekday}`;
};

/** Raw text per row, so a half-typed "1" doesn't get coerced mid-keystroke. */
type CountDrafts = Partial<Record<DenominationKey, string>>;

function draftsToCounts(drafts: CountDrafts): DenominationCounts {
  const counts: DenominationCounts = {};
  for (const d of CASH_DENOMINATIONS) {
    const pieces = Number(drafts[d.key] ?? "");
    if (Number.isFinite(pieces) && pieces > 0) counts[d.key] = Math.trunc(pieces);
  }
  return counts;
}

function DenominationColumn({
  title,
  rows,
  drafts,
  onChange,
  disabled,
}: {
  title: string;
  rows: readonly CashDenomination[];
  drafts: CountDrafts;
  onChange: (key: DenominationKey, value: string) => void;
  disabled: boolean;
}) {
  return (
    <div>
      <h2 className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-steel)]">
        {title}
      </h2>
      <ul className="mt-2 space-y-1.5">
        {rows.map((d) => {
          const pieces = Number(drafts[d.key] ?? "");
          const subtotal = Number.isFinite(pieces) && pieces > 0 ? pieces * d.value_php : 0;
          return (
            <li key={d.key} className="flex items-center gap-2">
              <label
                htmlFor={`count-${d.key}`}
                className="w-16 shrink-0 text-sm font-medium tabular-nums"
              >
                {d.label}
              </label>
              <input
                id={`count-${d.key}`}
                name={d.key}
                value={drafts[d.key] ?? ""}
                onChange={(e) => onChange(d.key, e.target.value)}
                disabled={disabled}
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="off"
                aria-label={`${d.full_label} — how many pieces`}
                placeholder="0"
                className="min-h-[44px] w-16 rounded border px-2 py-2 text-right font-mono"
              />
              {/* Line subtotal, shown only once the row carries a count. */}
              <span className="min-w-0 flex-1 truncate text-right font-mono text-xs text-[color:var(--color-brand-text-soft)]">
                {subtotal > 0 ? PESO(subtotal) : ""}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The 11-row breakdown of a recorded close, zero rows folded away. */
function ClosedBreakdown({ counts }: { counts: DenominationCounts | null }) {
  if (!counts) {
    return (
      <p className="mt-3 text-sm italic text-[color:var(--color-brand-text-soft)]">
        Denomination count not recorded — this day was closed before the count sheet existed.
      </p>
    );
  }

  const present = CASH_DENOMINATIONS.filter((d) => (counts[d.key] ?? 0) > 0);
  if (present.length === 0) {
    return (
      <p className="mt-3 text-sm italic text-[color:var(--color-brand-text-soft)]">
        Counted as an empty till — no bills or coins recorded.
      </p>
    );
  }

  return (
    <div className="mt-3">
      <h3 className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-steel)]">
        How it was counted
      </h3>
      <table className="mt-1.5 w-full text-sm">
        <thead className="sr-only">
          <tr>
            <th scope="col">Denomination</th>
            <th scope="col">Pieces</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          {present.map((d) => (
            <tr key={d.key}>
              <td className="py-0.5">{d.full_label}</td>
              <td className="py-0.5 text-right font-mono tabular-nums">
                ×{counts[d.key]}
              </td>
              <td className="py-0.5 text-right font-mono tabular-nums">
                {PESO((counts[d.key] ?? 0) * d.value_php)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EodClient(props: {
  isAdmin: boolean;
  businessDate: string;
  shiftId: string;
  state: Record<string, unknown>;
}) {
  const router = useRouter();
  const s = props.state as {
    opening_float_php?: number;
    cash_payments_php?: number;
    cash_payouts_php?: number;
    expected_cash_php?: number;
    closed?: {
      id: string;
      closed_at: string;
      closed_by: string;
      counted_cash_php: number;
      expected_cash_php: number;
      variance_php: number;
      variance_reason: string | null;
      counted_denominations: unknown;
    } | null;
  };
  const expected = Number(s.expected_cash_php ?? 0);
  const [drafts, setDrafts] = useState<CountDrafts>({});
  const [reason, setReason] = useState("");
  const [pending, start] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const closed = s.closed;

  const counts = useMemo(() => draftsToCounts(drafts), [drafts]);
  // Display only — the action re-derives the total from the same module, and
  // the P0048 guard re-checks it in the database.
  const counted = useMemo(() => denominationsTotal(counts), [counts]);
  // "Close day" needs SOMETHING entered, mirroring the old `!counted` guard. An
  // all-zeros count is allowed once a row has been touched: it lands as a large
  // difference, which already forces a reason.
  const anyEntered = useMemo(
    () => CASH_DENOMINATIONS.some((d) => (drafts[d.key] ?? "").trim() !== ""),
    [drafts],
  );
  const variance = anyEntered ? counted - expected : 0;

  const closedCounts = useMemo(
    () => parseDenominations(closed?.counted_denominations),
    [closed?.counted_denominations],
  );

  const onCountChange = (key: DenominationKey, value: string) => {
    // Digits only — pieces are whole. Empty stays empty so the field can clear.
    const digits = value.replace(/[^0-9]/g, "").replace(/^0+(?=\d)/, "");
    setDrafts((prev) => ({ ...prev, [key]: digits }));
  };

  const onClose = () => {
    setErr(null);
    start(async () => {
      const r = await closeEodAction(
        props.businessDate,
        props.shiftId,
        counts,
        variance === 0 ? null : reason,
      );
      if (!r.ok) setErr(r.error);
      else router.refresh();
    });
  };

  const onReopen = () => {
    if (!closed) return;
    const reopen = window.prompt("Why are you re-opening this day?");
    if (!reopen) return;
    start(async () => {
      const r = await reopenEodCloseAction(closed.id, reopen);
      if (!r.ok) alert(r.error);
      else router.refresh();
    });
  };

  return (
    <main className="mx-auto max-w-2xl px-4 py-6 sm:px-6">
      <PaymentsTabs />
      <h1 className="font-heading text-2xl font-extrabold text-[color:var(--color-brand-navy)]">
        Close &amp; count cash · {formatBusinessDate(props.businessDate)}
      </h1>

      {closed ? (
        <Alert variant="success" className="mt-5">
          <AlertTitle>
            ✓ Day closed at {new Date(closed.closed_at).toLocaleString("en-PH", { timeZone: "Asia/Manila" })}
          </AlertTitle>
          <AlertDescription>
            <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
              <dt>Cash you should have</dt><dd className="font-mono text-right">{PESO(closed.expected_cash_php)}</dd>
              <dt>Cash counted</dt><dd className="font-mono text-right">{PESO(closed.counted_cash_php)}</dd>
              <dt>Difference (over / short)</dt><dd className="font-mono text-right">{PESO(closed.variance_php)}</dd>
            </dl>
            {closed.variance_reason && (
              <p className="mt-2 text-sm italic text-[color:var(--color-brand-text-soft)]">&ldquo;{closed.variance_reason}&rdquo;</p>
            )}

            <ClosedBreakdown counts={closedCounts} />

            <div className="mt-4 flex flex-wrap gap-2">
              <a
                href={`/staff/payments/eod/${closed.id}/count-sheet`}
                className="min-h-[44px] rounded border px-4 py-2 text-sm"
              >
                Print count sheet
              </a>
              {props.isAdmin && (
                <button onClick={onReopen} disabled={pending} className="min-h-[44px] rounded border px-4 py-2 text-sm">
                  Re-open this day
                </button>
              )}
            </div>
          </AlertDescription>
        </Alert>
      ) : (
        <section className="mt-5 rounded-lg border bg-white p-4 shadow-sm">
          <div className="flex justify-between text-sm">
            <strong>Cash you should have</strong>
            <span className="font-mono text-lg">{PESO(expected)}</span>
          </div>
          <p className="mt-1 text-xs text-[color:var(--color-brand-text-soft)]">
            = starting cash {PESO(Number(s.opening_float_php ?? 0))} + cash received {PESO(Number(s.cash_payments_php ?? 0))} − cash paid out {PESO(Number(s.cash_payouts_php ?? 0))}
          </p>

          <fieldset className="mt-4 border-t pt-4" disabled={pending}>
            <legend className="text-sm font-semibold">Count the till</legend>
            <p className="text-xs text-[color:var(--color-brand-text-soft)]">
              Type how many pieces you have of each. Leave a row blank if you have none.
              The ₱20 bill and the ₱20 coin are counted separately.
            </p>
            <div className="mt-3 grid grid-cols-1 gap-x-6 gap-y-5 sm:grid-cols-2">
              <DenominationColumn
                title="Bills"
                rows={BILL_DENOMINATIONS}
                drafts={drafts}
                onChange={onCountChange}
                disabled={pending}
              />
              <DenominationColumn
                title="Coins"
                rows={COIN_DENOMINATIONS}
                drafts={drafts}
                onChange={onCountChange}
                disabled={pending}
              />
            </div>
          </fieldset>

          <div className="mt-4 flex justify-between border-t pt-3 text-sm">
            <strong>Cash you actually counted</strong>
            <output className="font-mono text-lg" aria-live="polite">{PESO(counted)}</output>
          </div>

          <div className="mt-2 flex justify-between text-sm">
            <strong>Difference (over / short)</strong>
            <output
              aria-live="polite"
              className={"font-mono " + (variance < 0 ? "text-red-600" : variance > 0 ? "text-amber-600" : "")}
            >
              {PESO(variance)}
            </output>
          </div>

          {variance !== 0 && (
            <label className="mt-3 block text-sm">
              Reason for the difference (required)
              <input value={reason} onChange={(e) => setReason(e.target.value)} className="mt-1 block w-full rounded border px-2 py-2" />
            </label>
          )}

          {err && <p className="mt-3 text-sm text-red-600">{err}</p>}

          <div className="mt-5 flex flex-wrap gap-2">
            <a href={`/staff/payments/cash-drawer?date=${props.businessDate}&shift=${props.shiftId}`} className="min-h-[44px] rounded border px-4 py-2 text-sm">Back to cash drawer</a>
            <button
              onClick={onClose}
              disabled={pending || !anyEntered || (variance !== 0 && !reason)}
              className="min-h-[44px] rounded bg-[color:var(--color-brand-cyan)] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
            >
              {pending ? "Closing…" : "Close day"}
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
