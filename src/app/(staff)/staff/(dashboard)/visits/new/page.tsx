import Link from "next/link";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { patientSearchOrClauses } from "@/lib/patients/search";
import { VisitForm } from "./visit-form";
import { PatientsSearchInput } from "../../patients/search-input";
import { VisitsTabs } from "../_components/visits-tabs";
import { Panel } from "@/components/ui/panel";

export const metadata = {
  title: "New visit — staff",
};

interface Props {
  searchParams: Promise<{ patient_id?: string; q?: string }>;
}

const PICKER_LIMIT = 25;

export default async function NewVisitPage({ searchParams }: Props) {
  const { patient_id, q } = await searchParams;

  if (!patient_id) {
    return <PatientPicker query={q ?? ""} />;
  }

  const supabase = await createClient();

  const admin = createAdminClient();
  const [{ data: patient }, { data: services }, { data: hmoProviders }, { data: physicians }] =
    await Promise.all([
      supabase
        .from("patients")
        .select("id, drm_id, first_name, last_name")
        .eq("id", patient_id)
        .maybeSingle(),
      supabase
        .from("services")
        .select(
          "id, code, name, kind, price_php, hmo_price_php, senior_discount_php, senior_pwd_eligible",
        )
        .eq("is_active", true)
        .order("name", { ascending: true }),
      supabase
        .from("hmo_providers")
        .select("id, name")
        .eq("is_active", true)
        .order("name", { ascending: true }),
      admin
        .from("physicians")
        .select("id, full_name, specialty, compensation_arrangement, is_active")
        .eq("is_active", true)
        .order("full_name", { ascending: true }),
    ]);

  if (!patient) {
    redirect("/staff/visits/new");
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href={`/staff/patients/${patient.id}`}
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Patient
      </Link>
      <h1 className="mt-3 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
        New visit
      </h1>
      <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
        Visit number is auto-generated. PIN will be shown on the printed
        receipt.
      </p>

      <Panel className="mt-8 p-6">
        <VisitForm
          patient={patient}
          services={(services ?? []).map((s) => ({
            id: s.id,
            code: s.code,
            name: s.name,
            kind: s.kind,
            price_php: Number(s.price_php),
            hmo_price_php: s.hmo_price_php != null ? Number(s.hmo_price_php) : null,
            senior_discount_php:
              s.senior_discount_php != null ? Number(s.senior_discount_php) : null,
            senior_pwd_eligible: s.senior_pwd_eligible,
          }))}
          hmoProviders={hmoProviders ?? []}
          physicians={(physicians ?? []).map((p) => ({
            id: p.id,
            full_name: p.full_name,
            specialty: p.specialty,
            compensation_arrangement: p.compensation_arrangement,
          }))}
        />
      </Panel>
    </div>
  );
}

async function PatientPicker({ query }: { query: string }) {
  const supabase = await createClient();

  let q = supabase
    .from("patients")
    .select("id, drm_id, first_name, last_name, phone")
    .order("created_at", { ascending: false })
    .limit(PICKER_LIMIT);

  // Token-based: every word must match some field (any order), so "Jamila, Ian"
  // finds a patient stored as first_name="Ian", last_name="Jamila".
  for (const clause of patientSearchOrClauses(query)) {
    q = q.or(clause);
  }

  const { data: patients } = await q;
  const rows = patients ?? [];

  return (
    <div className="mx-auto max-w-screen-2xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            Visits
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
            Pick the patient this visit is for, or register a new one.
          </p>
        </div>
        <Link
          href="/staff/patients/new"
          className="min-h-11 rounded-md bg-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-white hover:bg-[color:var(--color-brand-cyan)]"
        >
          + New patient
        </Link>
      </header>

      <div className="mb-6"><VisitsTabs /></div>

      <div className="mb-4">
        <PatientsSearchInput initialQuery={query} />
      </div>

      <Panel className="overflow-hidden">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-[color:var(--color-brand-text-soft)]">
            {query.trim()
              ? "No patients match. Try a different search or register a new patient."
              : "Start typing to search by DRM-ID, name, or phone."}
          </p>
        ) : (
          <ul className="divide-y divide-[color:var(--color-brand-bg-mid)]">
            {rows.map((p) => {
              const name =
                `${p.last_name ?? ""}${p.last_name && p.first_name ? ", " : ""}${p.first_name ?? ""}`.trim() ||
                "(no name on file)";
              return (
                <li key={p.id}>
                  <Link
                    href={`/staff/visits/new?patient_id=${p.id}`}
                    className="flex items-center justify-between gap-3 px-4 py-3 transition-colors hover:bg-[color:var(--color-brand-bg)]"
                  >
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-[color:var(--color-brand-navy)]">
                        {name}
                      </p>
                      <p className="truncate text-xs text-[color:var(--color-brand-text-soft)]">
                        <span className="font-mono">{p.drm_id}</span>
                        {p.phone ? ` · ${p.phone}` : ""}
                      </p>
                    </div>
                    <span className="shrink-0 text-sm font-medium text-[color:var(--color-brand-cyan)]">
                      Start visit →
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      {rows.length === PICKER_LIMIT ? (
        <p className="mt-3 text-xs text-[color:var(--color-brand-text-soft)]">
          Showing first {PICKER_LIMIT} matches. Refine the search to narrow down.
        </p>
      ) : null}
    </div>
  );
}
