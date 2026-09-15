import Link from "next/link";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { ConsentFormSheet } from "@/components/consent/consent-form-sheet";
import { PrintButton } from "@/components/consent/print-button";

export const metadata = {
  title: "Consent form",
};

// Blank, unbound consent form for the counter: the new-patient registration
// form has no patient id yet, so this is what "Print consent form" on
// patients/new opens. Name/DRM-ID are left as ruled lines to fill in by hand,
// and reception matches the signed sheet back to the patient record afterward
// (see patient-form.tsx / consent-panel.tsx's "attach a scan" flow).
// No patient data is shown here, so unlike the bound [id]/consent/print
// route this does not write an audit row (see that route for the
// disclosure audit).
export default async function BlankConsentPrintPage() {
  await requireActiveStaff();

  return (
    <div className="consent-print mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8 print:p-0">
      <div className="mb-4 flex items-center justify-between gap-2 print:hidden">
        <Link
          href="/staff/patients/new"
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← New patient
        </Link>
        <PrintButton />
      </div>
      <ConsentFormSheet />
    </div>
  );
}
