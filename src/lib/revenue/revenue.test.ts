import { describe, expect, it } from "vitest";
import { moneyMinor, minorDecimal, percentageFee, percentageUnits, revenueMoney } from "./money";
import { invoiceHtml } from "../../server/revenue/invoice";
import type { RevenueInvoice } from "./schema";

describe("Exact currency and commission arithmetic", () => {
  it("keeps fractional currency exact and rounds the fee once to the currency minor unit", () => {
    expect(moneyMinor("0.10", "USD") + moneyMinor("0.20", "USD")).toBe(30n);
    expect(percentageFee(moneyMinor("1000.01", "USD"), "1.2345")).toBe(1235n);
    expect(percentageFee(1n, "50")).toBe(1n);
    expect(moneyMinor("123.456", "KWD")).toBe(123456n);
    expect(minorDecimal(123456n, "KWD")).toBe("123.456");
    expect(revenueMoney(-1205n, "USD")).toBe("USD -12.05");
  });
  it("rejects hidden floating coercion, currency precision mistakes and invalid rates", () => {
    for (const value of ["1e6", "$100", "1,000", "NaN", "-1", "0", "1.001"])
      expect(() => moneyMinor(value, "USD")).toThrow();
    expect(() => moneyMinor("1.00", "JPY")).toThrow();
    expect(moneyMinor("0", "USD", true)).toBe(0n);
    for (const value of ["0", "100.0001", "1e1", "-2", "0.00001"])
      expect(() => percentageUnits(value)).toThrow();
    expect(() => percentageFee(1n, "0.0001")).toThrow(/outside/);
  });
  it("retains large amounts without conversion through Number", () => {
    expect(moneyMinor("99999999999999.99", "USD")).toBe(9999999999999999n);
    expect(revenueMoney(9999999999999999n, "USD")).toBe("USD 99,999,999,999,999.99");
    expect(() => moneyMinor("100000000000000.00", "USD")).toThrow(/bound/);
  });
});
it("renders an escaped immutable invoice without treating a payment receipt as invoice content", () => {
  const invoice = {
    number: "AER-2026-000001",
    currency: "USD",
    issuedOn: "2026-11-01",
    dueOn: "2026-11-03",
    subtotalMinor: "10000",
    taxMinor: "0",
    totalMinor: "10000",
    status: "Issued",
    voidNote: "",
    snapshot: {
      issuerName: "Fictional <script>alert(1)</script>",
      issuerEmail: "fixture@example.com",
      issuerAddress: "Fictional address",
      issuerRegistration: "",
      billTo: {
        name: "Fixture",
        company: "Buyer & Co",
        email: "buyer@example.com",
        address: "Fictional address",
      },
      engagementTitle: "Fictional sourcing engagement",
      description: "A fictional invoice",
      paymentInstructions: "No real payment instructions.",
      taxLabel: "",
      feeTerms: {
        type: "Fixed",
        percentage: null,
        basisDescription: "Agreed fictional fee",
        earningTerms: "Fictional completion evidence",
        paymentTerms: "Fictional due terms",
      },
    },
  } as RevenueInvoice;
  const original = invoiceHtml(invoice),
    afterReceipt = invoiceHtml({ ...invoice, receivedMinor: "10000", outstandingMinor: "0" });
  expect(original).toBe(afterReceipt);
  expect(original).not.toContain("<script>");
  expect(original).toContain("&lt;script&gt;");
  expect(original).toContain("USD 100.00");
  expect(original).toContain("Buyer &amp; Co");
});
