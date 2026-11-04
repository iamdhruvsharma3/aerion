import { describe, expect, it } from "vitest";
import { demoAircraft, demoWorkspace } from "../demo-data";
import type { Claim, DraftInput } from "./schema";
import { composeDraft } from "./drafts";

const claim = (field: string, label: string, value: string | number): Claim => ({
  field,
  label,
  value,
  attribution: "Founder-recorded brief",
  href: "/sources",
  sourceId: null,
  quote: "Fictional retained engineering evidence only.",
  page: null,
});
const base: DraftInput = {
  aircraft: demoAircraft[0],
  requirement: demoWorkspace.requirements[0],
  contact: demoWorkspace.contacts[0],
  confirmation: {
    contact: "Fictional buyer",
    confirmedOn: "2026-11-01",
    basis: "Fictional engineering fixture only.",
    origin: "execution",
    href: "/execution",
  },
  audience: "Buyer",
  claims: [],
};
describe("Commercial units in private sourcing drafts", () => {
  it("keeps legacy sale amounts explicitly in USD per aircraft purchase terms", () => {
    const draft = composeDraft({
      ...base,
      claims: [
        claim("aircraft.price", "Asking purchase price", 21000000),
        claim("requirement.budget", "Purchase ceiling", 23000000),
      ],
    });
    expect(draft.subject).toContain("Sale sourcing");
    expect(draft.body).toContain("21000000 USD per aircraft (purchase)");
    expect(draft.body).toContain("23000000 USD per aircraft (purchase)");
  });
  it("uses the lease currency and monthly unit and excludes purchase-only claims", () => {
    const draft = composeDraft({
      ...base,
      aircraft: {
        ...base.aircraft,
        offering: "Sale or lease",
        leaseRate: 200000,
        leaseCurrency: "EUR",
        leaseBasis: "Monthly rent",
      },
      requirement: {
        ...base.requirement,
        transactionKind: "Lease",
        budget: null,
        leaseBudget: 250000,
        leaseCurrency: "EUR",
        leaseBasis: "Monthly rent",
      },
      claims: [
        claim("aircraft.price", "Purchase price", 21000000),
        claim("requirement.budget", "Purchase ceiling", 23000000),
        claim("aircraft.leaseRate", "Asking lease rate", 200000),
        claim("requirement.leaseBudget", "Lease ceiling", 250000),
      ],
    });
    expect(draft.subject).toContain("Lease sourcing");
    expect(draft.body).toContain("200,000 EUR / month per aircraft");
    expect(draft.body).toContain("250,000 EUR / month per aircraft");
    expect(draft.body).not.toContain("USD per aircraft");
    expect(draft.body).not.toContain("21000000");
    expect(draft.body).not.toContain("23000000");
  });
  it("preserves an hourly lease amount and its recorded currency without converting to a monthly or purchase amount", () => {
    const draft = composeDraft({
      ...base,
      aircraft: {
        ...base.aircraft,
        offering: "Lease",
        leaseRate: 1234.567,
        leaseCurrency: "KWD",
        leaseBasis: "Hourly rate",
      },
      requirement: {
        ...base.requirement,
        transactionKind: "Lease",
        budget: null,
        leaseBudget: 1500.25,
        leaseCurrency: "KWD",
        leaseBasis: "Hourly rate",
      },
      claims: [
        claim("aircraft.leaseRate", "Asking lease rate", 1234.567),
        claim("requirement.leaseBudget", "Lease ceiling", 1500.25),
      ],
    });
    expect(draft.body).toContain("1,234.567 KWD / flight hour per aircraft");
    expect(draft.body).toContain("1,500.25 KWD / flight hour per aircraft");
    expect(draft.body).not.toContain("USD");
    expect(draft.body).not.toContain("month");
  });
  it("requires clarification instead of drafting an explicit unknown or contradictory commercial basis", () => {
    const claims = [claim("aircraft.serial", "Serial", "Fictional")];
    expect(() =>
      composeDraft({
        ...base,
        claims,
        requirement: { ...base.requirement, transactionKind: "Not supplied" },
      }),
    ).toThrow("Clarify and confirm");
    expect(() =>
      composeDraft({ ...base, claims, aircraft: { ...base.aircraft, offering: "Not supplied" } }),
    ).toThrow("Clarify and confirm");
    expect(() =>
      composeDraft({
        ...base,
        claims,
        requirement: { ...base.requirement, transactionKind: "Lease" },
        aircraft: { ...base.aircraft, offering: "Sale" },
      }),
    ).toThrow("Clarify and confirm");
  });
});
