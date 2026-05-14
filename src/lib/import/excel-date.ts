// Excel serial date → ISO YYYY-MM-DD in Asia/Manila timezone.
// Excel epoch is 1899-12-30 (treating 1900 as a leap year, a known Lotus 1-2-3 bug).
// We treat workbook dates as naive Manila dates (no time component).

const EXCEL_EPOCH_DAYS = 25_569; // days from 1899-12-30 to 1970-01-01
const MS_PER_DAY = 86_400_000;

export function excelSerialToISODate(serial: number): string {
  if (!Number.isFinite(serial)) throw new Error(`invalid excel serial: ${serial}`);
  if (serial < 1 || serial > 100_000) {
    throw new Error(`excel serial out of expected range (1900–~2173): ${serial}`);
  }
  const unixMs = (serial - EXCEL_EPOCH_DAYS) * MS_PER_DAY;
  const d = new Date(unixMs);
  // Format as YYYY-MM-DD in UTC (the calendar day is what matters; timezone offset
  // is irrelevant because the source has no time).
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}
