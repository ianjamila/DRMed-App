import { describe, it, expect } from "vitest";
import { mopToMethod } from "./mop-method";

describe("mopToMethod", () => {
  it("maps known MOPs to allowed payments.method values", () => {
    expect(mopToMethod("GCASH")).toBe("gcash");
    expect(mopToMethod("CASH")).toBe("cash");
    expect(mopToMethod("CARD PAY")).toBe("card");
    expect(mopToMethod("BPI")).toBe("bpi");
    expect(mopToMethod("BDO")).toBe("bank_transfer");  // no 'bdo' method exists
    expect(mopToMethod("CHEQUE")).toBe("bank_transfer");
    expect(mopToMethod("MAYA")).toBe("maya");
    expect(mopToMethod("HMO")).toBe("hmo");
  });
  it("defaults blank/unknown to cash", () => {
    expect(mopToMethod("")).toBe("cash");
    expect(mopToMethod("OK")).toBe("cash");
    expect(mopToMethod("PRE EMPLOYMENT")).toBe("cash");
  });
});
