import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { ConsentGateToggle } from "./client";

export const metadata = { title: "Consent gate — staff" };
export const dynamic = "force-dynamic";

export default async function ConsentGateSettingsPage() {
  await requireAdminStaff();
  const admin = createAdminClient();

  const { data: settings } = await admin
    .from("consent_settings")
    .select("gate_required")
    .eq("id", true)
    .maybeSingle();
  const enabled = !!settings?.gate_required;

  // How many active patients would be blocked right now (no current consent on
  // file). Exclude merged tombstones so the number matches the pre-flight
  // report the admin is being pointed at.
  const { count } = await admin
    .from("patients")
    .select("id", { count: "exact", head: true })
    .eq("consent_current", false)
    .is("merged_into_id", null);
  const blockedCount = count ?? 0;

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <Link
          href="/staff"
          className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)] hover:underline"
        >
          ← Dashboard
        </Link>
        <h1 className="mt-3 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Data privacy consent gate
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          When ON, a lab result cannot be released for a patient who has no
          data-privacy consent on file (RA 10173). This is enforced at the
          database level, not just here. Consent can be captured three ways —
          the printed consent form, an on-screen signature on the patient page,
          or the patient accepting the notice in their portal. Historical /
          backfilled results are unaffected.
        </p>
      </header>

      {blockedCount > 0 ? (
        <p className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          {blockedCount} active{" "}
          {blockedCount === 1 ? "patient lacks" : "patients lack"} consent —{" "}
          <Link
            href="/staff/admin/reports/patients-without-consent"
            className="font-semibold underline hover:no-underline"
          >
            review the list
          </Link>{" "}
          before enabling.
        </p>
      ) : null}

      <ConsentGateToggle enabled={enabled} blockedCount={blockedCount} />

      <p className="mt-4 text-xs text-[color:var(--color-brand-text-soft)]">
        Every change here is recorded in the audit log.
      </p>
    </div>
  );
}
