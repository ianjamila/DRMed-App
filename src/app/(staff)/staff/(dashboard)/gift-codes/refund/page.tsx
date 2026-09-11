import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { requireActiveStaff } from "@/lib/auth/require-staff";
import { formatPhp } from "@/lib/marketing/format";
import { normaliseGiftCode, type GiftCodeStatus } from "@/lib/gift-codes/labels";
import { giftCodeRefundEligibility } from "@/lib/gift-codes/refund";
import { Panel } from "@/components/ui/panel";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { RefundGiftCodeForm } from "./refund-form";

export const metadata = { title: "Refund gift code sale — staff" };

export const dynamic = "force-dynamic";

interface PageProps {
  searchParams: Promise<{ code?: string; refunded?: string }>;
}

interface GiftCodeLookup {
  code: string;
  status: GiftCodeStatus;
  face_value_php: number;
  purchased_by_name: string | null;
  purchased_by_contact: string | null;
  purchase_method: string | null;
  purchased_at: string | null;
}

export default async function RefundGiftCodePage({ searchParams }: PageProps) {
  const session = await requireActiveStaff();
  if (session.role !== "reception" && session.role !== "admin") {
    redirect("/staff");
  }

  const params = await searchParams;
  const supabase = await createClient();

  const normalisedQuery = params.code ? normaliseGiftCode(params.code) : "";

  let lookedUp: GiftCodeLookup | null = null;
  if (normalisedQuery) {
    const { data } = await supabase
      .from("gift_codes")
      .select(
        "code, status, face_value_php, purchased_by_name, purchased_by_contact, purchase_method, purchased_at",
      )
      .eq("code", normalisedQuery)
      .maybeSingle();
    lookedUp = (data as GiftCodeLookup | null) ?? null;
  }

  const eligibility = lookedUp
    ? giftCodeRefundEligibility(lookedUp.status)
    : null;

  return (
    <div className="mx-auto max-w-xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
          Reception
        </p>
        <h1 className="mt-1 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Refund a gift code sale
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Use this when a sale was mis-keyed — wrong buyer details, wrong
          payment method, or the customer changed their mind — and the code
          hasn&apos;t been used yet. It puts the money back out of
          today&apos;s drawer count and makes the code available to sell
          again. Already redeemed on a visit? Void that payment instead.
        </p>
      </header>

      {params.refunded ? (
        <div className="mb-6 rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          <p className="font-semibold">Refund recorded.</p>
          <p className="mt-1">
            <span className="font-mono">{params.refunded}</span> is back in
            inventory and can be sold again.
          </p>
        </div>
      ) : null}

      <Panel className="p-6">
        <form
          action="/staff/gift-codes/refund"
          className="mb-6 flex items-end gap-2"
        >
          <div className="grid flex-1 gap-1.5">
            <label
              htmlFor="code"
              className="flex items-center gap-2 text-sm leading-none font-medium"
            >
              Gift code
            </label>
            <Input
              id="code"
              name="code"
              defaultValue={params.code ?? ""}
              autoComplete="off"
              autoFocus
              placeholder="GC-XXXX-YYYY-ZZZZ"
              className="font-mono uppercase"
            />
          </div>
          <Button
            type="submit"
            variant="brand"
            size="touch"
          >
            Look up
          </Button>
        </form>

        {normalisedQuery && !lookedUp ? (
          <p className="text-sm text-red-600" role="alert">
            No gift code found with that number.
          </p>
        ) : null}

        {lookedUp ? (
          <div className="grid gap-4 border-t border-[color:var(--color-brand-bg-mid)] pt-4">
            <dl className="grid gap-3 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                  Code
                </dt>
                <dd className="font-mono font-semibold text-[color:var(--color-brand-navy)]">
                  {lookedUp.code}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                  Amount
                </dt>
                <dd className="font-semibold text-[color:var(--color-brand-navy)]">
                  {formatPhp(lookedUp.face_value_php)}
                </dd>
              </div>
              {lookedUp.purchased_by_name ? (
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                    Sold to
                  </dt>
                  <dd>
                    {lookedUp.purchased_by_name}
                    {lookedUp.purchased_by_contact
                      ? ` · ${lookedUp.purchased_by_contact}`
                      : ""}
                  </dd>
                </div>
              ) : null}
              {lookedUp.purchase_method ? (
                <div>
                  <dt className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
                    Paid by
                  </dt>
                  <dd className="capitalize">
                    {lookedUp.purchase_method.replace("_", " ")}
                  </dd>
                </div>
              ) : null}
            </dl>

            {eligibility && !eligibility.ok ? (
              <p className="rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                {eligibility.error}
              </p>
            ) : (
              <RefundGiftCodeForm code={lookedUp.code} />
            )}
          </div>
        ) : null}
      </Panel>
    </div>
  );
}
