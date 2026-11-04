import { describe, expect, it } from "vitest";
import { extractLocally } from "./extract";
import { validateEvidence, type Fact } from "./schema";

function extract(text: string, kind: "text" | "csv" = "text") {
  const pages = [{ page: 1, text }];
  return validateEvidence(extractLocally(pages, kind), pages, kind)[0];
}
describe("Source commercial amounts and evidence", () => {
  it("binds separate labelled lease amount, currency and rate basis without a purchase price", () => {
    const source =
      "Manufacturer: Airbus\nOffering: Lease\nLeaseRate: 200000\nLeaseCurrency: EUR\nLeaseBasis: Monthly rent";
    const candidate = extract(source);
    expect(candidate.values).toMatchObject({
      offering: "Lease",
      leaseRate: 200000,
      leaseCurrency: "EUR",
      leaseBasis: "Monthly rent",
    });
    expect(candidate.values.price).toBeUndefined();
    expect(candidate.warnings).toEqual([]);
    expect(candidate.facts.every((fact) => source.includes(fact.quote))).toBe(true);
  });
  it.each([
    ["Lease rate USD per month: 200000", 200000, "USD", "Monthly rent"],
    ["Lease rate: EUR 2000/hour", 2000, "EUR", "Hourly rate"],
    ["Lease rate ZAR per month: 800000", 800000, "ZAR", "Monthly rent"],
  ])("extracts exact periodic terms from %s", (line, rate, currency, basis) => {
    const candidate = extract(`Manufacturer: Airbus\n${line}`);
    expect(candidate.values).toMatchObject({
      offering: "Lease",
      leaseRate: rate,
      leaseCurrency: currency,
      leaseBasis: basis,
    });
    expect(candidate.values.price).toBeUndefined();
  });
  it("keeps genuine dual sale and lease amounts separate without conflicting offering defaults", () => {
    const candidate = extract(
      "Manufacturer: Airbus\nOffering: Sale or lease\nPurchase price USD: 23000000\nLease rate: EUR 180000/month",
    );
    expect(candidate.values).toMatchObject({
      offering: "Sale or lease",
      price: 23000000,
      leaseRate: 180000,
      leaseCurrency: "EUR",
      leaseBasis: "Monthly rent",
    });
    expect(candidate.warnings).toEqual([]);
  });
  it("does not invent units or currency for an unqualified lease amount", () => {
    const candidate = extract("Manufacturer: Airbus\nOffering: Lease\nLeaseRate: 200000");
    expect(candidate.values.offering).toBe("Lease");
    expect(candidate.values.leaseRate).toBeUndefined();
    expect(candidate.values.price).toBeUndefined();
    expect(candidate.warnings.join(" ")).toContain("currency");
  });
  it("does not pair a monthly number with another rate's hourly basis or currency", () => {
    for (const [currency, basis] of [
      ["USD", "Hourly rate"],
      ["EUR", "Monthly rent"],
    ] as const) {
      const text = "Lease rate USD 200000 per month; alternative lease rate EUR 1800 per hour";
      const facts: Fact[] = [
        { field: "leaseRate", value: 200000, quote: text, page: 1 },
        { field: "leaseCurrency", value: currency, quote: text, page: 1 },
        { field: "leaseBasis", value: basis, quote: text, page: 1 },
      ];
      expect(
        validateEvidence({ candidates: [{ facts }] }, [{ page: 1, text }])[0].values.leaseRate,
      ).toBeUndefined();
    }
  });
  it.each([
    ["Lease rate USD: 200000 per month", "USD: 200000"],
    ["Offering: Lease\nPrice USD: 200000", "Price USD: 200000"],
    ["Price USD: 200000 per hour", "200000"],
  ])("rejects a model purchase price cropped from rental evidence: %s", (text, quote) => {
    const candidate = validateEvidence(
      { candidates: [{ facts: [{ field: "price", value: 200000, page: 1, quote }] }] },
      [{ page: 1, text }],
    )[0];
    expect(candidate.values.price).toBeUndefined();
    expect(candidate.warnings.join(" ")).toContain("purchase");
  });
  it("preserves the documented CSV purchase price while rejecting lease-only and periodic price cells", () => {
    expect(extract("manufacturer,price\nAirbus,23000000", "csv").values.price).toBe(23000000);
    for (const row of ["Airbus,200000,Lease", 'Airbus,"USD 200000/month",Sale or lease']) {
      expect(extract(`manufacturer,price,offering\n${row}`, "csv").values.price).toBeUndefined();
    }
  });
  it("retains genuine dual CSV terms in their own row, including quoted evidence", () => {
    const text =
      'manufacturer,offering,price,leaseRate,leaseCurrency,leaseBasis\nAirbus,Sale or lease,"23,000,000",180000,EUR,Monthly rent';
    const candidate = extract(text, "csv");
    expect(candidate.values).toMatchObject({
      offering: "Sale or lease",
      price: 23000000,
      leaseRate: 180000,
      leaseCurrency: "EUR",
      leaseBasis: "Monthly rent",
    });
    expect(candidate.warnings).toEqual([]);
    expect(candidate.facts.every((fact) => text.includes(fact.quote))).toBe(true);
  });
  it("does not borrow currency or periodic units from another labelled aircraft or CSV row", () => {
    const text =
      "Manufacturer: Airbus\nLeaseRate: 200000\n---\nManufacturer: Boeing\nLeaseCurrency: EUR\nLeaseBasis: Monthly rent";
    const facts: Fact[] = [
      { field: "leaseRate", value: 200000, page: 1, quote: "LeaseRate: 200000" },
      { field: "leaseCurrency", value: "EUR", page: 1, quote: "LeaseCurrency: EUR" },
      { field: "leaseBasis", value: "Monthly rent", page: 1, quote: "LeaseBasis: Monthly rent" },
    ];
    expect(
      validateEvidence({ candidates: [{ facts }] }, [{ page: 1, text }])[0].values.leaseRate,
    ).toBeUndefined();
    const csv =
      "manufacturer,leaseRate,leaseCurrency,leaseBasis\nAirbus,200000,,\nBoeing,300000,EUR,Monthly rent";
    const borrowed: Fact[] = [
      { field: "leaseRate", value: 200000, page: 1, quote: "Airbus,200000,," },
      { field: "leaseCurrency", value: "EUR", page: 1, quote: "Boeing,300000,EUR,Monthly rent" },
      {
        field: "leaseBasis",
        value: "Monthly rent",
        page: 1,
        quote: "Boeing,300000,EUR,Monthly rent",
      },
    ];
    expect(
      validateEvidence({ candidates: [{ facts: borrowed }] }, [{ page: 1, text: csv }], "csv")[0]
        .values.leaseRate,
    ).toBeUndefined();
  });
  it("does not turn an explicitly unavailable sale into a dual offering", () => {
    expect(
      extract("Manufacturer: Airbus\nOffering: Not for sale, lease only").values.offering,
    ).toBe("Lease");
  });
});
