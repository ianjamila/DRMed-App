const PESO_FORMAT = new Intl.NumberFormat("en-PH", {
  style: "currency",
  currency: "PHP",
  maximumFractionDigits: 0,
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
