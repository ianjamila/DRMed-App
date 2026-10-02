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

/**
 * True when an rpc() error never reached a database answer: the supabase client reports a fetch failure, a dropped connection or an
 * unreadable gateway reply with an EMPTY code, while every answer from Postgres / PostgREST (SQLSTATE, PGRST…) carries one. After a
 * transport-level error the payout may or may not have committed, so it must not be reported as a definite refusal.
 */
export function isTransportError(err: { code?: string | null }): boolean {
  return !err.code;
}

/** The sentence both payout actions add when a payout may have committed without the caller learning its id. */
export const PAYOUT_MAY_EXIST = "check Pay Doctors › Already paid before trying again";
