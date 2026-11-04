import { describe, expect, it } from "vitest";
import { milestoneKeys } from "../../lib/transactions/schema";
import type {
  CommercialContext,
  CommercialEngagement,
  CommercialTransaction,
  ContextCoverage,
} from "./commercial-context";
import { commercialInsights } from "./commercial-rules";

// Fictional in-memory records only. No database, providers or actual client events.
const today = "2026-11-03";
const id = (value: number) => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const count = (total: number, shown = total): ContextCoverage => ({
  total,
  shown,
  truncated: total - shown,
});

function offer(
  overrides: Partial<CommercialTransaction["offers"][number]> = {},
): CommercialTransaction["offers"][number] {
  return {
    id: id(20),
    side: "Buyer",
    contactId: id(21),
    offerKind: "Offer",
    parentId: null,
    amount: "21000000.00",
    currency: "USD",
    basis: "Purchase price",
    quantity: 1,
    offeredOn: "2026-10-01",
    expiresOn: null,
    terms: "Fictional serial-specific terms retained for a pure test.",
    sourceId: id(22),
    status: "Accepted",
    decisionSourceId: id(23),
    decidedOn: "2026-10-02",
    recordedBy: "Fictional accountable reviewer",
    ...overrides,
  };
}

function transaction(overrides: Partial<CommercialTransaction> = {}): CommercialTransaction {
  return {
    dealId: id(1),
    title: "Fictional serial-specific opportunity",
    aircraftId: id(2),
    requirementId: id(3),
    managed: true,
    legacyStage: "Sourcing",
    status: "Completed",
    cycle: 1,
    revision: 9,
    transactionKind: "Sale",
    contextChanged: false,
    supersededRequirement: false,
    nextAction: "Historical sourcing follow-up that must not reopen a terminal case",
    dueOn: "2026-10-01",
    completedOn: "2026-10-30",
    completionSourceId: id(4),
    offers: [offer()],
    milestones: milestoneKeys.map((key, index) => ({
      evidenceId: id(100 + index),
      key,
      sourceId: id(200 + index),
      occurredOn: "2026-10-30",
      party: "Fictional accountable party",
      detail: "Fictional retained milestone evidence reviewed for this cycle.",
      state: "Verification recorded",
      reviewer: "Fictional founder reviewer",
      reviewedOn: "2026-10-30",
    })),
    findings: [],
    coverage: { offers: count(1), milestones: count(milestoneKeys.length), findings: count(0) },
    ...overrides,
  };
}

function engagement(overrides: Partial<CommercialEngagement> = {}): CommercialEngagement {
  return {
    id: id(10),
    revision: 4,
    status: "Active",
    effectiveStatus: "Active",
    dealId: id(1),
    requirementId: id(3),
    title: "Fictional reviewed fee engagement",
    representation: "Buyer sourcing",
    scope: "Fictional scope for the single saved serial-specific opportunity.",
    startsOn: "2026-10-01",
    endsOn: "2026-12-31",
    currency: "USD",
    feeType: "Fixed",
    fixedAmount: "1000.00",
    percentage: null,
    basisDescription: "Fictional fixed fee, no percentage inference.",
    earningTrigger: "Closing",
    earningTerms: "Fictional signed condition: actual completed delivery.",
    paymentTerms: "Fictional payment terms: due on the issued invoice date.",
    signedSourceId: id(11),
    signedOn: "2026-10-01",
    signatory: "Fictional signatory",
    endedOn: null,
    endedSourceId: null,
    totals: {
      earnedMinor: "100000",
      invoicedMinor: "100000",
      invoiceTotalMinor: "100000",
      receivedMinor: "100000",
      outstandingMinor: "0",
    },
    earnings: [
      {
        id: id(12),
        earnedOn: "2026-10-30",
        amountMinor: "100000",
        sourceId: id(4),
        status: "Recorded",
        voidSourceId: null,
      },
    ],
    invoices: [
      {
        id: id(13),
        number: "FICTIONAL-2026-001",
        status: "Issued",
        currency: "USD",
        issuedOn: "2026-10-30",
        dueOn: "2026-11-01",
        totalMinor: "100000",
        receivedMinor: "100000",
        outstandingMinor: "0",
      },
    ],
    coverage: { earnings: count(1), invoices: count(1) },
    ...overrides,
  };
}

function context(transactions = [transaction()], engagements = [engagement()]): CommercialContext {
  return {
    transactions,
    engagements,
    sourceIds: [id(4), id(11)],
    revisionState: {
      requirementId: id(3),
      aircraftId: null,
      requalificationRequired: transactions.some((item) => item.supersededRequirement),
      transactions: transactions.map((item) => ({
        dealId: item.dealId,
        aircraftId: item.aircraftId,
        revision: item.revision,
        cycle: item.cycle,
        status: item.status,
        legacyStage: item.legacyStage,
        nextAction: item.nextAction,
        dueOn: item.dueOn ?? "",
      })),
      engagements: engagements.map((item) => ({
        id: item.id,
        revision: item.revision,
        dealId: item.dealId,
      })),
    },
    coverage: { transactions: count(transactions.length), engagements: count(engagements.length) },
  };
}

function unearnedEngagement(): CommercialEngagement {
  return engagement({
    totals: {
      earnedMinor: "0",
      invoicedMinor: "0",
      invoiceTotalMinor: "0",
      receivedMinor: "0",
      outstandingMinor: "0",
    },
    earnings: [],
    invoices: [],
    coverage: { earnings: count(0), invoices: count(0) },
  });
}

describe("saved commercial observations", () => {
  it.each(["due-diligence", "deal-coordination"] as const)(
    "keeps a reviewed, earned and fully paid completion quiet for %s",
    (role) => {
      const result = commercialInsights(context(), today, role);
      expect(result.tasks).toEqual([]);
      expect(result.findings).toHaveLength(2);
      expect(result.findings.every((item) => item.severity === "info")).toBe(true);
      expect(result.findings.map((item) => item.title)).toEqual([
        "Transaction: Fictional serial-specific opportunity",
        "Engagement: Fictional reviewed fee engagement",
      ]);
    },
  );

  it.each(["Completed", "Lost", "Cancelled"] as const)(
    "does not revive %s cases from retained next actions, missing milestones or expired offers",
    (status) => {
      const input = context([
        transaction({
          status,
          offers: [offer({ status: "Recorded", expiresOn: "2026-10-01" })],
          milestones: [],
          coverage: { offers: count(1), milestones: count(0), findings: count(0) },
        }),
      ]);
      const result = commercialInsights(input, today, "deal-coordination");
      expect(result.tasks).toEqual([]);
      expect(result.findings.every((item) => item.severity === "info")).toBe(true);
      expect(JSON.stringify(result)).not.toMatch(
        /Before |Transaction follow-up:|Review offer expiry:/,
      );
    },
  );

  it.each([
    ["USD", "123456", "58443", "65013", "USD 650.13"],
    ["JPY", "123456", "58443", "65013", "JPY 65,013"],
    ["KWD", "1234567", "584442", "650125", "KWD 650.125"],
  ] as const)(
    "reports only the actual remaining %s invoice balance without inventing a receipt",
    (currency, total, received, outstanding, display) => {
      const item = engagement();
      item.currency = currency;
      item.fixedAmount =
        currency === "JPY" ? "123456" : currency === "KWD" ? "1234.567" : "1234.56";
      item.earnings[0].amountMinor = total;
      item.totals = {
        earnedMinor: total,
        invoicedMinor: total,
        invoiceTotalMinor: total,
        receivedMinor: received,
        outstandingMinor: outstanding,
      };
      item.invoices[0] = {
        ...item.invoices[0],
        currency,
        totalMinor: total,
        receivedMinor: received,
        outstandingMinor: outstanding,
      };
      const result = commercialInsights(
        context([transaction()], [item]),
        today,
        "deal-coordination",
      );
      const invoiceFinding = result.findings.find((entry) =>
        entry.title.startsWith("Overdue invoice:"),
      );
      expect(invoiceFinding?.detail).toContain(`${display} outstanding; due 2026-11-01`);
      expect(invoiceFinding?.detail).toContain("An issued invoice is not a received payment");
      expect(result.tasks).toEqual([
        expect.objectContaining({
          title: `Review invoice payment: ${id(13)}`,
          dueDate: "2026-11-01",
          detail: expect.stringContaining("only after funds actually arrive"),
        }),
      ]);
    },
  );

  it("does not follow up a voided invoice or reinterpret its historical amount as outstanding", () => {
    const item = engagement();
    item.invoices.push({
      ...item.invoices[0],
      id: id(14),
      number: "FICTIONAL-VOIDED-001",
      status: "Voided",
      receivedMinor: "0",
      outstandingMinor: "0",
    });
    item.coverage.invoices = count(2);
    const result = commercialInsights(context([transaction()], [item]), today, "deal-coordination");
    expect(result.tasks).toEqual([]);
    expect(result.findings.every((entry) => entry.severity === "info")).toBe(true);
  });

  it("does not propose earning from an incomplete closing or legacy Closing stage", () => {
    const input = context(
      [
        transaction({
          status: "Closing",
          legacyStage: "Closing",
          completedOn: null,
          completionSourceId: null,
        }),
      ],
      [unearnedEngagement()],
    );
    const result = commercialInsights(input, today, "deal-coordination");
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        title: "Closing fee condition: Fictional reviewed fee engagement",
        severity: "missing",
        detail: expect.stringContaining("No current eligible completion"),
      }),
    );
    expect(result.tasks.some((item) => /earning|invoice eligibility/.test(item.title))).toBe(false);
  });

  it("requests an evidence review rather than asserting earnings after eligible completion", () => {
    const result = commercialInsights(
      context([transaction()], [unearnedEngagement()]),
      today,
      "deal-coordination",
    );
    expect(result.tasks).toEqual([
      expect.objectContaining({
        title: `Review earning evidence: ${id(10)}`,
        detail: expect.stringContaining("only if the actual agreed event occurred"),
      }),
    ]);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        title: "Closing fee condition: Fictional reviewed fee engagement",
        detail: expect.stringContaining("no earned fee has been recorded"),
      }),
    );
  });

  it("targets the specific open title issue and recorded offer expiry without claiming acceptance", () => {
    const input = context([
      transaction({
        status: "Inspection",
        findings: [
          {
            id: id(30),
            category: "Title",
            severity: "Blocking",
            title: "Fictional lien release missing",
            detail: "Retain a discharge response for the fictional recorded lien.",
            sourceId: id(31),
            dueOn: "2026-11-04",
            status: "Open",
          },
        ],
        offers: [
          offer(),
          offer({
            id: id(32),
            status: "Recorded",
            expiresOn: "2026-11-04",
            decisionSourceId: null,
            decidedOn: null,
            recordedBy: null,
          }),
        ],
        coverage: { offers: count(2), milestones: count(milestoneKeys.length), findings: count(1) },
      }),
    ]);
    const result = commercialInsights(input, today, "deal-coordination");
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        title: "Blocking finding: Fictional lien release missing",
        severity: "missing",
        detail: expect.stringContaining("Title"),
      }),
    );
    expect(result.tasks).toContainEqual(
      expect.objectContaining({
        title: `Resolve finding: Fictional lien release missing · ${id(30)}`,
        dueDate: "2026-11-04",
        detail: expect.stringContaining("retain the response"),
      }),
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        title: "Offer expiry: Fictional serial-specific opportunity",
        detail: expect.stringContaining("Recorded terms are not an acceptance"),
      }),
    );
    expect(result.tasks).toContainEqual(
      expect.objectContaining({
        title: `Review offer expiry: ${id(32)}`,
        dueDate: "2026-11-04",
      }),
    );
  });

  it.each([
    { contextChanged: true, supersededRequirement: false },
    { contextChanged: false, supersededRequirement: true },
  ])("blocks new closing-earning progress for changed context %j", (changed) => {
    const result = commercialInsights(
      context([transaction(changed)], [unearnedEngagement()]),
      today,
      "deal-coordination",
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        title: "Requalification required: Fictional serial-specific opportunity",
        severity: "missing",
      }),
    );
    expect(
      result.tasks.some((item) =>
        /earning evidence|invoice eligibility|Transaction follow-up/.test(item.title),
      ),
    ).toBe(false);
    expect(result.findings).not.toContainEqual(
      expect.objectContaining({
        detail: expect.stringContaining("Current completion evidence is recorded"),
      }),
    );
  });

  it.each([
    { contextChanged: true, supersededRequirement: false },
    { contextChanged: false, supersededRequirement: true },
  ])("limits a changed active transaction to requalification work %j", (changed) => {
    const result = commercialInsights(
      context([transaction({ ...changed, status: "Inspection" })], [unearnedEngagement()]),
      today,
      "deal-coordination",
    );
    expect(result.tasks).toEqual([
      expect.objectContaining({
        title: `Review transaction context: Fictional serial-specific opportunity · ${id(1)}`,
        detail: expect.stringContaining("current buyer brief and serial-specific opportunity"),
      }),
    ]);
    expect(result.findings.some((item) => item.title.startsWith("Before "))).toBe(false);
  });

  it("keeps draft fee terms at agreement review despite a completed transaction", () => {
    const item = unearnedEngagement();
    item.status = "Draft";
    item.effectiveStatus = "Draft";
    item.signedSourceId = null;
    item.signedOn = null;
    item.signatory = "";
    const result = commercialInsights(context([transaction()], [item]), today, "deal-coordination");
    expect(result.tasks.map((entry) => entry.title)).toEqual([
      `Review engagement activation: ${id(10)}`,
    ]);
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        title: "Unsigned engagement: Fictional reviewed fee engagement",
        detail: expect.stringContaining("do not establish a signed agreement"),
      }),
    );
  });

  it("retains factual outstanding invoices after context changes without inventing a new earning", () => {
    const item = engagement();
    item.totals.receivedMinor = "40000";
    item.totals.outstandingMinor = "60000";
    item.invoices[0] = { ...item.invoices[0], receivedMinor: "40000", outstandingMinor: "60000" };
    const result = commercialInsights(
      context([transaction({ contextChanged: true })], [item]),
      today,
      "deal-coordination",
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        title: "Overdue invoice: FICTIONAL-2026-001",
        detail: expect.stringContaining("USD 600.00 outstanding"),
      }),
    );
    expect(result.tasks.map((entry) => entry.title)).toEqual([`Review invoice payment: ${id(13)}`]);
  });

  it("does not claim an engagement is missing when its revision is linked outside the displayed list", () => {
    const input = context();
    input.engagements = [];
    input.coverage.engagements = count(1, 0);
    const result = commercialInsights(input, today, "deal-coordination");
    expect(result.tasks).toEqual([]);
    expect(result.findings.some((entry) => /Fee agreement not linked/.test(entry.title))).toBe(
      false,
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({
        title: "Commercial review is bounded",
        detail: expect.stringContaining("1 linked records exceed"),
      }),
    );
  });

  it("does not assert there is no accepted offer beyond a truncated offer window", () => {
    const item = transaction({
      status: "Offer",
      offers: Array.from({ length: 5 }, (_, index) =>
        offer({ id: id(40 + index), status: "Recorded" }),
      ),
      coverage: {
        offers: count(6, 5),
        milestones: count(milestoneKeys.length),
        findings: count(0),
      },
    });
    const result = commercialInsights(context([item]), today, "due-diligence");
    expect(JSON.stringify(result)).not.toMatch(
      /Record an accepted offer|Record a source-backed offer/,
    );
    expect(result.findings).toContainEqual(
      expect.objectContaining({ title: "Commercial review is bounded" }),
    );
    expect(result.tasks).toEqual([]);

    item.coverage.offers = count(5);
    const completeWindow = commercialInsights(context([item]), today, "due-diligence");
    expect(JSON.stringify(completeWindow)).toContain("Record an accepted offer");
  });

  it("bounds follow-up tasks to eight and reports omitted review work", () => {
    const transactions = Array.from({ length: 10 }, (_, index) =>
      transaction({
        dealId: id(300 + index),
        title: `Fictional active opportunity ${index + 1}`,
        status: "Inspection",
        milestones: [],
        offers: [],
        coverage: { offers: count(0), milestones: count(0), findings: count(0) },
      }),
    );
    const result = commercialInsights(context(transactions, []), today, "deal-coordination");
    expect(result.tasks).toHaveLength(8);
    expect(result.findings.length).toBeLessThanOrEqual(35);
    expect(result.findings[0].title).toBe("Commercial review is bounded");
    expect(result.findings[0].detail).toContain("at most 8 follow-up proposals");
    expect(new Set(result.tasks.map((entry) => entry.title)).size).toBe(result.tasks.length);
  });

  it("does not mutate the supplied records while preparing either role's observations", () => {
    const input = context([transaction({ status: "Inspection" })], [unearnedEngagement()]);
    const retained = structuredClone(input);
    commercialInsights(input, today, "due-diligence");
    commercialInsights(input, today, "deal-coordination");
    expect(input).toEqual(retained);
  });
});
