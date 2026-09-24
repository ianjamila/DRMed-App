/**
 * Real header rows from the sheet (plan §1), non-PII. Shared by Tasks 4, 5
 * and 11's tests so every parser and header guard is checked against the
 * literal text the sheet shows.
 *
 * Typed `Cell[]` (not `unknown[]` as the plan's snippet literally said) —
 * `unknown[]` does not assign to the parsers' `Cell[][]` parameter and fails
 * `tsc --noEmit`; `Cell` is exactly the sheet's primitive union anyway.
 */
import type { Cell } from "../types";

export const CUST_HEADER: Cell[] = [
  "Last Name", "First Name", "M.I.", "#", "Full Name", "Gender", "Date of Birth", "Age",
  "Address (#, Street Name) ", "Address (Barangay) ", "Address (City) ", "Contact Number", "Email address",
  "Senior / PWD ID", "Senior / PWD ID Number", "Doctor", "How did you know about DR Med?", "Referred By: ",
  "Preferred Medium of Result Release", "New / Repeat", "Timestamp", "Column 21",
];

export const LAB_H0: Cell[] = [
  " ", "CONTROL NO", "TEST NO", "PATIENT NAME", "HMO", "", "", "SERVICE", "BASE PRICE", "SENIOR/\nPWD (20%)",
  "DISCOUNT (10%)", "DISCOUNT (5%)", "ACTUAL DISCOUNT", "FINAL PRICE (LESS DISCOUNTS)", "PAYMENT METHOD", "",
  "RESULT RELEASE", "", "REMARKS", "DATE (PLACE HOLDER)",
];

export const LAB_H1: Cell[] = [
  "", "", "", "", "YES / NO", "PROVIDER", "APPROVAL DATE", "", "", "", "", "", "", "", "PAID", "REF",
  "PREFERRED MEDIUM", "DATE RELEASED",
];

export const CONS_H0: Cell[] = [
  "DATE", "CONTROL NO", "TEST NO.", "PATIENT NAME", "HMO", "", "", "DOCTOR CONSULTANT", "BASE PRICE\n(VARIABLE)",
  "SENIOR/PWD\n(20%)", "OTHER DISCOUNTS \n(20%)", "FINAL PRICE (LESS DISCOUNTS)", "CLINIC \nFEE", "  ", "", "REMARKS",
];

export const CONS_H1: Cell[] = [
  "", "", "", "", "YES / NO", "PROVIDER", "APPROVAL DATE", "", "", "", "", "", "", "PAID", "REFERENCE",
];
