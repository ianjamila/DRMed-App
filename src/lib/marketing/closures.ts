import "server-only";
import { createClient } from "@/lib/supabase/server";

export interface PublicClosure {
  closed_on: string; // YYYY-MM-DD, Asia/Manila
  reason: string;
}

// Returns YYYY-MM-DD for "today in Manila", regardless of server timezone.
export function todayManilaISO(): string {
  // sv-SE locale yields YYYY-MM-DD which is exactly what we want.
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Manila",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

// "Tomorrow in Manila" — start of the booking day grid.
export function tomorrowManilaISO(): string {
  const today = todayManilaISO();
  const [y, m, d] = today.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

// Add `days` calendar days to an ISO YYYY-MM-DD.
export function addDaysISO(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + days));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-${String(next.getUTCDate()).padStart(2, "0")}`;
}

// Closures on or after `fromISO`, up to and including `toISO`. Used by the
// booking page to populate the slot picker.
export async function listClosuresInRange(
  fromISO: string,
  toISO: string,
): Promise<PublicClosure[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("clinic_closures")
    .select("closed_on, reason")
    .gte("closed_on", fromISO)
    .lte("closed_on", toISO)
    .order("closed_on", { ascending: true });

  if (error) {
    console.error("listClosuresInRange failed", error);
    return [];
  }
  return data ?? [];
}
