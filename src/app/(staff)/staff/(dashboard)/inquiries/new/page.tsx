import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { InquiryForm } from "../inquiry-form";

export const metadata = { title: "New inquiry — staff" };

export const dynamic = "force-dynamic";

export default async function NewInquiryPage() {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    redirect("/staff");
  }

  const supabase = await createClient();
  const { data: staff } = await supabase
    .from("staff_profiles")
    .select("id, full_name, role, is_active")
    .eq("is_active", true)
    .in("role", ["reception", "admin"])
    .order("full_name", { ascending: true });

  const staffOptions = (staff ?? []).map((s) => ({
    id: s.id,
    full_name: s.full_name,
  }));

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 10 · Reception
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          New inquiry
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Capture inbound phone leads, FB messages, and walk-up questions
          before they turn into a booking.
        </p>
      </header>

      <InquiryForm
        staffOptions={staffOptions}
        defaultReceivedById={session.user_id}
      />
    </div>
  );
}
