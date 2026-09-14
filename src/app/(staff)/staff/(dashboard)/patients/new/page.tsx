import Link from "next/link";
import { PatientForm } from "../patient-form";
import { listActiveReferralSources } from "@/lib/legacy-import/loaders";
import { Panel } from "@/components/ui/panel";

export const metadata = {
  title: "New patient — staff",
};

export default async function NewPatientPage() {
  const sources = await listActiveReferralSources();
  const referralOptions = [
    { value: "", label: "—" },
    ...sources.map((s) => ({ value: s.id, label: s.label })),
  ];

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        href="/staff/patients"
        className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
      >
        ← Patients
      </Link>
      <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            New patient
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
            DRM-ID is auto-generated on save. After creation you can start a visit.
          </p>
        </div>
        <Link
          href="/staff/patients/consent/print"
          target="_blank"
          rel="noopener"
          className="shrink-0 rounded-md border border-[color:var(--color-brand-navy)] px-4 py-2 text-sm font-bold text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
        >
          Print consent form
        </Link>
      </div>
      <Panel className="mt-8 p-6">
        <PatientForm referralOptions={referralOptions} />
      </Panel>
    </div>
  );
}
