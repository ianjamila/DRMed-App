import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatPhp } from "@/lib/marketing/format";
import { PaymentForm } from "./payment-form";
import { Panel } from "@/components/ui/panel";

export const metadata = {
  title: "Record payment",
};

interface Props {
  searchParams: Promise<{ visit_id?: string }>;
}

export default async function NewPaymentPage({ searchParams }: Props) {
  const { visit_id } = await searchParams;
  if (!visit_id) {
    redirect("/staff/patients");
  }

  const supabase = await createClient();
  const { data: visit } = await supabase
    .from("visits")
    .select(
      `
        id, visit_number, total_php, paid_php, payment_status, hmo_provider_id,
        patients!inner ( id, drm_id, first_name, last_name ),
        hmo_providers ( name )
      `,
    )
    .eq("id", visit_id)
    // Payments against deleted visits are blocked in the DB (P0045) — don't
    // offer the form in the first place.
    .is("deleted_at", null)
    .maybeSingle();

  if (!visit) {
    redirect("/staff/patients");
  }
  const patient = Array.isArray(visit.patients) ? visit.patients[0] : visit.patients;
  if (!patient) {
    redirect("/staff/patients");
  }
  // PostgREST returns an embedded row as either an object or a one-element
  // array depending on the join shape — handle both (mirrors patient-ar's
  // pluckProviderName).
  const hmoProviderRow = Array.isArray(visit.hmo_providers)
    ? visit.hmo_providers[0]
    : visit.hmo_providers;
  const hmoProviderName = hmoProviderRow?.name ?? null;

  const balance = Math.max(0, Number(visit.total_php) - Number(visit.paid_php));

  return (
    <div className="mx-auto max-w-xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href={`/staff/visits/${visit.id}`}
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Visit #{visit.visit_number}
      </Link>
      <h1 className="mt-3 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        Record payment
      </h1>
      <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
        {patient.last_name}, {patient.first_name} ({patient.drm_id})
      </p>

      <div className="mt-6 grid gap-2 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-[color:var(--color-brand-bg)] p-4 text-sm sm:grid-cols-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Total
          </p>
          <p className="font-semibold">{formatPhp(visit.total_php)}</p>
        </div>
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Paid
          </p>
          <p className="font-semibold">{formatPhp(visit.paid_php)}</p>
        </div>
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
            Balance
          </p>
          <p
            className={
              balance > 0
                ? "font-semibold text-red-600"
                : "font-semibold text-emerald-700"
            }
          >
            {formatPhp(balance)}
          </p>
        </div>
      </div>

      {/*
        HMO warning, not a block. An HMO claim that comes back "Bill patient"
        legitimately moves the amount to the patient, and visits.hmo_provider_id
        is never cleared when that happens (owner decision 2026-09-15) — so
        redirecting or disabling the form here would strand a real collection
        reception needs to take. This just tells staff to check first.
      */}
      {visit.hmo_provider_id != null ? (
        <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p className="font-bold uppercase tracking-wider text-xs">
            HMO-billed visit
          </p>
          <p className="mt-1">
            This balance is owed by{" "}
            <span className="font-semibold">
              {hmoProviderName ?? "the patient's HMO"}
            </span>{" "}
            and is normally settled through HMO claims, not at the counter.
            Record a payment here only if the claim was resolved as
            &ldquo;Bill patient.&rdquo;
          </p>
        </div>
      ) : null}

      <Panel className="mt-6 p-6">
        <PaymentForm visitId={visit.id} balance={balance} />
      </Panel>
    </div>
  );
}
