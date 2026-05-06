import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { InquiryForm } from "../../inquiry-form";
import type { InquiryChannel } from "@/lib/inquiries/labels";

export const metadata = { title: "Edit inquiry — staff" };

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EditInquiryPage({ params }: PageProps) {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    redirect("/staff");
  }

  const { id } = await params;
  const supabase = await createClient();

  const { data: inquiry } = await supabase
    .from("inquiries")
    .select(
      "id, caller_name, contact, channel, service_interest, called_at, received_by_id, status, drop_reason, notes, linked_appointment_id, linked_visit_id",
    )
    .eq("id", id)
    .maybeSingle();
  if (!inquiry) notFound();

  const { data: staff } = await supabase
    .from("staff_profiles")
    .select("id, full_name, is_active, role")
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
          <Link
            href="/staff/inquiries"
            className="hover:text-[color:var(--color-brand-navy)]"
          >
            ← Inquiries
          </Link>
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          {inquiry.caller_name}
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          {inquiry.contact}
        </p>
      </header>

      <InquiryForm
        initial={{
          id: inquiry.id,
          caller_name: inquiry.caller_name,
          contact: inquiry.contact,
          channel: inquiry.channel as InquiryChannel,
          service_interest: inquiry.service_interest,
          called_at: inquiry.called_at,
          received_by_id: inquiry.received_by_id,
          status: inquiry.status as "pending" | "confirmed" | "dropped",
          drop_reason: inquiry.drop_reason,
          notes: inquiry.notes,
          linked_appointment_id: inquiry.linked_appointment_id,
          linked_visit_id: inquiry.linked_visit_id,
        }}
        staffOptions={staffOptions}
      />
    </div>
  );
}
