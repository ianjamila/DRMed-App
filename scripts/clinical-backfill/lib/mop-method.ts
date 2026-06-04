// Map a master-sheet MOP string to an allowed payments.method value.
// Allowed: cash | gcash | maya | card | bank_transfer | hmo | bpi | maybank.
export type PaymentMethod =
  | "cash" | "gcash" | "maya" | "card" | "bank_transfer" | "hmo" | "bpi" | "maybank";

export function mopToMethod(mop: string): PaymentMethod {
  const m = (mop ?? "").trim().toUpperCase();
  switch (m) {
    case "GCASH": return "gcash";
    case "MAYA": return "maya";
    case "CARD PAY":
    case "CARD": return "card";
    case "BPI": return "bpi";
    case "BDO":            // no dedicated BDO method
    case "BANK":
    case "BANK TRANSFER":
    case "CHEQUE":
    case "CHECK": return "bank_transfer";
    case "HMO": return "hmo";
    default: return "cash"; // CASH, blank, OK, PRE EMPLOYMENT, exec bundles, etc.
  }
}
