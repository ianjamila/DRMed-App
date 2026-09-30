/**
 * Run `fn` over `items` with at most `limit` in flight; results keep input order.
 * Lives in its own (non-"use server") module so server-action files and plain
 * libraries can share it — a "use server" file may only export async functions.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
