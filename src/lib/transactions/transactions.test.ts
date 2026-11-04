import { describe, it, expect } from "vitest";
import {
  milestoneKeys,
  transactionGaps,
  transactionActionSchema,
  type TransactionDetail,
  type TransactionEvidence,
} from "./schema";
const context = {
  cycle: 1,
  contextChanged: false,
  offers: [{ cycle: 1, status: "Accepted" }],
  findings: [],
  evidence: milestoneKeys.map((key, index) => ({
    id: String(index),
    cycle: 1,
    key,
    state: "Verification recorded",
    current: true,
  })),
} as unknown as Pick<
  TransactionDetail,
  "cycle" | "contextChanged" | "offers" | "findings" | "evidence"
>;
describe("Transaction readiness", () => {
  it("requires every applicable current-cycle record and blocks unresolved findings", () => {
    expect(transactionGaps(context, "Completed")).toEqual([]);
    expect(
      transactionGaps(
        {
          ...context,
          findings: [
            { cycle: 1, severity: "Blocking", status: "Open" },
          ] as TransactionDetail["findings"],
        },
        "Closing",
      ),
    ).toContain("Resolve every blocking finding with retained evidence.");
    expect(
      transactionGaps(
        { ...context, evidence: context.evidence.map((e) => ({ ...e, cycle: 0 })) },
        "Completed",
      ).length,
    ).toBeGreaterThan(5);
    expect(
      transactionGaps(
        {
          ...context,
          evidence: context.evidence.map((e) =>
            e.key === "Settlement" ? { ...e, current: false } : e,
          ),
        },
        "Completed",
      ),
    ).toContain("Settlement: verification recorded evidence required.");
    expect(transactionGaps({ ...context, contextChanged: true }, "Completed")).toHaveLength(1);
    expect(transactionGaps({ ...context, contextChanged: true }, "Lost")).toEqual([]);
    expect(transactionGaps({ ...context, contextChanged: true }, "Cancelled")).toEqual([]);
  });
  it("allows documented LOI/inspection waivers but never a title or settlement waiver", () => {
    const waived = context.evidence.map((e) =>
      ["Letter of intent", "Pre-purchase inspection"].includes(e.key)
        ? { ...e, state: "Waiver recorded" }
        : e,
    ) as TransactionEvidence[];
    expect(transactionGaps({ ...context, evidence: waived }, "Completed")).toEqual([]);
    expect(
      transactionGaps(
        {
          ...context,
          evidence: waived.map((e) => (e.key === "Title" ? { ...e, state: "Waiver recorded" } : e)),
        },
        "Completed",
      ),
    ).toContain("Title: verification recorded evidence required.");
  });
  it("rejects ambiguous money representations before they reach numeric persistence", () => {
    const base = {
      kind: "offer",
      side: "Buyer",
      contactId: "buyer",
      offerKind: "Offer",
      parentId: null,
      amount: "21500000.25",
      currency: "USD",
      basis: "Purchase price",
      quantity: 1,
      offeredOn: "2026-10-01",
      expiresOn: null,
      terms: "Fictional offer with stated terms only.",
      sourceId: "00000000-0000-4000-8000-000000000001",
      note: "Fictional source reviewed for engineering acceptance.",
      attested: true,
    };
    expect(transactionActionSchema.safeParse(base).success).toBe(true);
    for (const amount of ["0", "-1", "1e6", "$10", "1,000", "1.001", "9999999999999"])
      expect(transactionActionSchema.safeParse({ ...base, amount }).success).toBe(false);
  });
});
