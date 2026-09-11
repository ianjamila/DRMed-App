import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { formatPhp } from "@/lib/marketing/format";
import {
  STATUS_BADGE,
  STATUS_LABELS,
  type GiftCodeStatus,
} from "@/lib/gift-codes/labels";
import { giftCodeRefundEligibility } from "@/lib/gift-codes/refund";
import { CancelButton } from "./cancel-button";
import { RefundButton } from "./refund-button";

export const metadata = { title: "Gift code — staff" };

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function GiftCodeDetailPage({ params }: PageProps) {
  await requireAdminStaff();
  const { id } = await params;

  const admin = createAdminClient();
  const { data: code } = await admin
    .from("gift_codes")
    .select(
      "id, code, face_value_php, status, batch_label, notes, generated_at, generated_by, purchased_at, purchased_by_name, purchased_by_contact, sold_by, redeemed_at, redeemed_by, redeemed_visit_id, cancelled_at, cancelled_by, cancellation_reason, refunded_at, refunded_by, refund_reason",
    )
    .eq("id", id)
    .maybeSingle();
  if (!code) notFound();

  // Resolve staff names (FK is to auth.users; staff_profiles.id mirrors it).
  const staffIds = [
    code.generated_by,
    code.sold_by,
    code.redeemed_by,
    code.cancelled_by,
    code.refunded_by,
  ].filter((v): v is string => Boolean(v));
  const nameMap = new Map<string, string>();
  if (staffIds.length > 0) {
    const { data: profiles } = await admin
      .from("staff_profiles")
      .select("id, full_name")
      .in("id", staffIds);
    for (const p of profiles ?? []) nameMap.set(p.id, p.full_name);
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          <Link
            href="/staff/admin/gift-codes"
            className="hover:text-[color:var(--color-brand-navy)]"
          >
            ← Gift codes
          </Link>
        </p>
        <h1 className="mt-1 font-mono text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          {code.code}
        </h1>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <span
            className={`rounded-md px-2 py-0.5 text-xs font-semibold ${
              STATUS_BADGE[code.status as GiftCodeStatus]
            }`}
          >
            {STATUS_LABELS[code.status as GiftCodeStatus]}
          </span>
          <span className="text-lg font-semibold text-[color:var(--color-brand-navy)]">
            {formatPhp(code.face_value_php)}
          </span>
          {code.batch_label ? (
            <span className="text-xs text-[color:var(--color-brand-text-soft)]">
              Batch: <strong>{code.batch_label}</strong>
            </span>
          ) : null}
        </div>
      </header>

      <section className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <h2 className="font-heading text-sm font-extrabold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Lifecycle
        </h2>
        <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
          <Fact
            label="Generated"
            when={code.generated_at}
            who={code.generated_by ? nameMap.get(code.generated_by) : null}
          />
          <Fact
            label="Purchased"
            when={code.purchased_at}
            who={code.sold_by ? nameMap.get(code.sold_by) : null}
            extra={
              code.purchased_by_name
                ? `${code.purchased_by_name}${code.purchased_by_contact ? ` · ${code.purchased_by_contact}` : ""}`
                : null
            }
          />
          <Fact
            label="Redeemed"
            when={code.redeemed_at}
            who={code.redeemed_by ? nameMap.get(code.redeemed_by) : null}
            extra={
              code.redeemed_visit_id ? `Visit ${code.redeemed_visit_id}` : null
            }
          />
          <Fact
            label="Cancelled"
            when={code.cancelled_at}
            who={code.cancelled_by ? nameMap.get(code.cancelled_by) : null}
            extra={code.cancellation_reason}
          />
          <Fact
            label="Last refunded"
            when={code.refunded_at}
            who={code.refunded_by ? nameMap.get(code.refunded_by) : null}
            extra={code.refund_reason}
          />
        </dl>

        {code.notes ? (
          <div className="mt-6">
            <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
              Notes
            </p>
            <p className="mt-1 text-sm text-[color:var(--color-brand-text-mid)]">
              {code.notes}
            </p>
          </div>
        ) : null}

        {giftCodeRefundEligibility(code.status as GiftCodeStatus).ok ? (
          <div className="mt-6 border-t border-[color:var(--color-brand-bg-mid)] pt-4">
            <p className="mb-2 text-xs text-[color:var(--color-brand-text-soft)]">
              Sale mis-keyed and the code hasn&apos;t been redeemed yet?
              Refunding reverses the payment and puts the code back in
              inventory to sell again. Reception can also do this from
              Front desk → Refund gift code sale.
            </p>
            <RefundButton code={code.code} />
          </div>
        ) : null}

        {code.status !== "redeemed" && code.status !== "cancelled" ? (
          <div className="mt-6 border-t border-[color:var(--color-brand-bg-mid)] pt-4">
            <p className="mb-2 text-xs text-[color:var(--color-brand-text-soft)]">
              Cancelling is permanent — the code can never be sold or
              redeemed again. Prefer Refund above when the code just needs
              to go back on sale.
            </p>
            <CancelButton giftCodeId={code.id} />
          </div>
        ) : null}
      </section>
    </div>
  );
}

function Fact({
  label,
  when,
  who,
  extra,
}: {
  label: string;
  when: string | null;
  who?: string | null;
  extra?: string | null;
}) {
  return (
    <div>
      <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
        {label}
      </dt>
      <dd className="mt-0.5">
        {when ? (
          <>
            <p className="font-semibold text-[color:var(--color-brand-navy)]">
              {new Intl.DateTimeFormat("en-PH", {
                timeZone: "Asia/Manila",
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "numeric",
                minute: "2-digit",
              }).format(new Date(when))}
            </p>
            {who ? (
              <p className="text-xs text-[color:var(--color-brand-text-soft)]">
                by {who}
              </p>
            ) : null}
            {extra ? (
              <p className="mt-0.5 text-xs text-[color:var(--color-brand-text-mid)]">
                {extra}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-[color:var(--color-brand-text-soft)]">—</p>
        )}
      </dd>
    </div>
  );
}
