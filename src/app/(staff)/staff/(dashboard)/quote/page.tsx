import { redirect } from "next/navigation";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { loadMessageForBooking } from "@/lib/contact-messages/booking-link";
import { firstNameOf } from "@/lib/contact-messages/first-name";
import { QuoteWorkbench, type QuoteService, type QuoteMessageContext } from "./quote-workbench";

export const metadata = {
  title: "Quick Quote",
};

interface Props {
  searchParams: Promise<{ message?: string }>;
}

export default async function QuotePage({ searchParams }: Props) {
  const session = await requireActiveStaff();
  if (!["reception", "admin"].includes(session.role)) {
    redirect("/staff");
  }

  const supabase = await createClient();

  // `?message=<id>` prefills the quote for a website-message sender. Only
  // reception/admin can read contact_messages (0154 RLS), which is also who
  // can open this page (medtech lost access 2026-09-24); the role check below
  // stays so the prefill never outruns the page gate if that list grows.
  const sp = await searchParams;
  let messageContext: QuoteMessageContext | null = null;
  if (sp.message && (session.role === "reception" || session.role === "admin")) {
    const message = await loadMessageForBooking(supabase, sp.message);
    if (message) {
      messageContext = { messageId: message.id, firstName: firstNameOf(message.name) };
    }
  }

  const { data } = await supabase
    .from("services")
    .select(
      "id, code, name, price_php, hmo_price_php, senior_pwd_eligible, turnaround_hours, kind, section, is_send_out",
    )
    .eq("is_active", true)
    .order("name", { ascending: true });

  const services: QuoteService[] = (data ?? []).map((s) => ({
    id: s.id,
    code: s.code,
    name: s.name,
    price_php: Number(s.price_php),
    hmo_price_php: s.hmo_price_php != null ? Number(s.hmo_price_php) : null,
    senior_pwd_eligible: s.senior_pwd_eligible,
    turnaround_hours: s.turnaround_hours,
    kind: s.kind,
    section: s.section,
    is_send_out: s.is_send_out,
  }));

  return (
    <div className="px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Quick Quote
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Search the catalog and copy a formatted quote into Viber or SMS.
          Press <kbd className="rounded border border-[color:var(--color-brand-bg-mid)] bg-white px-1.5 py-0.5 font-mono text-[10px]">Cmd</kbd>+<kbd className="rounded border border-[color:var(--color-brand-bg-mid)] bg-white px-1.5 py-0.5 font-mono text-[10px]">K</kbd> from anywhere in the staff portal to jump back here.
        </p>
      </header>

      <QuoteWorkbench services={services} messageContext={messageContext} />
    </div>
  );
}
