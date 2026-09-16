import Link from "next/link";
import { UNKNOWN_PROVIDER } from "@/lib/operations/hmo-ar-report";

/**
 * A provider name in the receivables report, linked to that provider's claim
 * batches when it resolves to one.
 *
 * A4 in the SectionTabs audit: this report and `/staff/admin/accounting/hmo-claims`
 * read the same receivable off the same view for two different jobs — a read-only
 * roll-forward here, the actionable worklist there — and neither knew the other
 * existed. Both are correctly where they are; what was missing was the way across.
 *
 * Not every name resolves, and that is expected rather than a bug: the
 * roll-forward folds in `historic_hmo_claims`, whose imported provider names
 * need not exist in `hmo_providers`, and it has its own "(unknown HMO)" bucket
 * for rows that carry no provider at all. Those render as plain text — there is
 * no claim worklist to open for them.
 */
export function ProviderCell({
  provider,
  providerId,
}: {
  provider: string;
  providerId?: string;
}) {
  if (!providerId || provider === UNKNOWN_PROVIDER) return <>{provider}</>;
  return (
    <Link
      href={`/staff/admin/accounting/hmo-claims/${providerId}`}
      className="font-medium text-[color:var(--color-brand-cyan)] hover:underline"
    >
      {provider}
    </Link>
  );
}
