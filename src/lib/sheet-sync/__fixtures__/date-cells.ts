/** Date-cell shapes seen in the live sheet (2026-09-24). Values only — no names. */
export const EVENT_DATE_CASES: ReadonlyArray<[cell: unknown, expected: string | null]> = [
  [45627, "2024-12-01"],            // integer serial (manual date)
  [45627.4375, "2024-12-01"],       // fractional serial (form timestamp) — time ignored
  [45261, "2023-12-01"],            // first day of the window
  ["", null],
  [undefined, null],
  ["3/4/2025", "2025-03-04"],       // slash WITHOUT time → M/D
  ["13/4/2025 10:22:01", "2025-04-13"], // slash WITH time → D/M
  ["4/13/2025", "2025-04-13"],
  ["SEPT 9,2025", "2025-09-09"],
  ["SEPTMEBER 12,2025", "2025-09-12"],
  ["JULY 15,2025", "2025-07-15"],
  ["APRIL 3,2025\\", "2025-04-03"],  // trailing junk character
  ["Sept 12,2025", "2025-09-12"],
  ["DEC 01,2024", "2024-12-01"],
  ["Dec 1, 2024", "2024-12-01"],
  ["March 16,2024", "2024-03-16"],
  ["APRIL 23,20-25", null],         // junk year
  ["Feb 10,20255", null],
  ["June 28", null],                // no year
  ["AUH 5,2025", null],             // not a month
  ["GCASH", null],
  ["`", null],
  ["#N/A (Did not find value in VLOOKUP evaluation.)", null],
  ["12345678901", null],
  [3034 * 365, null],               // far-future serial (the "3034" consult rows)
  ["MAX", null],
  ["Viber", null],
];

export const DOB_CASES: ReadonlyArray<[cell: unknown, expected: string | null]> = [
  [32874, "1990-01-01"],
  ["SEPT 12,1990", "1990-09-12"],
  ["SEPT. 12, 1990", "1990-09-12"],
  ["FEBUARY 26,2019", "2019-02-26"],
  ["08-15-1948", "1948-08-15"],
  ["12/25/1980", "1980-12-25"],
  ["15-Jul-1966", "1966-07-15"],
  ["SEPT 9", null],
  ["SEPT 9,19900", null],
  ["-", null],
  ["labian", null],
  ["", null],
];
