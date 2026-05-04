import { redirect } from "next/navigation";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { createClient } from "@/lib/supabase/server";
import { QuoteWorkbench, type QuoteService } from "./quote-workbench";

export const metadata = {
  title: "Quick quote — staff",
};

export default async function QuotePage() {
  const session = await requireActiveStaff();
  if (!["reception", "medtech", "admin"].includes(session.role)) {
    redirect("/staff");
  }

  const supabase = await createClient();
  const { data } = await supabase
    .from("services")
    .select(
      "id, code, name, price_php, hmo_price_php, senior_discount_php, turnaround_hours, kind, section, is_send_out",
    )
    .eq("is_active", true)
    .order("name", { ascending: true });

  const services: QuoteService[] = (data ?? []).map((s) => ({
    id: s.id,
    code: s.code,
    name: s.name,
    price_php: Number(s.price_php),
    hmo_price_php: s.hmo_price_php != null ? Number(s.hmo_price_php) : null,
    senior_discount_php:
      s.senior_discount_php != null ? Number(s.senior_discount_php) : null,
    turnaround_hours: s.turnaround_hours,
    kind: s.kind,
    section: s.section,
    is_send_out: s.is_send_out,
  }));

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Quick quote
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Search the catalog and copy a formatted quote into Viber or SMS.
          Press <kbd className="rounded border border-[color:var(--color-brand-bg-mid)] bg-white px-1.5 py-0.5 font-mono text-[10px]">Cmd</kbd>+<kbd className="rounded border border-[color:var(--color-brand-bg-mid)] bg-white px-1.5 py-0.5 font-mono text-[10px]">K</kbd> from anywhere in the staff portal to jump back here.
        </p>
      </header>

      <QuoteWorkbench services={services} />
    </div>
  );
}
