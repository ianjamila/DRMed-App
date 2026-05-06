import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { BookFromInquiryForm } from "./book-form";

export const metadata = { title: "Book from inquiry — staff" };

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function BookFromInquiryPage({ params }: PageProps) {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    redirect("/staff");
  }

  const { id } = await params;
  const supabase = await createClient();

  const { data: inquiry } = await supabase
    .from("inquiries")
    .select(
      "id, caller_name, contact, channel, service_interest, status, linked_appointment_id",
    )
    .eq("id", id)
    .maybeSingle();
  if (!inquiry) notFound();

  if (inquiry.status === "confirmed") {
    redirect(`/staff/inquiries/${id}/edit`);
  }

  const { data: services } = await supabase
    .from("services")
    .select("id, code, name, kind")
    .eq("is_active", true)
    .order("kind", { ascending: true })
    .order("name", { ascending: true });

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          <Link
            href={`/staff/inquiries/${id}/edit`}
            className="hover:text-[color:var(--color-brand-navy)]"
          >
            ← Back to inquiry
          </Link>
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Book from inquiry
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Creates a walk-in appointment for{" "}
          <span className="font-semibold text-[color:var(--color-brand-navy)]">
            {inquiry.caller_name}
          </span>{" "}
          ({inquiry.contact}) and marks this inquiry confirmed. Promote them
          to a registered patient when they actually come in.
        </p>
        {inquiry.service_interest ? (
          <p className="mt-2 text-xs text-[color:var(--color-brand-text-soft)]">
            They asked about: <em>{inquiry.service_interest}</em>
          </p>
        ) : null}
      </header>

      <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <BookFromInquiryForm
          inquiryId={id}
          services={(services ?? []).map((s) => ({
            id: s.id,
            code: s.code,
            name: s.name,
            kind: s.kind,
          }))}
        />
      </div>
    </div>
  );
}
