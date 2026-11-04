import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ProposalAction, Citation } from "../../lib/agents/schema";
import { validateProposedFacts } from "./evidence";
const sourceId = randomUUID();
const base: Extract<ProposalAction, { type: "requirement" }> = {
  type: "requirement",
  values: {
    client: "Fictional Buyer",
    aircraftModel: "Airbus A320",
    category: "Commercial",
    quantity: 1,
    minYear: 2010,
    engine: "",
    budget: null,
    deadline: null,
    destination: "India",
    description: "Fictional source validation only.",
    transactionKind: "Not supplied",
  },
};
const identity =
  "Fictional Buyer\nAirbus A320\nCommercial\nQuantity: 1\nMinimum year: 2010\nDestination: India";
const citations = (terms: string): Citation[] => [
  { sourceId, page: 1, quote: `${identity}\n${terms}` },
];
describe("Buyer requirement commercial evidence", () => {
  it("requires the actual commercial claims in submitted citations even when authorized source context contains them elsewhere", () => {
    const source = [
      {
        id: sourceId,
        pages: [
          {
            page: 1,
            text: `${identity}\nTransaction: Lease\nLease budget EUR: 200000 per month\nPurchase budget USD: 23000000`,
          },
        ],
      },
    ];
    const identityOnly = [{ sourceId, page: 1, quote: identity }];
    const lease = {
      ...base,
      values: {
        ...base.values,
        transactionKind: "Lease" as const,
        leaseBudget: 200000,
        leaseCurrency: "EUR",
        leaseBasis: "Monthly rent" as const,
      },
    };
    expect(() => validateProposedFacts(lease, identityOnly, source)).toThrow(/citations/);
    expect(() =>
      validateProposedFacts(
        { ...base, values: { ...base.values, transactionKind: "Sale", budget: 23000000 } },
        identityOnly,
        source,
      ),
    ).toThrow(/purchase amount/);
    expect(() =>
      validateProposedFacts(
        lease,
        [{ sourceId, page: 1, quote: `${identity}\nTransaction: Lease` }],
        source,
      ),
    ).toThrow(/currency/);
  });
  it("accepts explicit lease budget units and separate retained labelled currency/basis", () => {
    const action = {
      ...base,
      values: {
        ...base.values,
        transactionKind: "Lease" as const,
        leaseBudget: 200000,
        leaseCurrency: "EUR",
        leaseBasis: "Monthly rent" as const,
      },
    };
    expect(() =>
      validateProposedFacts(
        action,
        citations(
          "Transaction: Lease\nLease budget: 200000\nLease currency: EUR\nLease basis: Monthly rent",
        ),
      ),
    ).not.toThrow();
  });
  it.each([undefined, "Sale"] as const)(
    "rejects rental money mapped to purchase with transaction %s",
    (transactionKind) => {
      const action = { ...base, values: { ...base.values, transactionKind, budget: 200000 } };
      expect(() =>
        validateProposedFacts(
          action,
          citations("Transaction: Lease\nBudget USD: 200000 per month"),
        ),
      ).toThrow(/purchase|transaction mode/i);
    },
  );
  it("rejects a cropped model purchase quote using the actual authorized source context", () => {
    const quote = `${identity}\nBudget USD: 200000`;
    const text = `${quote} per month\nTransaction: Lease`;
    expect(() =>
      validateProposedFacts(
        { ...base, values: { ...base.values, budget: 200000, transactionKind: "Sale" } },
        [{ sourceId, page: 1, quote }],
        [{ id: sourceId, pages: [{ page: 1, text }] }],
      ),
    ).toThrow(/purchase/);
  });
  it("refuses missing lease currency/basis and fabricated units", () => {
    for (const values of [
      { leaseCurrency: null, leaseBasis: "Monthly rent" as const },
      { leaseCurrency: "EUR", leaseBasis: null },
      { leaseCurrency: "EUR", leaseBasis: "Hourly rate" as const },
    ]) {
      expect(() =>
        validateProposedFacts(
          {
            ...base,
            values: { ...base.values, transactionKind: "Lease", leaseBudget: 200000, ...values },
          },
          citations("Lease budget EUR: 200000 per month"),
        ),
      ).toThrow(/lease|Lease/);
    }
  });
  it("requires explicit unknown mode for ambiguous new briefs while preserving legacy purchase USD evidence", () => {
    expect(() =>
      validateProposedFacts(
        { ...base, values: { ...base.values, transactionKind: undefined } },
        citations("No commercial terms supplied."),
      ),
    ).toThrow(/Not supplied/);
    expect(() =>
      validateProposedFacts(
        { ...base, values: { ...base.values, transactionKind: undefined } },
        citations("Transaction: Lease"),
      ),
    ).toThrow(/Not supplied/);
    expect(() =>
      validateProposedFacts(base, citations("No commercial terms supplied.")),
    ).not.toThrow();
    expect(() =>
      validateProposedFacts(
        { ...base, values: { ...base.values, transactionKind: undefined, budget: 23000000 } },
        citations("Budget USD: 23000000"),
      ),
    ).not.toThrow();
  });
  it("binds a lease budget to the actual amount's currency and time basis", () => {
    const source = citations("Lease budget USD 200000 per month; alternative EUR 1800 per hour");
    for (const [leaseCurrency, leaseBasis] of [
      ["USD", "Hourly rate"],
      ["EUR", "Monthly rent"],
    ] as const) {
      expect(() =>
        validateProposedFacts(
          {
            ...base,
            values: {
              ...base.values,
              transactionKind: "Lease",
              leaseBudget: 200000,
              leaseCurrency,
              leaseBasis,
            },
          },
          source,
        ),
      ).toThrow(/lease budget/i);
    }
  });
});
