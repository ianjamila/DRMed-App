/** Resolve a detail title after the caller's authorization gate. Lookup errors
 * and absent/blank subjects must never replace the static name with an error. */
export async function detailMetadata(
  name: string,
  loadSubject: () => Promise<string | null | undefined>,
): Promise<{ title: string }> {
  try {
    const subject = (await loadSubject())?.trim();
    return { title: subject ? `${name} · ${subject}` : name };
  } catch {
    return { title: name };
  }
}
