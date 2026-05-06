import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { formatPhp } from "@/lib/marketing/format";
import { SellGiftCodeForm } from "./sell-form";

export const metadata = { title: "Sell gift code — staff" };

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ sold?: string; code?: string }>;
}

export default async function SellGiftCodePage({ searchParams }: PageProps) {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    redirect("/staff");
  }

  const params = await searchParams;
  const supabase = await createClient();

  // After a successful sale, the action redirects with ?sold=<code>.
  // Fetch the resulting row so reception sees the receipt info to print.
  let lastSold:
    | {
        code: string;
        face_value_php: number;
        purchased_by_name: string | null;
        purchased_by_contact: string | null;
        purchased_at: string | null;
        purchase_method: string | null;
      }
    | null = null;
  if (params.sold) {
    const { data } = await supabase
      .from("gift_codes")
      .select(
        "code, face_value_php, purchased_by_name, purchased_by_contact, purchased_at, purchase_method",
      )
      .eq("code", params.sold)
      .maybeSingle();
    lastSold = data ?? null;
  }

  return (
    <div className="mx-auto max-w-xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Phase 11 · Reception
        </p>
        <h1 className="mt-1 font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Sell gift code
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Type or scan the printed code, capture the buyer&apos;s details,
          and record how they paid. The code becomes redeemable on any
          future visit&apos;s payment screen.
        </p>
      </header>

      {lastSold ? (
        <div className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <p className="font-semibold">Sale recorded.</p>
          <p className="mt-1">
            <span className="font-mono">{lastSold.code}</span>{" "}
            <span className="text-xs">·</span> {formatPhp(lastSold.face_value_php)}{" "}
            <span className="text-xs">·</span> {lastSold.purchased_by_name}
            {lastSold.purchased_by_contact
              ? ` (${lastSold.purchased_by_contact})`
              : ""}
          </p>
        </div>
      ) : null}

      <div className="rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <SellGiftCodeForm initialCode={params.code ?? ""} />
      </div>
    </div>
  );
}
