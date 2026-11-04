import { describe, expect, it } from "vitest";
import { demoWorkspace } from "./demo-data";
import { aircraftTerms, leaseTerms, readRequirementTerms, requirementTerms } from "./sourcing";
import { requirementSchema } from "./schema";

describe("commercial terms at manual intake and display", () => {
  it("preserves legacy purchase semantics and makes the currency and ceiling explicit", () => {
    expect(aircraftTerms(demoWorkspace.aircraft[0])).toContain("USD purchase price");
    expect(requirementTerms(demoWorkspace.requirements[0])).toContain(
      "USD purchase ceiling per aircraft",
    );
  });
  it("does not abbreviate small lease amounts into a purchase-price label", () => {
    expect(leaseTerms(2350.25, "EUR", "Hourly rate")).toBe("2,350.25 EUR / flight hour");
    expect(leaseTerms(200000, "USD", "Monthly rent")).toBe("200,000 USD / month");
    expect(leaseTerms(1234.567, "KWD", "Monthly rent")).toBe("1,234.567 KWD / month");
    expect(leaseTerms(200000, null, null)).toBe("200,000 currency unconfirmed / basis unconfirmed");
    expect(
      aircraftTerms({
        ...demoWorkspace.aircraft[0],
        offering: "Lease",
        leaseRate: 2350.25,
        leaseCurrency: "EUR",
        leaseBasis: "Hourly rate",
      }),
    ).toBe("2,350.25 EUR / flight hour");
  });
  it("shows both source-supported asking bases while keeping unknown mode explicit", () => {
    const aircraft = {
      ...demoWorkspace.aircraft[0],
      offering: "Sale or lease" as const,
      leaseRate: 200000,
      leaseCurrency: "USD",
      leaseBasis: "Monthly rent" as const,
    };
    expect(aircraftTerms(aircraft)).toContain("USD purchase price · Lease: 200,000 USD / month");
    expect(aircraftTerms({ ...aircraft, offering: "Not supplied" })).toBe(
      "Sale / lease terms unconfirmed",
    );
    expect(
      requirementTerms({ ...demoWorkspace.requirements[0], transactionKind: "Not supplied" }),
    ).toContain("unconfirmed");
  });
  it("clears hidden purchase ceilings from lease form submissions and preserves the lease units", () => {
    const form = new FormData();
    for (const [key, value] of Object.entries({
      transactionKind: "Lease",
      budget: "23000000",
      leaseBudget: "225000.50",
      leaseCurrency: "eur",
      leaseBasis: "Monthly rent",
    }))
      form.set(key, value);
    const terms = readRequirementTerms(form);
    expect(terms).toEqual({
      transactionKind: "Lease",
      budget: null,
      leaseBudget: 225000.5,
      leaseCurrency: "EUR",
      leaseBasis: "Monthly rent",
    });
    expect(requirementTerms({ ...demoWorkspace.requirements[0], ...terms })).toBe(
      "Lease ceiling: 225,000.5 EUR / month per aircraft",
    );
    form.set("transactionKind", "Sale");
    expect(readRequirementTerms(form)).toEqual({
      transactionKind: "Sale",
      budget: 23000000,
      leaseBudget: null,
      leaseCurrency: null,
      leaseBasis: null,
    });
  });
  it("does not invent a kind or currency on an unanswered brief and rejects malformed inputs", () => {
    const form = new FormData();
    expect(readRequirementTerms(form)).toEqual({
      transactionKind: "Not supplied",
      budget: null,
      leaseBudget: null,
      leaseCurrency: null,
      leaseBasis: null,
    });
    form.set("transactionKind", "Lease");
    form.set("leaseBudget", "unquoted");
    expect(
      requirementSchema.safeParse({
        ...demoWorkspace.requirements[0],
        ...readRequirementTerms(form),
      }).success,
    ).toBe(false);
  });
});
