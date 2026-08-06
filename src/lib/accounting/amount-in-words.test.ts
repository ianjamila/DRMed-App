import { describe, it, expect } from "vitest";
import { integerInWords, pesosInWords } from "./amount-in-words";

describe("integerInWords", () => {
  it("spells the teens and tens without a stray hyphen", () => {
    expect(integerInWords(0)).toBe("zero");
    expect(integerInWords(7)).toBe("seven");
    expect(integerInWords(15)).toBe("fifteen");
    expect(integerInWords(20)).toBe("twenty");
    expect(integerInWords(21)).toBe("twenty-one");
    expect(integerInWords(90)).toBe("ninety");
  });

  it("spells hundreds and skips empty groups", () => {
    expect(integerInWords(100)).toBe("one hundred");
    expect(integerInWords(105)).toBe("one hundred five");
    expect(integerInWords(1_000_000)).toBe("one million");
    // 1,000,015 — the thousands group is empty and must not print "zero
    // thousand".
    expect(integerInWords(1_000_015)).toBe("one million fifteen");
  });

  it("spells multi-scale amounts", () => {
    expect(integerInWords(1_600)).toBe("one thousand six hundred");
    expect(integerInWords(1_234)).toBe("one thousand two hundred thirty-four");
    expect(integerInWords(999_999_999)).toBe(
      "nine hundred ninety-nine million nine hundred ninety-nine thousand nine hundred ninety-nine",
    );
  });
});

describe("pesosInWords", () => {
  it("uses the singular peso for exactly one", () => {
    expect(pesosInWords(1)).toBe("One peso only");
    expect(pesosInWords(2)).toBe("Two pesos only");
  });

  it("spells a whole-peso batch total", () => {
    expect(pesosInWords(1600)).toBe("One thousand six hundred pesos only");
    expect(pesosInWords(0)).toBe("Zero pesos only");
  });

  it("appends centavos when there are any", () => {
    expect(pesosInWords(1234.56)).toBe(
      "One thousand two hundred thirty-four pesos and fifty-six centavos only",
    );
    expect(pesosInWords(2500.05)).toBe(
      "Two thousand five hundred pesos and five centavos only",
    );
    expect(pesosInWords(300.01)).toBe(
      "Three hundred pesos and one centavo only",
    );
  });

  it("drops the peso clause when the amount is under a peso", () => {
    expect(pesosInWords(0.5)).toBe("Fifty centavos only");
    expect(pesosInWords(0.01)).toBe("One centavo only");
  });

  it("rounds to the centavo before spelling", () => {
    expect(pesosInWords(1234.567)).toBe(
      "One thousand two hundred thirty-four pesos and fifty-seven centavos only",
    );
    // Rounds up into the next peso — the peso clause must follow.
    expect(pesosInWords(9.999)).toBe("Ten pesos only");
  });

  it("prefixes a clawback total with Minus", () => {
    expect(pesosInWords(-400)).toBe("Minus four hundred pesos only");
    expect(pesosInWords(-0.5)).toBe("Minus fifty centavos only");
  });

  it("accepts the numeric strings Supabase returns for numeric columns", () => {
    expect(pesosInWords("1600.00")).toBe("One thousand six hundred pesos only");
    expect(pesosInWords("400.50")).toBe(
      "Four hundred pesos and fifty centavos only",
    );
  });

  it("falls back to figures rather than inventing a scale word", () => {
    expect(pesosInWords(1e15)).toBe("1000000000000000.00 pesos only");
  });

  it("returns an empty string for a non-finite amount", () => {
    expect(pesosInWords(Number.NaN)).toBe("");
    expect(pesosInWords("not a number")).toBe("");
  });
});
