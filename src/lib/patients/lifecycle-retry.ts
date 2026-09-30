// Retry-once for the patient lifecycle lock protocol (0184). A transaction
// that loses a race is rolled back WHOLE — P0072 (the record moved to another
// patient, or the patient changed, while it waited for the lock), 40P01
// (chosen as a deadlock victim), 40001 (serialization failure) — so calling
// the same RPC again, in a fresh transaction, can never double-write.
// Exactly one retry: a second loss is shown to the user (translatePgError).
// A call with NO code is an unknown outcome (lost response) and is never
// retried here — it may have committed.
export const LIFECYCLE_RETRYABLE_CODES: ReadonlySet<string> = new Set(["P0072", "40P01", "40001"]);

export function isLifecycleRetryable(err: { code?: string | null } | null | undefined): boolean {
  return !!err?.code && LIFECYCLE_RETRYABLE_CODES.has(err.code);
}

export async function withLifecycleRetry<T extends { error: { code?: string | null } | null }>(
  call: () => PromiseLike<T>,
): Promise<T> {
  const first = await call();
  if (!isLifecycleRetryable(first.error)) return first;
  return await call();
}
