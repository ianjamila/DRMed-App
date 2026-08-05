import Link from "next/link";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { audit } from "@/lib/audit/log";
import { CONTACT, SITE } from "@/lib/marketing/site";
import {
  BILL_DENOMINATIONS,
  COIN_DENOMINATIONS,
  parseDenominations,
  type CashDenomination,
  type DenominationCounts,
} from "@/lib/accounting/cash-denominations";
import { PrintButton } from "./print-button";

export const metadata = { title: "Cash count sheet — staff" };
export const dynamic = "force-dynamic";

const PESO = (n: number) =>
  new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP" }).format(n);

const formatBusinessDate = (isoDate: string) =>
  new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "Asia/Manila",
  }).format(new Date(`${isoDate}T12:00:00+08:00`));

function DenominationBlock({
  title,
  rows,
  counts,
}: {
  title: string;
  rows: readonly CashDenomination[];
  counts: DenominationCounts;
}) {
  return (
    <div>
      <h3 className="text-[10px] font-bold uppercase tracking-wider text-[color:var(--color-brand-steel)]">
        {title}
      </h3>
      <table className="mt-1 w-full text-[11px]">
        <thead>
          <tr className="border-b border-[color:var(--color-brand-bg-mid)] text-[9px] uppercase tracking-wide text-[color:var(--color-brand-text-soft)]">
            <th scope="col" className="py-0.5 text-left font-medium">
              Denom.
            </th>
            <th scope="col" className="py-0.5 text-right font-medium">
              Pieces
            </th>
            <th scope="col" className="py-0.5 text-right font-medium">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const pieces = counts[d.key] ?? 0;
            return (
              <tr key={d.key} className="border-b border-dashed border-[color:var(--color-brand-bg-mid)]">
                <td className="py-0.5">{d.label}</td>
                <td className="py-0.5 text-right font-mono tabular-nums">{pieces || "—"}</td>
                <td className="py-0.5 text-right font-mono tabular-nums">
                  {pieces ? PESO(pieces * d.value_php) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default async function CashCountSheetPage({
  params,
}: {
  params: Promise<{ closeId: string }>;
}) {
  // Same gate as the EOD page itself, NOT the bare any-staff gate the consent
  // print page uses: a till count is cash data, and its audience is exactly the
  // audience of the screen it is printed from.
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") redirect("/staff");

  const { closeId } = await params;
  const admin = createAdminClient();

  const { data: close } = await admin
    .from("eod_close_records")
    .select(
      "id, business_date, shift_id, status, expected_cash_php, counted_cash_php, variance_php, variance_reason, counted_denominations, closed_at, closed_by",
    )
    .eq("id", closeId)
    .maybeSingle();
  if (!close) notFound();

  const [{ data: closer }, { data: shift }] = await Promise.all([
    admin.from("staff_profiles").select("full_name").eq("id", close.closed_by).maybeSingle(),
    admin.from("cash_shifts").select("label").eq("id", close.shift_id).maybeSingle(),
  ]);

  // Viewing a till count is an access event on cash data — audited like the
  // other cash and print surfaces.
  const h = await headers();
  await audit({
    actor_id: session.user_id,
    actor_type: "staff",
    action: "eod_close.count_sheet_viewed",
    resource_type: "eod_close_records",
    resource_id: close.id,
    metadata: {
      business_date: close.business_date,
      shift_id: close.shift_id,
      status: close.status,
    },
    ip_address: h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    user_agent: h.get("user-agent"),
  });

  const counts = parseDenominations(close.counted_denominations);
  const variance = Number(close.variance_php);

  return (
    <div className="cash-count-print mx-auto max-w-md px-4 py-8 sm:px-6 print:p-0">
      <div className="mb-4 flex items-center justify-between gap-2 print:hidden">
        <Link
          href={`/staff/payments/eod?date=${close.business_date}&shift=${close.shift_id}`}
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← End of day
        </Link>
        <PrintButton />
      </div>

      <article className="cash-count-sheet relative rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6 print:border-0 print:p-0">
        {/* Decorative watermark only — the same fact is stated in words under
            the title, so hide this from screen readers rather than have them
            announce "Reopened" adrift from any context. */}
        {close.status === "reopened" && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 flex items-center justify-center text-5xl font-extrabold uppercase tracking-widest text-[color:var(--color-brand-bg-mid)] opacity-60"
          >
            Reopened
          </span>
        )}

        <header className="border-b border-[color:var(--color-brand-bg-mid)] pb-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- plain img prints reliably */}
          <img src="/logo.png" alt="DRMed" className="mb-1 h-10 w-auto print:h-8" />
          <p className="font-heading text-lg font-extrabold text-[color:var(--color-brand-navy)] print:text-base">
            {SITE.name}
          </p>
          <p className="text-[10px] text-[color:var(--color-brand-text-soft)]">
            {CONTACT.address.full}
          </p>
        </header>

        <h1 className="mt-3 text-base font-extrabold text-[color:var(--color-brand-navy)]">
          End-of-day cash count
        </h1>
        <p className="text-[11px] text-[color:var(--color-brand-text-soft)]">
          {formatBusinessDate(close.business_date)} · {shift?.label ?? "Shift"}
          {close.status === "reopened" && (
            <> · <b className="text-[color:var(--color-brand-navy)]">this close was re-opened</b></>
          )}
        </p>

        {counts ? (
          <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3">
            <DenominationBlock title="Bills" rows={BILL_DENOMINATIONS} counts={counts} />
            <DenominationBlock title="Coins" rows={COIN_DENOMINATIONS} counts={counts} />
          </div>
        ) : (
          <p className="mt-4 rounded border border-dashed border-[color:var(--color-brand-bg-mid)] p-3 text-[11px] italic text-[color:var(--color-brand-text-soft)]">
            Denomination count not recorded — this day was closed before the count sheet
            existed. Totals only.
          </p>
        )}

        <dl className="mt-4 space-y-1 border-t border-[color:var(--color-brand-bg-mid)] pt-3 text-xs">
          <div className="flex justify-between">
            <dt>Cash counted</dt>
            <dd className="font-mono font-bold tabular-nums">
              {PESO(Number(close.counted_cash_php))}
            </dd>
          </div>
          <div className="flex justify-between">
            <dt>Cash you should have</dt>
            <dd className="font-mono tabular-nums">{PESO(Number(close.expected_cash_php))}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Difference (over / short)</dt>
            <dd className="font-mono tabular-nums">{PESO(variance)}</dd>
          </div>
        </dl>

        {close.variance_reason && (
          <p className="mt-2 text-[11px] italic text-[color:var(--color-brand-text-soft)]">
            Reason: &ldquo;{close.variance_reason}&rdquo;
          </p>
        )}

        <p className="mt-3 text-[10px] text-[color:var(--color-brand-text-soft)]">
          Closed by {closer?.full_name ?? "—"} at{" "}
          {new Date(close.closed_at).toLocaleString("en-PH", { timeZone: "Asia/Manila" })}
        </p>

        <div className="mt-8 flex gap-6">
          <div className="flex-1 border-t border-[color:var(--color-brand-navy)] pt-1 text-[9px] uppercase text-[color:var(--color-brand-text-soft)]">
            Counted by — signature over printed name
          </div>
          <div className="flex-1 border-t border-[color:var(--color-brand-navy)] pt-1 text-[9px] uppercase text-[color:var(--color-brand-text-soft)]">
            Witness — signature over printed name
          </div>
        </div>
      </article>
    </div>
  );
}
