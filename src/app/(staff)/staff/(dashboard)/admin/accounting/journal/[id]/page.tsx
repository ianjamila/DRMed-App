import { cache } from "react";
import { detailMetadata } from "@/lib/staff/detail-metadata";
import { notFound } from "next/navigation";
import { requireAdminStaff } from "@/lib/auth/require-admin";
import { getJournalEntryAction } from "@/lib/actions/accounting/journal-entries";
import { JournalDetailClient } from "./journal-detail-client";

// React cache shares this lookup between metadata and the page in one request.
const loadJournalEntry = cache(getJournalEntryAction);

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  await requireAdminStaff();
  const { id } = await params;
  return detailMetadata("Journal Entry", async () => {
    const result = await loadJournalEntry(id);
    return result.ok ? result.data.entry_number?.trim() || result.data.description : null;
  });
}
export const dynamic = "force-dynamic";

export default async function JournalDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireAdminStaff();
  const { id } = await params;
  const r = await loadJournalEntry(id);
  if (!r.ok || !r.data) notFound();
  return <JournalDetailClient je={r.data} />;
}
