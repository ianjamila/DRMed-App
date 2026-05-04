import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { PricesTable, type PriceRow } from "./prices-table";

export const metadata = {
  title: "Prices — staff",
};

export const dynamic = "force-dynamic";

export default async function PricesAdminPage() {
  await requireAdminStaff();

  const supabase = await createClient();
  const { data: services } = await supabase
    .from("services")
    .select(
      "id, code, name, kind, section, description, price_php, hmo_price_php, senior_discount_php, is_active, is_send_out",
    )
    .order("section", { ascending: true, nullsFirst: false })
    .order("name", { ascending: true });

  // Fetch the most recent history entry per service in one round trip via the
  // service-role client (we need the joined staff name).
  const admin = createAdminClient();
  const { data: history } = await admin
    .from("service_price_history")
    .select(
      "service_id, price_php, hmo_price_php, senior_discount_php, effective_from, changed_by",
    )
    .order("effective_from", { ascending: false });

  // Build last-changed map (PostgREST has no DISTINCT ON; fold here).
  const lastById = new Map<
    string,
    {
      effective_from: string;
      changed_by: string | null;
    }
  >();
  for (const h of history ?? []) {
    if (!lastById.has(h.service_id)) {
      lastById.set(h.service_id, {
        effective_from: h.effective_from,
        changed_by: h.changed_by,
      });
    }
  }

  // Resolve changed_by → staff name.
  const changerIds = Array.from(
    new Set(
      Array.from(lastById.values())
        .map((v) => v.changed_by)
        .filter((v): v is string => !!v),
    ),
  );
  const nameById = new Map<string, string>();
  if (changerIds.length > 0) {
    const { data: staff } = await admin
      .from("staff_profiles")
      .select("id, full_name")
      .in("id", changerIds);
    for (const s of staff ?? []) nameById.set(s.id, s.full_name);
  }

  const rows: PriceRow[] = (services ?? []).map((s) => {
    const last = lastById.get(s.id);
    return {
      id: s.id,
      code: s.code,
      name: s.name,
      kind: s.kind,
      section: s.section,
      description: s.description,
      price_php: Number(s.price_php),
      hmo_price_php: s.hmo_price_php != null ? Number(s.hmo_price_php) : null,
      senior_discount_php:
        s.senior_discount_php != null ? Number(s.senior_discount_php) : null,
      is_active: s.is_active,
      is_send_out: s.is_send_out,
      last_changed_at: last?.effective_from ?? null,
      last_changed_by:
        last?.changed_by ? (nameById.get(last.changed_by) ?? "Unknown") : null,
    };
  });

  return (
    <div className="mx-auto max-w-[1400px] px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6">
        <h1 className="font-[family-name:var(--font-heading)] text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
          Prices
        </h1>
        <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
          Edit DRMed, HMO, and Senior/PWD pricing for every service. Each change
          is recorded automatically — click any row to see its full history.
        </p>
      </header>

      <PricesTable rows={rows} />
    </div>
  );
}
