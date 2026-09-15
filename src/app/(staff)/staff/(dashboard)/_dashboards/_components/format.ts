// Dashboard money is shown to the CENTAVO. It used to round to whole pesos
// (maximumFractionDigits: 0), which turned a ₱0.25 unpaid balance into "₱0"
// and a ₱100.40 balance into "₱100" — an actionable amount rendered as
// nothing to collect. Every figure these cards carry (collections, drawer,
// payables, receivables) is a real amount someone has to reconcile, so the
// centavos are load-bearing. Both fraction digits are pinned so a whole
// amount still reads "₱1,200.00" rather than "₱1,200".
const PESO_FORMAT = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const TIME_FORMAT = new Intl.DateTimeFormat("en-PH", {
  timeZone: "Asia/Manila",
  hour: "numeric",
  minute: "2-digit",
});

export function formatPeso(value: number | null | undefined): string {
  return PESO_FORMAT.format(Number(value ?? 0));
}

export function formatTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return TIME_FORMAT.format(new Date(iso));
  } catch {
    return "—";
  }
}

export function relativeAge(iso: string | null | undefined): string {
  if (!iso) return "—";
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  const mins = Math.max(0, Math.floor(ms / 60000));
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
