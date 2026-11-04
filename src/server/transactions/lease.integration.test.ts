import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calendarDate } from "../../lib/format";
import { milestoneKeys, type TransactionAction } from "../../lib/transactions/schema";
import { fingerprint } from "../agents/evidence";
import { pool, transaction, workspaceFor, type Scope } from "../db";
import { mutateExecution, readExecution } from "../execution";
import {
  createSource,
  decideReview,
  mutateWorkspace,
  readPipeline,
  readWorkspace,
} from "../repository";
import { enqueueExtraction, processNext } from "../jobs";
import {
  mutateTransaction,
  readTransaction,
  readTransactionCompletion,
  readTransactions,
} from "./workflow";

const testUrl = process.env.AERION_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("Explicit lease sourcing through the transaction lifecycle", () => {
  const actorId = randomUUID(),
    today = calendarDate(),
    requirementId = randomUUID(),
    dealId = randomUUID(),
    buyerId = randomUUID();
  const note =
    "Fictional lease engineering evidence only. No actual aircraft, buyer, contract, verification, payment or commission exists.";
  let scope: Scope, aircraftId: string, sourceId: string;
  async function change(action: TransactionAction) {
    return mutateTransaction(
      scope,
      dealId,
      (await readTransaction(scope, dealId)).revision,
      randomUUID(),
      action,
    );
  }
  async function amend(
    update: (data: Awaited<ReturnType<typeof readWorkspace>>["data"]) => unknown,
  ) {
    const workspace = await readWorkspace(scope);
    await pool().query("update aerion.workspaces set data=$1,revision=revision+1 where id=$2", [
      update(workspace.data),
      scope.workspaceId,
    ]);
  }
  beforeAll(async () => {
    if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
      throw new Error("Dedicated *_test database required.");
    process.env.DATABASE_URL = testUrl;
    scope = await workspaceFor(actorId);
    const text = `Manufacturer: Airbus\nModel: A320-214\nSerial: FICTIONAL-LEASE-${randomUUID()}\nCategory: Commercial\nYear: 2014\nEngine: CFM56-5B\nOffering: Lease\nLease rate: 200000 EUR per month\nLocation: Fictional location\nCountry: Fictional country\nAvailableDate: ${today}\n${note}`;
    sourceId = (
      await createSource(scope, {
        title: "Fictional lease source and agreed terms",
        kind: "text",
        sourceUrl: null,
        filename: "fictional-lease.txt",
        contentType: "text/plain",
        original: Buffer.from(text),
        pages: [{ page: 1, text }],
      })
    ).id;
    await enqueueExtraction(scope, sourceId, "local");
    await processNext(scope);
    const review = (await readPipeline(scope)).reviews.find((item) => item.sourceId === sourceId);
    if (!review) throw new Error("Missing lease aircraft source review.");
    const approved = await decideReview(scope, review.id, {
      decision: "approve",
      values: {
        ...review.values,
        offering: "Lease",
        price: null,
        leaseRate: 200000,
        leaseCurrency: "EUR",
        leaseBasis: "Monthly rent",
      },
      note,
      attested: true,
    });
    if (!approved.aircraftId) throw new Error("Missing source-reviewed lease aircraft.");
    aircraftId = approved.aircraftId;
    let workspace = await readWorkspace(scope);
    workspace = await mutateWorkspace(
      scope,
      {
        type: "requirement",
        item: {
          id: requirementId,
          client: "Fictional Lease Buyer",
          aircraftModel: "Airbus A320",
          category: "Commercial",
          quantity: 1,
          minYear: 2010,
          engine: "CFM56",
          budget: null,
          transactionKind: "Lease",
          leaseBudget: 250000,
          leaseCurrency: "EUR",
          leaseBasis: "Monthly rent",
          deadline: "2027-12-01",
          destination: "Fictional destination",
          status: "Draft",
          description: note,
        },
      },
      workspace.revision,
    );
    await mutateWorkspace(
      scope,
      {
        type: "contact",
        item: {
          id: buyerId,
          name: "Fictional Lease Buyer",
          company: "Fictional Leasing Company",
          role: "Fictional leasing desk",
          email: "lease-fixture@example.com",
          location: "Fictional",
          type: "Buyer",
          notes: note,
        },
      },
      workspace.revision,
    );
    await mutateExecution(
      scope,
      requirementId,
      {
        type: "confirm-brief",
        confirmation: {
          contact: "Fictional Lease Buyer",
          confirmedOn: today,
          basis: `${note} EUR 250000 ceiling per aircraft per month; no purchase budget is recorded for this lease.`,
        },
        attested: true,
      },
      0,
    );
    let desk = await readExecution(scope, requirementId);
    await mutateExecution(
      scope,
      requirementId,
      { type: "shortlist", aircraftId, decision: "Shortlisted", reason: note },
      desk.revision,
    );
    desk = await readExecution(scope, requirementId);
    await mutateExecution(
      scope,
      requirementId,
      { type: "link-contact", contactId: buyerId },
      desk.revision,
    );
    workspace = await readWorkspace(scope);
    await mutateWorkspace(
      scope,
      {
        type: "deal",
        item: {
          id: dealId,
          title: "Fictional single-aircraft EUR monthly lease",
          aircraftId,
          requirementId,
          stage: "Sourcing",
          nextAction: "Review fictional lease terms and evidence",
          dueDate: today,
        },
      },
      workspace.revision,
    );
  });
  afterAll(async () => {
    if (!scope) return;
    const db = await pool().connect();
    try {
      await db.query("begin");
      for (const table of [
        "activity",
        "transaction_requests",
        "transaction_offer_decisions",
        "transaction_offers",
        "transaction_evidence",
        "transaction_findings",
        "transaction_cases",
        "outreach_drafts",
        "shortlist_decisions",
        "case_contacts",
        "execution_cases",
        "reviews",
        "extractions",
        "sources",
      ])
        await db.query(`delete from aerion.${table} where workspace_id=$1`, [scope.workspaceId]);
      await db.query("delete from aerion.workspaces where id=$1 and owner_id=$2", [
        scope.workspaceId,
        actorId,
      ]);
      await db.query("commit");
    } finally {
      db.release();
      await pool().end();
    }
  });
  const offer = () =>
    ({
      kind: "offer",
      side: "Buyer",
      contactId: buyerId,
      offerKind: "Offer",
      parentId: null,
      amount: "200000.00",
      currency: "EUR",
      basis: "Monthly rent",
      quantity: 1,
      offeredOn: today,
      expiresOn: null,
      terms: note,
      sourceId,
      note,
      attested: true,
    }) as const;
  it("defaults to Lease, rejects a sale override, and uses precise lease claims in the outreach draft", async () => {
    expect((await readTransaction(scope, dealId)).transactionKind).toBe("Lease");
    expect(
      (await readTransactions(scope)).find((item) => item.dealId === dealId)?.transactionKind,
    ).toBe("Lease");
    await expect(
      change({ kind: "configure", transactionKind: "Sale", nextAction: note, dueOn: null, note }),
    ).rejects.toThrow("must match");
    const desk = await readExecution(scope, requirementId);
    await mutateExecution(
      scope,
      requirementId,
      { type: "prepare-draft", aircraftId, contactId: buyerId, audience: "Buyer" },
      desk.revision,
    );
    const draft = (await readExecution(scope, requirementId)).drafts[0];
    expect(draft.subject).toContain("Lease sourcing");
    expect(draft.body).toContain("250,000 EUR / month per aircraft");
    expect(draft.body).toContain("200,000 EUR / month per aircraft");
    expect(draft.body).not.toContain("USD per aircraft");
    expect(
      draft.claims.some(
        (claim) => claim.field === "requirement.budget" || claim.field === "aircraft.price",
      ),
    ).toBe(false);
    await amend((data) => ({
      ...data,
      requirements: data.requirements.map((item) =>
        item.id === requirementId ? { ...item, budget: 1 } : item,
      ),
    }));
    await expect(change(offer())).rejects.toThrow(
      "a purchase budget cannot serve as a lease ceiling",
    );
    await amend((data) => ({
      ...data,
      requirements: data.requirements.map((item) =>
        item.id === requirementId ? { ...item, budget: null } : item,
      ),
    }));
  });
  it("retains an oversized rejected offer but accepts only the confirmed currency, basis and lease ceiling", async () => {
    await expect(change({ ...offer(), basis: "Purchase price" })).rejects.toThrow("price basis");
    await expect(change({ ...offer(), currency: "USD" })).rejects.toThrow(
      "confirmed lease currency",
    );
    await expect(change({ ...offer(), basis: "Hourly rate" })).rejects.toThrow(
      "confirmed lease currency",
    );
    await change({ ...offer(), amount: "300000.00" });
    let version = (await readTransaction(scope, dealId)).offers[0];
    await expect(
      change({
        kind: "offer-decision",
        offerId: version.id,
        decision: "Accepted",
        sourceId,
        decidedOn: today,
        recordedBy: "Fictional buyer",
        note,
        attested: true,
      }),
    ).rejects.toThrow("exceeds the confirmed lease ceiling");
    await change({
      kind: "offer-decision",
      offerId: version.id,
      decision: "Rejected",
      sourceId,
      decidedOn: today,
      recordedBy: "Fictional buyer",
      note,
      attested: true,
    });
    await change({ ...offer(), offerKind: "Counteroffer", parentId: version.id });
    version = (await readTransaction(scope, dealId)).offers[0];
    await change({
      kind: "offer-decision",
      offerId: version.id,
      decision: "Accepted",
      sourceId,
      decidedOn: today,
      recordedBy: "Fictional buyer",
      note,
      attested: true,
    });
    expect(
      (await readTransaction(scope, dealId)).offers.filter((item) => item.status === "Accepted"),
    ).toHaveLength(1);
  });
  it("completes the evidenced lease lifecycle without inferring a commission", async () => {
    for (const key of milestoneKeys) {
      await change({
        kind: "evidence",
        key,
        sourceId,
        occurredOn: today,
        party: "Fictional named lease reviewer",
        detail: note,
        note,
        attested: true,
      });
      const current = (await readTransaction(scope, dealId)).evidence.find(
        (item) => item.current && item.key === key,
      );
      if (!current) throw new Error("Missing lease evidence.");
      for (const state of ["Reviewed", "Verification recorded"] as const)
        await change({
          kind: "evidence-decision",
          evidenceId: current.id,
          state,
          recordedBy: "Fictional named lease reviewer",
          occurredOn: today,
          note,
          attested: true,
        });
    }
    for (const status of [
      "Offer",
      "LOI",
      "Agreement",
      "Inspection",
      "Closing",
      "Completed",
    ] as const)
      await change({
        kind: "transition",
        status,
        sourceId: status === "Completed" ? sourceId : null,
        occurredOn: today,
        note,
        attested: true,
      });
    expect(
      await transaction(scope.actorId, scope.workspaceId, (db) =>
        readTransactionCompletion(db, scope, dealId),
      ),
    ).toMatchObject({ status: "Completed", contextChanged: false, completionSourceId: sourceId });
    expect(
      (
        await pool().query(
          "select count(*)::int n from aerion.revenue_earnings where workspace_id=$1",
          [scope.workspaceId],
        )
      ).rows[0].n,
    ).toBe(0);
  });
  it("blocks changed lease scope until a new cycle and keeps historical completion records", async () => {
    await amend((data) => ({
      ...data,
      requirements: data.requirements.map((item) =>
        item.id === requirementId ? { ...item, leaseBudget: 225000 } : item,
      ),
    }));
    expect(
      await transaction(scope.actorId, scope.workspaceId, (db) =>
        readTransactionCompletion(db, scope, dealId),
      ),
    ).toMatchObject({ status: "Completed", contextChanged: true, completionSourceId: null });
    const historical = await readTransaction(scope, dealId);
    expect(historical.completedOn).toBe(today);
    expect(historical.evidence).toHaveLength(9);
    await change({
      kind: "reopen",
      sourceId,
      occurredOn: today,
      nextAction: "Reconfirm revised fictional lease terms for this serial",
      note,
      attested: true,
    });
    expect((await readTransaction(scope, dealId)).cycle).toBe(2);
    expect((await readTransaction(scope, dealId)).transactionKind).toBe("Lease");
    await change(offer());
    await amend((data) => ({
      ...data,
      aircraft: data.aircraft.map((item) =>
        item.id === aircraftId ? { ...item, leaseRate: 210000 } : item,
      ),
    }));
    await expect(
      change({ kind: "configure", transactionKind: "Lease", nextAction: note, dueOn: null, note }),
    ).rejects.toThrow("Reopen the cycle");
  });
  it("requires clarification for explicit unknown kinds and keeps omitted legacy fingerprints compatible", async () => {
    await amend((data) => ({
      ...data,
      requirements: data.requirements.map((item) =>
        item.id === requirementId ? { ...item, transactionKind: "Not supplied" } : item,
      ),
    }));
    await expect(
      change({
        kind: "reopen",
        sourceId,
        occurredOn: today,
        nextAction: note,
        note,
        attested: true,
      }),
    ).rejects.toThrow("Clarify and reconfirm");
    const legacyId = randomUUID(),
      workspace = await readWorkspace(scope),
      legacyRequirement = { ...workspace.data.requirements[0] },
      legacyAircraft = { ...workspace.data.aircraft[0] };
    for (const field of ["transactionKind", "leaseBudget", "leaseCurrency", "leaseBasis"] as const)
      delete legacyRequirement[field];
    for (const field of ["offering", "leaseRate", "leaseCurrency", "leaseBasis"] as const)
      delete legacyAircraft[field];
    const legacyDeal = { ...workspace.data.deals[0], id: legacyId };
    await amend((data) => ({
      ...data,
      requirements: [legacyRequirement],
      aircraft: [legacyAircraft],
      deals: [...data.deals, legacyDeal],
    }));
    await pool().query(
      "insert into aerion.transaction_cases(workspace_id,deal_id,transaction_kind,context_hash,status,completed_on,completion_source_id) values($1,$2,'Lease',$3,'Completed',$4,$5)",
      [
        scope.workspaceId,
        legacyId,
        fingerprint({ dealId: legacyId, aircraftId, requirementId }),
        today,
        sourceId,
      ],
    );
    expect(
      await transaction(scope.actorId, scope.workspaceId, (db) =>
        readTransactionCompletion(db, scope, legacyId),
      ),
    ).toMatchObject({ status: "Completed", contextChanged: false, completionSourceId: sourceId });
  });
});
