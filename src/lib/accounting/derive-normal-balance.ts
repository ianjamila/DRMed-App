// Normal balance follows account type. For `memo`, either is allowed by the
// CHECK constraint; we default to "debit" as a safe, conventional choice.
export function deriveNormalBalance(type: string): "debit" | "credit" {
  switch (type) {
    case "asset":
    case "expense":
    case "contra_revenue":
      return "debit";
    case "liability":
    case "equity":
    case "revenue":
    case "contra_expense":
      return "credit";
    case "memo":
      return "debit"; // memo allows either; default to debit
    default:
      return "debit";
  }
}
