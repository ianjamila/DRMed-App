import type { Cell } from "../types";

export class HeaderMismatchError extends Error {
  constructor(tab: string, detail: string) {
    super(`${tab}: header changed (${detail}) — the sync refuses to guess column positions`);
    this.name = "HeaderMismatchError";
  }
}

const norm = (c: Cell) => String(c ?? "").replace(/\s+/g, " ").trim().toUpperCase();

/** Each expectation: [row, column, required prefix]. */
export function assertHeaders(tab: string, rows: Cell[][], expect: ReadonlyArray<[number, number, string]>): void {
  for (const [r, c, prefix] of expect) {
    const got = norm(rows[r]?.[c]);
    if (!got.startsWith(prefix.toUpperCase())) {
      throw new HeaderMismatchError(tab, `row ${r + 1} col ${c + 1}: expected "${prefix}…", got "${got}"`);
    }
  }
}

export const CUSTOMER_HEADERS: ReadonlyArray<[number, number, string]> = [
  [0, 4, "Full Name"], [0, 5, "Gender"], [0, 6, "Date of Birth"], [0, 11, "Contact Number"],
  [0, 12, "Email"], [0, 15, "Doctor"], [0, 16, "How did you know"], [0, 17, "Referred By"],
  [0, 18, "Preferred Medium"], [0, 19, "New / Repeat"], [0, 20, "Timestamp"],
];
export const LAB_HEADERS: ReadonlyArray<[number, number, string]> = [
  [0, 1, "CONTROL NO"], [0, 2, "TEST NO"], [0, 3, "PATIENT NAME"], [0, 7, "SERVICE"], [0, 8, "BASE PRICE"],
  [0, 13, "FINAL PRICE"], [0, 14, "PAYMENT METHOD"], [0, 16, "RESULT RELEASE"], [1, 15, "REF"], [1, 17, "DATE RELEASED"],
];
export const CONSULT_HEADERS: ReadonlyArray<[number, number, string]> = [
  [0, 0, "DATE"], [0, 1, "CONTROL NO"], [0, 3, "PATIENT NAME"], [0, 7, "DOCTOR CONSULTANT"],
  [0, 8, "BASE PRICE"], [0, 11, "FINAL PRICE"], [0, 12, "CLINIC"], [1, 13, "PAID"], [1, 14, "REFERENCE"],
];
