import Link from "next/link";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { physicianPhotoUrl } from "@/lib/physicians/photo";
import { pluckOne } from "@/lib/reports/format";
import { PhysicianForm } from "../../physician-form";
import { PhotoUpload } from "./photo-upload";
import { DeletePhysicianButton } from "./delete-physician-button";

export const metadata = { title: "Edit physician — staff" };

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function EditPhysicianPage({ params }: PageProps) {
  await requireAdminStaff();
  const { id } = await params;
  const admin = createAdminClient();

  const { data: physician } = await admin
    .from("physicians")
    // 0136: commercial terms moved to physician_compensation (admin-only).
    .select(
      "id, slug, full_name, specialty, group_label, bio, is_active, display_order, photo_path, physician_compensation ( compensation_arrangement, default_consultation_fee_php, clinic_cut_php )",
    )
    .eq("id", id)
    .maybeSingle();
  if (!physician) notFound();

  // The form still takes one flat object, so the embed is flattened back here
  // rather than reshaping the form. Falls back to the same defaults the dropped
  // columns carried, so a doctor missing a compensation row edits cleanly.
  const comp = pluckOne(physician.physician_compensation);
  const physicianFormDefaults = {
    ...physician,
    compensation_arrangement: comp?.compensation_arrangement ?? "pf_split",
    default_consultation_fee_php: comp?.default_consultation_fee_php ?? null,
    clinic_cut_php: comp?.clinic_cut_php ?? null,
  };

  const photoUrl = physicianPhotoUrl({
    slug: physician.slug,
    photo_path: physician.photo_path,
  });

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-cyan)]">
            <Link
              href="/staff/admin/physicians"
              className="hover:text-[color:var(--color-brand-navy)]"
            >
              ← Physicians
            </Link>
          </p>
          <h1 className="mt-1 font-heading text-3xl font-extrabold text-[color:var(--color-brand-navy)]">
            {physician.full_name}
          </h1>
          <p className="mt-1 text-sm text-[color:var(--color-brand-text-soft)]">
            {physician.specialty}
          </p>
        </div>
        <Link
          href={`/staff/admin/physicians/${physician.id}/schedule`}
          className="rounded-md border border-[color:var(--color-brand-bg-mid)] bg-white px-3 py-1.5 text-xs font-bold uppercase tracking-wider text-[color:var(--color-brand-navy)] hover:bg-[color:var(--color-brand-bg)]"
        >
          Schedule →
        </Link>
      </header>

      <section className="mb-6 rounded-xl border border-[color:var(--color-brand-bg-mid)] bg-white p-6">
        <h2 className="font-heading text-sm font-extrabold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Photo
        </h2>
        <div className="mt-3">
          <PhotoUpload physicianId={physician.id} currentUrl={photoUrl} />
        </div>
      </section>

      <PhysicianForm initial={physicianFormDefaults} />

      <section className="mt-8 border-t border-[color:var(--color-brand-bg-mid)] pt-6">
        <h2 className="mb-3 font-heading text-sm font-extrabold uppercase tracking-wider text-[color:var(--color-brand-text-soft)]">
          Danger zone
        </h2>
        <DeletePhysicianButton
          physicianId={physician.id}
          physicianName={physician.full_name}
        />
      </section>
    </div>
  );
}
