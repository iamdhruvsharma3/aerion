import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { pool, workspaceFor, transaction, type Scope } from "../db";
import { createSource, mutateWorkspace, readWorkspace } from "../repository";
import { fingerprint } from "../agents/evidence";
import { createEngagement, mutateRevenue } from "../revenue/repository";
import { demoAircraft } from "../../lib/demo-data";
import { emptyWorkspace } from "../../lib/workspace";
import { calendarDate } from "../../lib/format";
import type { MilestoneKey, TransactionAction } from "../../lib/transactions/schema";
import {
  readTransaction,
  readTransactions,
  mutateTransaction,
  readTransactionCompletion,
} from "./workflow";
const testUrl = process.env.AERION_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("Source-backed transaction lifecycle", () => {
  const actors = [randomUUID(), randomUUID()],
    dealId = `FICTIONAL-DEAL-${randomUUID()}`,
    today = calendarDate(),
    note =
      "Fictional engineering fixture reviewed. No real counterparty, authority, acceptance, transaction or payment is represented.";
  let a: Scope,
    b: Scope,
    sourceId: string,
    secondSource: string,
    foreignSource: string,
    offerId: string;
  async function change(action: TransactionAction, key = randomUUID()) {
    const state = await readTransaction(a, dealId);
    return mutateTransaction(a, dealId, state.revision, key, action);
  }
  async function recordEvidence(key: MilestoneKey, source = sourceId) {
    await change({
      kind: "evidence",
      key,
      sourceId: source,
      occurredOn: today,
      party: "Fictional fixture organization",
      detail: note,
      note,
      attested: true,
    });
    let evidence = (await readTransaction(a, dealId)).evidence.find(
      (e) => e.current && e.key === key && e.cycle === 1,
    );
    if (!evidence) throw new Error("Expected current evidence");
    await change({
      kind: "evidence-decision",
      evidenceId: evidence.id,
      state: "Reviewed",
      recordedBy: "Fictional founder",
      occurredOn: today,
      note,
      attested: true,
    });
    await change({
      kind: "evidence-decision",
      evidenceId: evidence.id,
      state: "Verification recorded",
      recordedBy: "Fictional qualified reviewer",
      occurredOn: today,
      note,
      attested: true,
    });
    evidence = (await readTransaction(a, dealId)).evidence.find((e) => e.id === evidence?.id);
    if (!evidence) throw new Error("Expected persisted evidence after verification");
    return evidence;
  }
  const advance = (
    status: "Offer" | "LOI" | "Agreement" | "Inspection" | "Closing" | "Completed",
    source: string | null = null,
  ) =>
    change({
      kind: "transition",
      status,
      sourceId: source,
      occurredOn: today,
      note,
      attested: true,
    });
  beforeAll(async () => {
    if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
      throw new Error("Dedicated _test database required");
    process.env.DATABASE_URL = testUrl;
    a = await workspaceFor(actors[0]);
    b = await workspaceFor(actors[1]);
    const aircraft = {
      ...demoAircraft[0],
      id: "fictional-aircraft",
      serial: `FICTIONAL-${randomUUID()}`,
    };
    await mutateWorkspace(
      a,
      {
        type: "migrate",
        workspace: {
          ...emptyWorkspace,
          aircraft: [aircraft],
          requirements: [
            {
              id: "fictional-requirement",
              client: "Fictional Meridian",
              aircraftModel: "Airbus A320",
              category: "Commercial",
              quantity: 1,
              minYear: 2010,
              engine: "CFM56",
              budget: 30000000,
              deadline: "2027-12-01",
              destination: "India",
              status: "Confirmed",
              description: note,
            },
          ],
          contacts: [
            {
              id: "fictional-buyer",
              name: "Fictional Buyer",
              company: "Fictional Meridian",
              email: "buyer@example.com",
              role: "Fictional acquisitions",
              location: "India",
              type: "Buyer",
              notes: note,
            },
            {
              id: "fictional-seller",
              name: "Fictional Seller",
              company: "Fictional Seller Co",
              email: "seller@example.com",
              role: "Fictional seller",
              location: "France",
              type: "Seller",
              notes: note,
            },
          ],
          deals: [
            {
              id: dealId,
              title: "Fictional transaction lifecycle",
              aircraftId: aircraft.id,
              requirementId: "fictional-requirement",
              stage: "Sourcing",
              nextAction: "Review fictional source evidence",
              dueDate: today,
            },
          ],
        },
      },
      0,
    );
    for (const [index, content] of [note, `${note} Revised fictional evidence.`].entries()) {
      const source = await createSource(a, {
        title: `Fictional lifecycle evidence ${index}`,
        kind: "text",
        sourceUrl: null,
        filename: `fictional-${index}.txt`,
        contentType: "text/plain",
        original: Buffer.from(content),
        pages: [{ page: 1, text: content }],
      });
      if (index === 0) sourceId = source.id;
      else secondSource = source.id;
    }
    foreignSource = (
      await createSource(b, {
        title: "Fictional foreign owner evidence",
        kind: "text",
        sourceUrl: null,
        filename: "foreign.txt",
        contentType: "text/plain",
        original: Buffer.from(`${note} Foreign owner.`),
        pages: [{ page: 1, text: note }],
      })
    ).id;
  });
  afterAll(async () => {
    if (!a) return;
    const db = await pool().connect();
    try {
      await db.query("begin");
      for (const table of [
        "activity",
        "revenue_operations",
        "revenue_earnings",
        "revenue_engagements",
        "transaction_requests",
        "transaction_offer_decisions",
        "transaction_offers",
        "transaction_evidence",
        "transaction_findings",
        "transaction_cases",
        "sources",
      ])
        await db.query(`delete from aerion.${table} where workspace_id=any($1::uuid[])`, [
          [a.workspaceId, b.workspaceId],
        ]);
      await db.query("delete from aerion.workspaces where owner_id=any($1::uuid[])", [actors]);
      await db.query("commit");
    } finally {
      db.release();
      await pool().end();
    }
  });
  it("starts from an actual saved opportunity and enforces ownership, revisions and request identity", async () => {
    expect((await readTransaction(a, dealId)).status).toBe("Sourcing");
    await expect(readTransaction(b, dealId)).rejects.toThrow("not found");
    const action = {
        kind: "configure",
        transactionKind: "Sale",
        nextAction: "Review the fictional offer and identify all missing evidence",
        dueOn: today,
        note,
      } as const,
      key = randomUUID();
    const initial = await readTransaction(a, dealId);
    const first = await mutateTransaction(a, dealId, initial.revision, key, action);
    expect(first.detail.revision).toBe(1);
    expect((await mutateTransaction(a, dealId, 0, key, action)).reused).toBe(true);
    await expect(mutateTransaction(a, dealId, 0, randomUUID(), action)).rejects.toThrow("changed");
    await expect(
      mutateTransaction(a, dealId, 1, key, {
        ...action,
        nextAction: "Different action with reused key",
      }),
    ).rejects.toThrow("different");
    expect((await readTransactions(b)).some((t) => t.dealId === dealId)).toBe(false);
  });
  it("retains immutable offer versions and evidence-backed decisions while blocking inconsistent scope", async () => {
    const offer = {
      kind: "offer",
      side: "Buyer",
      contactId: "fictional-buyer",
      offerKind: "Offer",
      parentId: null,
      amount: "21500000.25",
      currency: "USD",
      basis: "Purchase price",
      quantity: 1,
      offeredOn: today,
      expiresOn: null,
      terms: note,
      sourceId,
      note,
      attested: true,
    } as const;
    expect((await readTransaction(a, dealId)).requirement?.quantity).toBe(1);
    await expect(change({ ...offer, quantity: 50 })).rejects.toThrow("one saved aircraft serial");
    await change(offer);
    offerId = (await readTransaction(a, dealId)).offers[0].id;
    await expect(change({ ...offer, sourceId: foreignSource })).rejects.toThrow(
      "from this workspace",
    );
    await expect(change({ ...offer, currency: "EUR" })).rejects.toThrow("remain consistent");
    await expect(change({ ...offer, contactId: "someone-else" })).rejects.toThrow("saved contact");
    await expect(change({ ...offer, offeredOn: "2099-01-01" })).rejects.toThrow("future");
    await change({
      kind: "offer-decision",
      offerId,
      decision: "Accepted",
      sourceId,
      decidedOn: today,
      recordedBy: "Fictional buyer representative",
      note,
      attested: true,
    });
    expect((await readTransaction(a, dealId)).offers[0].status).toBe("Accepted");
    const priorId = offerId;
    await change({
      ...offer,
      side: "Seller",
      contactId: "fictional-seller",
      offerKind: "Counteroffer",
      parentId: priorId,
      amount: "21600000.50",
    });
    let offers = (await readTransaction(a, dealId)).offers;
    expect(offers.find((o) => o.id === priorId)?.status).toBe("Withdrawn");
    offerId = offers[0].id;
    expect(offers[0].parentId).toBe(priorId);
    await change({
      kind: "offer-decision",
      offerId,
      decision: "Accepted",
      sourceId,
      decidedOn: today,
      recordedBy: "Fictional buyer representative",
      note,
      attested: true,
    });
    offers = (await readTransaction(a, dealId)).offers;
    expect(offers.filter((o) => o.status === "Accepted")).toHaveLength(1);
    await expect(
      transaction(a.actorId, a.workspaceId, (db) =>
        db.query("update aerion.transaction_offers set amount=1 where id=$1", [offerId]),
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(advance("Agreement")).rejects.toThrow("one stage");
    await expect(advance("Offer")).rejects.toThrow("Representation");
  });
  it("keeps a multi-aircraft confirmed brief split into serial-specific offer scopes", async () => {
    let workspace = await readWorkspace(a);
    const requirement = {
      ...workspace.data.requirements[0],
      id: `FICTIONAL-MULTI-${randomUUID()}`,
      quantity: 3,
    };
    await mutateWorkspace(a, { type: "requirement", item: requirement }, workspace.revision);
    workspace = await readWorkspace(a);
    const deal = {
      ...workspace.data.deals[0],
      id: `FICTIONAL-SERIAL-${randomUUID()}`,
      requirementId: requirement.id,
    };
    await mutateWorkspace(a, { type: "deal", item: deal }, workspace.revision);
    const offer = {
      kind: "offer",
      side: "Buyer",
      contactId: "fictional-buyer",
      offerKind: "Offer",
      parentId: null,
      amount: "21500000.25",
      currency: "USD",
      basis: "Purchase price",
      quantity: 3,
      offeredOn: today,
      expiresOn: null,
      terms: note,
      sourceId,
      note,
      attested: true,
    } as const;
    await expect(mutateTransaction(a, deal.id, 0, randomUUID(), offer)).rejects.toThrow(
      "one saved aircraft serial",
    );
    const saved = await mutateTransaction(a, deal.id, 0, randomUUID(), { ...offer, quantity: 1 });
    expect(saved.detail.requirement?.quantity).toBe(3);
    expect(saved.detail.offers[0].quantity).toBe(1);
    expect(saved.detail.singleAircraftScopeInvalid).toBe(false);
  });
  it("retains inflated legacy offers but blocks progression, completion eligibility and new closing fees", async () => {
    const workspace = await readWorkspace(a);
    const legacyDeals = ["Closing", "Completed"].map((status) => ({
      ...workspace.data.deals[0],
      id: `FICTIONAL-LEGACY-${status}-${randomUUID()}`,
      title: `Fictional legacy inflated ${status} transaction`,
    }));
    await pool().query("update aerion.workspaces set data=$1,revision=revision+1 where id=$2", [
      { ...workspace.data, deals: [...workspace.data.deals, ...legacyDeals] },
      a.workspaceId,
    ]);
    for (const [index, deal] of legacyDeals.entries()) {
      const completed = index === 1,
        offerId = randomUUID();
      // Owner-only fixtures represent records retained before the single-serial guard existed.
      await pool().query(
        "insert into aerion.transaction_cases(workspace_id,deal_id,context_hash,status,completed_on,completion_source_id) values($1,$2,$3,$4,$5,$6)",
        [
          a.workspaceId,
          deal.id,
          fingerprint({
            dealId: deal.id,
            aircraftId: deal.aircraftId,
            requirementId: deal.requirementId,
          }),
          completed ? "Completed" : "Closing",
          completed ? today : null,
          completed ? sourceId : null,
        ],
      );
      await pool().query(
        "insert into aerion.transaction_offers(id,workspace_id,deal_id,cycle,side,contact_id,contact_name,contact_email,offer_kind,amount,currency,basis,quantity,offered_on,terms,source_id,note,actor_id) values($1,$2,$3,1,'Buyer','fictional-buyer','Fictional Buyer','buyer@example.com','Offer',21500000.25,'USD','Purchase price',50,$4,$5,$6,$5,$7)",
        [offerId, a.workspaceId, deal.id, today, note, sourceId, a.actorId],
      );
      await pool().query(
        "insert into aerion.transaction_offer_decisions(id,workspace_id,deal_id,cycle,offer_id,decision,source_id,decided_on,recorded_by,note,actor_id) values($1,$2,$3,1,$4,'Accepted',$5,$6,'Fictional reviewer',$7,$8)",
        [randomUUID(), a.workspaceId, deal.id, offerId, sourceId, today, note, a.actorId],
      );
      const detail = await readTransaction(a, deal.id);
      expect(detail.singleAircraftScopeInvalid).toBe(true);
      expect(detail.contextChanged).toBe(true);
      expect(detail.offers[0].quantity).toBe(50);
      expect(
        await transaction(a.actorId, a.workspaceId, (db) =>
          readTransactionCompletion(db, a, deal.id),
        ),
      ).toMatchObject({
        status: completed ? "Completed" : "Closing",
        contextChanged: true,
        completionSourceId: null,
      });
    }
    const active = legacyDeals[0],
      completed = legacyDeals[1];
    await expect(
      mutateTransaction(a, active.id, 0, randomUUID(), {
        kind: "transition",
        status: "Completed",
        sourceId,
        occurredOn: today,
        note,
        attested: true,
      }),
    ).rejects.toThrow("one saved aircraft serial");
    const archived = await mutateTransaction(a, active.id, 0, randomUUID(), {
      kind: "transition",
      status: "Lost",
      sourceId,
      occurredOn: today,
      note,
      attested: true,
    });
    expect(archived.detail.status).toBe("Lost");
    const reopened = await mutateTransaction(a, active.id, archived.detail.revision, randomUUID(), {
      kind: "reopen",
      sourceId,
      occurredOn: today,
      nextAction: "Requalify this single saved aircraft with new evidence",
      note,
      attested: true,
    });
    expect(reopened.detail.singleAircraftScopeInvalid).toBe(false);
    expect(reopened.detail.cycle).toBe(2);
    expect(reopened.detail.offers[0].quantity).toBe(50);
    expect(reopened.detail.offers[0].cycle).toBe(1);

    let engagement = await createEngagement(a, {
      idempotencyKey: randomUUID(),
      terms: {
        title: "Fictional legacy inflated closing fee",
        clientContactId: "fictional-buyer",
        payerContactId: "fictional-buyer",
        representation: "Buyer sourcing",
        requirementId: completed.requirementId,
        dealId: completed.id,
        scope: note,
        startsOn: today,
        endsOn: null,
        currency: "USD",
        feeType: "Fixed",
        fixedAmount: "1000.00",
        percentage: null,
        estimateBasis: null,
        basisDescription: "Fictional fixed closing service fee",
        earningTrigger: "Closing",
        earningTerms: note,
        paymentTerms: "Fictional payment after supported completion",
        signedSourceId: sourceId,
        signatory: "Fictional Client",
        signedOn: today,
      },
    });
    engagement = await mutateRevenue(a, engagement.engagement.id, {
      revision: engagement.engagement.revision,
      idempotencyKey: randomUUID(),
      action: { kind: "activate", note, attested: true },
    });
    await expect(
      mutateRevenue(a, engagement.engagement.id, {
        revision: engagement.engagement.revision,
        idempotencyKey: randomUUID(),
        action: {
          kind: "earn",
          earnedOn: today,
          basisAmount: null,
          sourceId,
          note,
          attested: true,
        },
      }),
    ).rejects.toThrow("current, completed closing evidence");
    const historical = await readTransaction(a, completed.id);
    expect(historical.status).toBe("Completed");
    expect(historical.offers[0].quantity).toBe(50);
  });
  it("advances only after reviewed current milestones and resolves blocking inspection/title conditions", async () => {
    await recordEvidence("Representation");
    await recordEvidence("Availability");
    await advance("Offer");
    await expect(advance("LOI")).rejects.toThrow("Letter of intent");
    await recordEvidence("Letter of intent");
    await advance("LOI");
    await expect(
      change({
        kind: "offer",
        side: "Seller",
        contactId: "fictional-seller",
        offerKind: "Counteroffer",
        parentId: offerId,
        amount: "21600000.00",
        currency: "USD",
        basis: "Purchase price",
        quantity: 1,
        offeredOn: today,
        expiresOn: null,
        terms: note,
        sourceId,
        note,
        attested: true,
      }),
    ).rejects.toThrow("locked");
    await change({
      kind: "evidence",
      key: "Executed agreement",
      sourceId,
      occurredOn: today,
      party: "Fictional parties",
      detail: note,
      note,
      attested: true,
    });
    const agreement = (await readTransaction(a, dealId)).evidence.find(
      (e) => e.key === "Executed agreement",
    );
    if (!agreement) throw new Error("Expected executed agreement evidence");
    await expect(
      change({
        kind: "evidence-decision",
        evidenceId: agreement.id,
        state: "Verification recorded",
        recordedBy: "Fictional counsel",
        occurredOn: today,
        note,
        attested: true,
      }),
    ).rejects.toThrow("Review");
    await change({
      kind: "evidence-decision",
      evidenceId: agreement.id,
      state: "Reviewed",
      recordedBy: "Fictional founder",
      occurredOn: today,
      note,
      attested: true,
    });
    await change({
      kind: "evidence-decision",
      evidenceId: agreement.id,
      state: "Verification recorded",
      recordedBy: "Fictional counsel",
      occurredOn: today,
      note,
      attested: true,
    });
    await advance("Agreement");
    await recordEvidence("Technical records");
    await advance("Inspection");
    await recordEvidence("Pre-purchase inspection");
    await recordEvidence("Title");
    await change({
      kind: "finding",
      category: "Title",
      severity: "Blocking",
      title: "Fictional lien release evidence outstanding",
      detail: note,
      sourceId,
      dueOn: today,
      note,
      attested: true,
    });
    await expect(advance("Closing")).rejects.toThrow("blocking");
    const finding = (await readTransaction(a, dealId)).findings[0];
    await change({
      kind: "resolve-finding",
      findingId: finding.id,
      resolution: "Remedied",
      sourceId: secondSource,
      recordedBy: "Fictional title reviewer",
      occurredOn: today,
      note,
      attested: true,
    });
    await advance("Closing");
    await expect(advance("Completed", sourceId)).rejects.toThrow("Settlement");
  });
  it("replaces evidence with a new unreviewed version, then records supported completion and invalidates it on reopening", async () => {
    await change({
      kind: "evidence",
      key: "Title",
      sourceId: secondSource,
      occurredOn: today,
      party: "Fictional title reviewer",
      detail: note,
      note,
      attested: true,
    });
    const title = (await readTransaction(a, dealId)).evidence.find(
      (e) => e.key === "Title" && e.current,
    );
    if (!title) throw new Error("Expected current title evidence");
    await expect(
      change({
        kind: "evidence-decision",
        evidenceId: title.id,
        state: "Waiver recorded",
        recordedBy: "Fictional founder",
        occurredOn: today,
        note,
        attested: true,
      }),
    ).rejects.toThrow("Only reviewed LOI");
    await change({
      kind: "evidence-decision",
      evidenceId: title.id,
      state: "Reviewed",
      recordedBy: "Fictional founder",
      occurredOn: today,
      note,
      attested: true,
    });
    await change({
      kind: "evidence-decision",
      evidenceId: title.id,
      state: "Verification recorded",
      recordedBy: "Fictional title reviewer",
      occurredOn: today,
      note,
      attested: true,
    });
    await recordEvidence("Settlement");
    await recordEvidence("Delivery acceptance", secondSource);
    await expect(advance("Completed", sourceId)).rejects.toThrow("current verified delivery");
    await advance("Completed", secondSource);
    const completion = await transaction(a.actorId, a.workspaceId, (db) =>
      readTransactionCompletion(db, a, dealId),
    );
    expect(completion).toMatchObject({
      status: "Completed",
      cycle: 1,
      completedOn: today,
      completionSourceId: secondSource,
      contextChanged: false,
    });
    await expect(
      change({
        kind: "finding",
        category: "Other",
        severity: "Question",
        title: "Cannot edit completed case",
        detail: note,
        sourceId,
        dueOn: null,
        note,
        attested: true,
      }),
    ).rejects.toThrow("terminal");
    await change({
      kind: "reopen",
      occurredOn: today,
      sourceId: secondSource,
      nextAction: "Review fictional changed scope for a new cycle",
      note,
      attested: true,
    });
    const reopened = await readTransaction(a, dealId);
    expect(reopened).toMatchObject({
      status: "Sourcing",
      cycle: 2,
      completedOn: null,
      completionSourceId: null,
    });
    expect(reopened.offers).toHaveLength(2);
    expect(reopened.evidence.some((e) => e.cycle === 1)).toBe(true);
    expect(
      await transaction(a.actorId, a.workspaceId, (db) => readTransactionCompletion(db, a, dealId)),
    ).toMatchObject({ status: "Sourcing", cycle: 2, completionSourceId: null });
    await expect(advance("Offer")).rejects.toThrow("Representation");
  });
  it("records loss/cancellation evidence, keeps the outcome history and serializes competing writes", async () => {
    await change({
      kind: "transition",
      status: "Lost",
      occurredOn: today,
      sourceId,
      note,
      attested: true,
    });
    await change({
      kind: "reopen",
      occurredOn: today,
      sourceId,
      nextAction: "Fictional third-cycle sourcing review",
      note,
      attested: true,
    });
    const state = await readTransaction(a, dealId),
      action = {
        kind: "configure",
        transactionKind: "Sale",
        nextAction: "Fictional concurrency check in isolated test scope",
        dueOn: null,
        note,
      } as const;
    const results = await Promise.allSettled([
      mutateTransaction(a, dealId, state.revision, randomUUID(), action),
      mutateTransaction(a, dealId, state.revision, randomUUID(), action),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    await change({
      kind: "transition",
      status: "Cancelled",
      occurredOn: today,
      sourceId: secondSource,
      note,
      attested: true,
    });
    const final = await readTransaction(a, dealId);
    expect(final.status).toBe("Cancelled");
    expect(
      final.activity.filter((a) => a.action === "transaction.transition").length,
    ).toBeGreaterThanOrEqual(8);
  });
});
