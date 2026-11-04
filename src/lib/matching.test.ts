import { describe, expect, it } from "vitest";
import { demoWorkspace } from "./demo-data";
import { workflowFixtures } from "./execution/fixtures";
import { evaluateMatch, getMatches } from "./matching";
import type { Aircraft, Requirement } from "./schema";

describe("sourcing rules", () => {
  const aircraft = demoWorkspace.aircraft[0];
  const requirement = demoWorkspace.requirements[0];
  it("ranks a candidate that meets every known hard constraint", () => {
    expect(evaluateMatch(aircraft, requirement).state).toBe("eligible");
  });
  it("never lets a preference score compensate for an engine mismatch", () => {
    const result = evaluateMatch(
      { ...aircraft, engine: "IAE V2500", year: 2025, price: 1 },
      requirement,
    );
    expect(result.state).toBe("excluded");
    expect(result.score).toBeNull();
  });
  it("keeps unknown prices pending instead of treating them as zero", () => {
    expect(evaluateMatch({ ...aircraft, price: null }, requirement).state).toBe("needs-review");
  });
  it("requires confirmation for missing or stale availability", () => {
    expect(evaluateMatch({ ...aircraft, availableDate: null }, requirement).state).toBe(
      "needs-review",
    );
    expect(evaluateMatch({ ...aircraft, availability: "Stale" }, requirement).state).toBe(
      "needs-review",
    );
  });
  it("keeps draft buyer requirements pending", () => {
    expect(evaluateMatch(aircraft, { ...requirement, status: "Draft" }).state).toBe("needs-review");
  });
  it("excludes candidates outside the delivery window", () => {
    expect(evaluateMatch({ ...aircraft, availableDate: "2027-05-01" }, requirement).state).toBe(
      "excluded",
    );
  });
  it("deduplicates airframes using manufacturer and serial context", () => {
    expect(getMatches([aircraft, { ...aircraft, id: "duplicate" }], [requirement])).toHaveLength(1);
  });
  it("does not merge identical serials from different manufacturers", () => {
    expect(
      getMatches([aircraft, { ...aircraft, manufacturer: "Other", id: "other" }], [requirement]),
    ).toHaveLength(2);
  });

  it.each(workflowFixtures)("preserves the original $family workflow family", (fixture) => {
    const candidate = {
      ...aircraft,
      manufacturer: fixture.manufacturer,
      model: fixture.model,
      category: fixture.category,
      year: fixture.year,
      engine: fixture.engine,
      price: fixture.price,
    };
    const bareFamily = fixture.family.slice(fixture.manufacturer.length + 1);
    for (const aircraftModel of [fixture.family, bareFamily]) {
      const result = evaluateMatch(candidate, {
        ...requirement,
        aircraftModel,
        category: fixture.category,
        minYear: fixture.year,
        engine: fixture.engine,
        budget: fixture.price,
      });
      expect(result.checks[0].result).toBe("pass");
      expect(result.state).toBe("eligible");
    }
  });

  it.each([
    ["Challenger 350", "Bombardier", "Challenger 300"],
    ["Falcon 2000LXS", "Dassault", "Falcon 900LX"],
    ["Citation XLS+", "Cessna", "Citation CJ4"],
    ["Phenom 300", "Embraer", "Phenom 100"],
    ["72-600", "ATR", "72-500"],
    ["72-600", "ATR", "Boeing 72"],
    ["Falcon 2000LXS", "Dassault", "Gulfstream Falcon"],
  ])(
    "preserves a different full named variant or maker: %s versus %s %s",
    (model, manufacturer, aircraftModel) => {
      const result = evaluateMatch(
        { ...aircraft, manufacturer, model },
        { ...requirement, aircraftModel },
      );
      expect(result.checks[0].result).toBe("fail");
      expect(result.state).toBe("excluded");
    },
  );

  it.each([
    ["A319-112", "A319"],
    ["A319-112", "Airbus A319"],
    ["A320-214", "A320"],
    ["A320-214", "Airbus A320"],
    ["A319-112", "A319-112"],
    ["A319-112", "Airbus A319-112"],
    ["Airbus A319-112", "A319"],
    ["Airbus A319-112", "Airbus A319-112"],
    ["A319-112", "  AIRBUS   A319 – 112 "],
  ])("matches literal model %s against buyer designation %s", (model, aircraftModel) => {
    const result = evaluateMatch(
      { ...aircraft, manufacturer: "Airbus", model },
      { ...requirement, aircraftModel },
    );
    expect(result.state).toBe("eligible");
    expect(result.checks[0].result).toBe("pass");
  });

  it.each([
    ["A319-112", "A319-115"],
    ["A319-112", "A320"],
    ["A320-214", "Airbus A319"],
    ["A320-214", "A320-200"],
    ["A320-214", "A320ceo"],
    ["A320-214", "A320neo"],
    ["A320-214", "Boeing A320"],
  ])("excludes a different literal model or maker: %s versus %s", (model, aircraftModel) => {
    const result = evaluateMatch(
      { ...aircraft, manufacturer: "Airbus", model },
      { ...requirement, aircraftModel },
    );
    expect(result.state).toBe("excluded");
    expect(result.checks[0].result).toBe("fail");
    expect(result.score).toBeNull();
  });

  it.each([
    ["A320-214", "Airbus", "A32"],
    ["A319-112", "Airbus", "Airbus A3"],
    ["A319-112", "Airbus", "A319-1"],
    ["A319-112", "Airbus", "Airbus"],
    ["A319-112", "Airbus", "A319/A320"],
    ["A319-112", "Airbus", "A319 or A320"],
    ["G280", "Gulfstream", "G28"],
    ["Falcon 2000LXS", "Dassault", "Fal"],
    ["Phenom 300", "Embraer", "Pheno"],
    ["Challenger 350", "Bombardier", "Challenger 35"],
    ["72-600", "ATR", "7"],
  ])(
    "abstains for incomplete or ambiguous %s brief %s %s",
    (model, manufacturer, aircraftModel) => {
      const result = evaluateMatch(
        { ...aircraft, manufacturer, model },
        { ...requirement, aircraftModel },
      );
      expect(result.state).toBe("needs-review");
      expect(result.checks[0].result).toBe("unknown");
      expect(result.score).toBeNull();
    },
  );

  it("preserves an explicit buyer manufacturer even for an identical model code", () => {
    const result = evaluateMatch(
      { ...aircraft, manufacturer: "Boeing", model: "A320-214" },
      { ...requirement, aircraftModel: "Airbus A320" },
    );
    expect(result.state).toBe("excluded");
  });

  it("requires the category to match even when the bare family matches", () => {
    const result = evaluateMatch(
      { ...aircraft, manufacturer: "Airbus", model: "A319-112", category: "Business" },
      { ...requirement, category: "Commercial", aircraftModel: "A319" },
    );
    expect(result.state).toBe("excluded");
  });

  it("matches an exact business model with or without its recorded maker", () => {
    for (const aircraftModel of ["G280", "Gulfstream G280"]) {
      const result = evaluateMatch(
        { ...aircraft, manufacturer: "Gulfstream", model: "G280", category: "Business" },
        { ...requirement, category: "Business", aircraftModel },
      );
      expect(result.state).toBe("eligible");
    }
  });

  it("leaves source designations unchanged", () => {
    const item = { ...aircraft, manufacturer: "Airbus", model: "A319-112" };
    const brief = { ...requirement, aircraftModel: "  AIRBUS A319  " };
    evaluateMatch(item, brief);
    expect(item.model).toBe("A319-112");
    expect(brief.aircraftModel).toBe("  AIRBUS A319  ");
  });
});

describe("sale and lease sourcing terms", () => {
  const baseAircraft = demoWorkspace.aircraft[0];
  const baseRequirement = demoWorkspace.requirements[0];
  const leaseAircraft: Aircraft = {
    ...baseAircraft,
    offering: "Lease",
    price: null,
    leaseRate: 30000,
    leaseCurrency: "USD",
    leaseBasis: "Monthly rent",
  };
  const leaseRequirement: Requirement = {
    ...baseRequirement,
    transactionKind: "Lease",
    budget: null,
    leaseBudget: 35000,
    leaseCurrency: "USD",
    leaseBasis: "Monthly rent",
  };

  it.each([
    [undefined, undefined, "eligible"],
    ["Sale", "Sale", "eligible"],
    ["Sale", "Lease", "excluded"],
    ["Lease", "Sale", "excluded"],
    [undefined, "Lease", "excluded"],
    ["Lease", undefined, "excluded"],
    ["Sale or lease", "Sale", "eligible"],
    ["Sale or lease", "Lease", "eligible"],
    ["Not supplied", "Sale", "needs-review"],
    ["Not supplied", "Lease", "needs-review"],
    ["Sale", "Not supplied", "needs-review"],
    ["Sale or lease", "Not supplied", "needs-review"],
  ] as const)("compares offered %s with required %s as %s", (offering, transactionKind, state) => {
    const result = evaluateMatch(
      { ...leaseAircraft, price: baseAircraft.price, offering },
      {
        ...leaseRequirement,
        transactionKind,
        budget: transactionKind === "Lease" ? null : baseRequirement.budget,
      },
    );
    expect(result.state).toBe(state);
    if (state !== "eligible") expect(result.score).toBeNull();
  });

  it("keeps an explicit sale equivalent to an otherwise identical legacy sale", () => {
    const legacy = evaluateMatch(baseAircraft, baseRequirement);
    const explicit = evaluateMatch(
      { ...baseAircraft, offering: "Sale" },
      { ...baseRequirement, transactionKind: "Sale" },
    );
    expect(explicit.state).toBe(legacy.state);
    expect(explicit.score).toBe(legacy.score);
  });

  it("compares lease rent with its ceiling even when no purchase price exists", () => {
    const result = evaluateMatch(leaseAircraft, leaseRequirement);
    expect(result.state).toBe("eligible");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        label: "Lease budget per aircraft",
        result: "pass",
        detail: expect.stringContaining("USD 30000 · Monthly rent"),
      }),
    );
    expect(result.checks.some((item) => item.label === "Budget per aircraft")).toBe(false);
  });

  it("excludes unaffordable rent even when a very low purchase price is recorded", () => {
    const result = evaluateMatch(
      { ...leaseAircraft, price: 1, leaseRate: 35001 },
      leaseRequirement,
    );
    expect(result.state).toBe("excluded");
    expect(result.score).toBeNull();
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        label: "Lease budget per aircraft",
        result: "fail",
      }),
    );
  });

  it.each([
    [{ leaseRate: null }, {}],
    [{ leaseRate: undefined }, {}],
    [{ leaseCurrency: null }, {}],
    [{ leaseCurrency: undefined }, {}],
    [{ leaseBasis: null }, {}],
    [{ leaseBasis: undefined }, {}],
    [{}, { leaseBudget: null }],
    [{}, { leaseBudget: undefined }],
    [{}, { leaseCurrency: null }],
    [{}, { leaseCurrency: undefined }],
    [{}, { leaseBasis: null }],
    [{}, { leaseBasis: undefined }],
  ] satisfies [Partial<Aircraft>, Partial<Requirement>][])(
    "abstains when lease amount or units are missing: %j / %j",
    (aircraftPatch, requirementPatch) => {
      const result = evaluateMatch(
        { ...leaseAircraft, ...aircraftPatch },
        { ...leaseRequirement, ...requirementPatch },
      );
      expect(result.state).toBe("needs-review");
      expect(result.score).toBeNull();
      expect(result.checks).toContainEqual(
        expect.objectContaining({
          label: "Lease budget per aircraft",
          result: "unknown",
        }),
      );
    },
  );

  it.each([
    { leaseCurrency: "EUR" },
    { leaseBasis: "Hourly rate" },
    { leaseCurrency: "EUR", leaseBasis: "Hourly rate" },
  ] satisfies Partial<Requirement>[])("does not convert incompatible lease units %j", (patch) => {
    const result = evaluateMatch(leaseAircraft, { ...leaseRequirement, ...patch });
    expect(result.state).toBe("needs-review");
    expect(result.score).toBeNull();
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        label: "Lease budget per aircraft",
        result: "unknown",
        detail: expect.stringContaining("no conversion is inferred"),
      }),
    );
  });

  it("supports explicit hourly rent in a shared non-USD currency", () => {
    const result = evaluateMatch(
      { ...leaseAircraft, leaseRate: 2500, leaseCurrency: "EUR", leaseBasis: "Hourly rate" },
      { ...leaseRequirement, leaseBudget: 2700, leaseCurrency: "EUR", leaseBasis: "Hourly rate" },
    );
    expect(result.state).toBe("eligible");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        label: "Lease budget per aircraft",
        result: "pass",
        detail: expect.stringContaining("EUR 2500 · Hourly rate"),
      }),
    );
  });

  it.each([null, 35000])(
    "does not accept a USD purchase budget on a lease brief with rent ceiling %s",
    (leaseBudget) => {
      const result = evaluateMatch(leaseAircraft, {
        ...leaseRequirement,
        budget: 30000000,
        leaseBudget,
      });
      expect(result.state).toBe("needs-review");
      expect(result.score).toBeNull();
      expect(result.checks).toContainEqual(
        expect.objectContaining({
          label: "Purchase budget on lease brief",
          result: "unknown",
        }),
      );
      expect(result.checks.some((item) => item.label === "Budget per aircraft")).toBe(false);
    },
  );

  it("does not substitute low rent for an unknown sale asking price", () => {
    const result = evaluateMatch(
      { ...leaseAircraft, offering: "Sale or lease", price: null, leaseRate: 1 },
      { ...baseRequirement, transactionKind: "Sale", leaseBudget: 1 },
    );
    expect(result.state).toBe("needs-review");
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        label: "Budget per aircraft",
        result: "unknown",
      }),
    );
    expect(result.checks.some((item) => item.label === "Lease budget per aircraft")).toBe(false);
  });

  it("excludes an unaffordable purchase despite cheap rent and a generous lease ceiling", () => {
    const result = evaluateMatch(
      { ...baseAircraft, offering: "Sale or lease", leaseRate: 1, price: 50000000 },
      { ...baseRequirement, transactionKind: "Sale", leaseBudget: 999999999 },
    );
    expect(result.state).toBe("excluded");
    expect(result.score).toBeNull();
  });

  it("uses rent savings to rank leases independently of any purchase price", () => {
    const cheapRent = {
      ...leaseAircraft,
      id: "cheap-rent",
      serial: "LEASE-1",
      leaseRate: 32000,
      price: 90000000,
    };
    const costlyRent = {
      ...leaseAircraft,
      id: "costly-rent",
      serial: "LEASE-2",
      leaseRate: 34900,
      price: 1,
    };
    const matches = getMatches([costlyRent, cheapRent], [leaseRequirement]);
    expect(matches.every((item) => item.state === "eligible")).toBe(true);
    expect(matches.map((item) => item.aircraft.id)).toEqual(["cheap-rent", "costly-rent"]);
    expect(evaluateMatch({ ...cheapRent, price: 1 }, leaseRequirement).score).toBe(
      matches[0].score,
    );
  });

  it("keeps sale ranking independent of recorded lease rents and ceilings", () => {
    const sale = evaluateMatch(baseAircraft, baseRequirement);
    const withRent = evaluateMatch(
      {
        ...baseAircraft,
        offering: "Sale or lease",
        leaseRate: 999999999,
        leaseCurrency: "EUR",
        leaseBasis: "Hourly rate",
      },
      {
        ...baseRequirement,
        transactionKind: "Sale",
        leaseBudget: 1,
        leaseCurrency: "JPY",
        leaseBasis: "Monthly rent",
      },
    );
    expect(withRent.state).toBe(sale.state);
    expect(withRent.score).toBe(sale.score);
  });
});
