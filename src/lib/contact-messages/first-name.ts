// Shared "greet by first name" rule for the Website Messages inbox: the
// detail page's contact block, the new-message alert email, and the quote
// workbench's "quoting for <first name>" banner all need the same answer, so
// it lives in one pure, unit-tested place rather than being re-derived three
// times with three different edge-case bugs.
//
// Client-safe (no server-only, no DB).

/** The first whitespace-separated token of a message sender's name, or a
 * safe fallback when the name is blank/whitespace-only. The name is typed by a
 * website visitor and lands in staff emails, so control characters are
 * stripped and the result is capped at 40 characters. */
export function firstNameOf(name: string | null | undefined): string {
  const trimmed = (name ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (!trimmed) return "there";
  const first = trimmed.split(/\s+/)[0]!;
  return first.length > 40 ? `${first.slice(0, 39)}…` : first;
}
