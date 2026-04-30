import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { VisitForm } from "./visit-form";

export const metadata = {
  title: "New visit — staff",
};

interface Props {
  searchParams: Promise<{ patient_id?: string }>;
}

export default async function NewVisitPage({ searchParams }: Props) {
  const { patient_id } = await searchParams;
  if (!patient_id) {
    redirect("/staff/patients");
  }

  const supabase = await createClient();

  const [{ data: patient }, { data: services }] = await Promise.all([
    supabase
      .from("patients")
      .select("id, drm_id, first_name, last_name")
      .eq("id", patient_id)
      .maybeSingle(),
    supabase
      .from("services")
      .select("id, code, name, price_php")
      .eq("is_active", true)
      .order("name", { ascending: true }),
  ]);

  if (!patient) {
    redirect("/staff/patients");
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href={`/staff/patients/${patient.id}`}
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Patient
      </Link>
      <h1 className="mt-3 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        New visit
      </h1>
      <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
        Visit number is auto-generated. PIN will be shown on the printed
        receipt.
      </p>

      <div className="mt-8 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <VisitForm patient={patient} services={services ?? []} />
      </div>
    </div>
  );
}
