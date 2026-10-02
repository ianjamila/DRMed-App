/**
 * Hand-checks what pf_disburse_entries (0224) returns:
 * `{ disbursement_id: uuid, batch_number: bigint }`. Null when it is not that shape,
 * so a caller never audits or reports a payout it could not actually identify.
 */
export function parsePayoutResult(data: unknown): { id: string; batch_number: number } | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const { disbursement_id: id, batch_number: batch } = data as {
    disbursement_id?: unknown;
    batch_number?: unknown;
  };
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof batch !== "number" || !Number.isFinite(batch)) return null;
  return { id, batch_number: batch };
}
