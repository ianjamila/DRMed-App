import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { formatPhp } from "@/lib/marketing/format";
import { PaymentForm } from "./payment-form";

export const metadata = {
  title: "Record payment — staff",
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
        id, visit_number, total_php, paid_php, payment_status,
        patients!inner ( id, drm_id, first_name, last_name )
      `,
    )
    .eq("id", visit_id)
    .maybeSingle();

  if (!visit) {
    redirect("/staff/patients");
  }
  const patient = Array.isArray(visit.patients) ? visit.patients[0] : visit.patients;
  if (!patient) {
    redirect("/staff/patients");
  }

  const balance = Math.max(0, Number(visit.total_php) - Number(visit.paid_php));

  return (
    <div className="mx-auto max-w-xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href={`/staff/visits/${visit.id}`}
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Visit #{visit.visit_number}
      </Link>
      <h1 className="mt-3 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
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

      <div className="mt-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <PaymentForm visitId={visit.id} balance={balance} />
      </div>
    </div>
  );
}
