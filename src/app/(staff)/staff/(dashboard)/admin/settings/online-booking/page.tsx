import Link from "next/link";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { manilaDateTime } from "@/lib/dates/manila";
import { OnlineBookingSettings } from "./client";

export const metadata = { title: "Online Booking" };
export const dynamic = "force-dynamic";

export default async function OnlineBookingSettingsPage() {
  await requireAdminStaff();
  const admin = createAdminClient();

  const { data: settings } = await admin
    .from("booking_settings")
    .select("online_booking_paused, paused_message, updated_at")
    .eq("id", true)
    .maybeSingle();

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
          Online booking
        </h1>
        <p className="mt-1 max-w-2xl text-sm text-[color:var(--color-brand-text-soft)]">
          Pause the booking form on the website (drmed.ph/schedule) and in the patient portal. While
          paused, every &ldquo;Book&rdquo; button still works but leads patients to a notice asking
          them to call, text, or message reception instead. Bookings already made stay as they are,
          and reception can keep booking patients from{" "}
          <Link href="/staff/appointments" className="font-semibold underline hover:no-underline">
            Appointments
          </Link>{" "}
          → &ldquo;+ New appointment&rdquo;. Walk-ins and pre-registration are not affected.
        </p>
      </header>

      <OnlineBookingSettings
        paused={!!settings?.online_booking_paused}
        message={settings?.paused_message ?? null}
      />

      <p className="mt-6 text-xs text-[color:var(--color-brand-text-soft)]">
        {settings?.updated_at ? <>Last changed {manilaDateTime(settings.updated_at)}. </> : null}
        Every change here is recorded in the audit log.
      </p>
    </div>
  );
}
