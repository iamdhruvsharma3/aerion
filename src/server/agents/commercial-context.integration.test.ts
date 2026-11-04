import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { calendarDate } from "../../lib/format";
import { demoAircraft } from "../../lib/demo-data";
import { emptyWorkspace } from "../../lib/workspace";
import type { EngagementTerms, RevenueAction } from "../../lib/revenue/schema";
import { milestoneKeys, type TransactionAction } from "../../lib/transactions/schema";
import { pool, transaction, workspaceFor, type Scope } from "../db";
import { createSource, mutateWorkspace } from "../repository";
import { mutateTransaction, readTransaction } from "../transactions/workflow";
import { createEngagement, mutateRevenue, readRevenueDetail } from "../revenue/repository";
import { fingerprint } from "./evidence";
import { AgentTools } from "./tools";
import { enqueueAgent, readAgentRun, decideProposal, retainProposal } from "./repository";
import { processNextAgent } from "./runtime";
import { discoverSources } from "../discovery/service";
import { mutateLeadCase } from "../leads/workflow";
import {
  retainEmailUpload,
  actOnCommunication,
  readCommunicationMessage,
} from "../communication/service";
import type { AgentId } from "../../lib/agents/catalog";
import type { AgentRunDetail, RunInput } from "../../lib/agents/schema";
import type { CommercialContext } from "./commercial-context";
import {
  commercialContextInTransaction,
  commercialRevisionStateInTransaction,
  readCommercialContext,
} from "./commercial-context";

const testUrl = process.env.AERION_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("Authoritative agent commercial context", () => {
  const actors = [randomUUID(), randomUUID()];
  const requirementId = `fictional-requirement-${randomUUID()}`;
  const otherRequirementId = `fictional-other-requirement-${randomUUID()}`;
  const recordedOn = calendarDate(new Date(Date.now() - 86400000));
  const note =
    "Clearly fictional commercial-context acceptance fixture only; no real authority, offer, transaction, communication or money movement.";
  const deals = Array.from({ length: 12 }, (_, index) => ({
    id: `fictional-${index.toString().padStart(2, "0")}-${randomUUID()}`,
    title: `Fictional agent case ${index}`,
    aircraftId: `fictional-aircraft-${index}`,
    requirementId,
    stage: "Sourcing" as const,
    nextAction: "Review the fictional original source",
    dueDate: recordedOn,
  }));
  const otherDealId = `fictional-other-deal-${randomUUID()}`;
  const doneId = deals[0].id,
    activeId = deals[1].id,
    lostId = deals[2].id;
  let a: Scope,
    b: Scope,
    activeSource: string,
    doneSource: string,
    signedSource: string,
    unrelatedSource: string,
    foreignSource: string,
    activeEngagementId: string,
    otherEngagementId: string,
    differentAircraftEngagementId: string,
    hiddenEngagementId: string;
  async function retain(scope: Scope, title: string) {
    const text = `${note} ${title}`;
    return (
      await createSource(scope, {
        title,
        kind: "text",
        sourceUrl: null,
        filename: "fictional-context.txt",
        contentType: "text/plain",
        original: Buffer.from(text),
        pages: [{ page: 1, text }],
      })
    ).id;
  }
  async function change(dealId: string, action: TransactionAction) {
    const detail = await readTransaction(a, dealId);
    return mutateTransaction(a, dealId, detail.revision, randomUUID(), action);
  }
  async function revenue(id: string, action: RevenueAction) {
    const detail = await readRevenueDetail(a, id);
    return mutateRevenue(a, id, {
      revision: detail.engagement.revision,
      idempotencyKey: randomUUID(),
      action,
    });
  }
  function input(agentId: AgentId, aircraftId: string | null = deals[0].aircraftId): RunInput {
    return {
      agentId,
      provider: "rules",
      requirementId,
      aircraftId,
      contactId: null,
      sourceIds: [],
      connectorIds: [],
      objective: note,
      allowExternalSources: false,
      allowModelData: false,
      allowMailbox: false,
      idempotencyKey: randomUUID(),
    };
  }
  async function runRole(agentId: AgentId, aircraftId: string | null = deals[0].aircraftId) {
    const queued = await enqueueAgent(a, input(agentId, aircraftId));
    await processNextAgent(a);
    const detail = await readAgentRun(a, queued.id);
    expect(detail.error).toBeNull();
    expect(["completed", "review", "needs-input"]).toContain(detail.status);
    return detail;
  }
  function toolsFor(detail: AgentRunDetail) {
    return new AgentTools(
      a,
      detail,
      new AbortController().signal,
      async () => {},
      async () => {},
    );
  }
  const paymentProposal = (detail: AgentRunDetail) => {
    const proposal = detail.proposals.find((item) =>
      item.title.startsWith("Review invoice payment:"),
    );
    if (!proposal)
      throw new Error(
        `Expected a real unpaid-invoice follow-up, got ${detail.error ?? JSON.stringify(detail.proposals)}`,
      );
    return proposal;
  };
  function terms(dealId: string, reqId = requirementId, evidence = signedSource): EngagementTerms {
    return {
      title: `Fictional fee ${randomUUID()}`,
      clientContactId: "fictional-buyer",
      payerContactId: "fictional-buyer",
      representation: "Buyer sourcing",
      requirementId: reqId,
      dealId,
      scope: note,
      startsOn: recordedOn,
      endsOn: null,
      currency: "USD",
      feeType: "Fixed",
      fixedAmount: "1000",
      percentage: null,
      estimateBasis: null,
      basisDescription: "Fictional completed sourcing service",
      earningTrigger: "Closing",
      earningTerms:
        "Fictional fee becomes earned only against reviewed completed transaction evidence.",
      paymentTerms: "Fictional invoice due on the stated invoice date.",
      signedSourceId: evidence,
      signatory: "Fictional Signatory",
      signedOn: recordedOn,
    };
  }
  async function completeFictionalDeal() {
    for (const key of milestoneKeys) {
      await change(doneId, {
        kind: "evidence",
        key,
        sourceId: doneSource,
        occurredOn: recordedOn,
        party: "Fictional counterparty",
        detail: note,
        note,
        attested: true,
      });
      const record = (await readTransaction(a, doneId)).evidence.find(
        (e) => e.key === key && e.current,
      );
      if (!record) throw new Error("Expected retained fictional milestone");
      for (const state of ["Reviewed", "Verification recorded"] as const)
        await change(doneId, {
          kind: "evidence-decision",
          evidenceId: record.id,
          state,
          recordedBy: "Fictional named qualified reviewer",
          occurredOn: recordedOn,
          note,
          attested: true,
        });
    }
    await change(doneId, {
      kind: "offer",
      side: "Buyer",
      contactId: "fictional-buyer",
      offerKind: "Offer",
      parentId: null,
      amount: "23000000",
      currency: "USD",
      basis: "Purchase price",
      quantity: 1,
      offeredOn: recordedOn,
      expiresOn: recordedOn,
      terms: note,
      sourceId: doneSource,
      note,
      attested: true,
    });
    const offer = (await readTransaction(a, doneId)).offers[0];
    await change(doneId, {
      kind: "offer-decision",
      offerId: offer.id,
      decision: "Accepted",
      sourceId: doneSource,
      decidedOn: recordedOn,
      recordedBy: "Fictional Founder",
      note,
      attested: true,
    });
    for (const status of [
      "Offer",
      "LOI",
      "Agreement",
      "Inspection",
      "Closing",
      "Completed",
    ] as const)
      await change(doneId, {
        kind: "transition",
        status,
        occurredOn: recordedOn,
        sourceId: status === "Completed" ? doneSource : null,
        note,
        attested: true,
      });
  }
  beforeAll(async () => {
    if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
      throw new Error("A dedicated _test database is required.");
    process.env.DATABASE_URL = testUrl;
    execFileSync(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
      env: { ...process.env, DATABASE_URL: testUrl },
      stdio: "pipe",
    });
    a = await workspaceFor(actors[0]);
    b = await workspaceFor(actors[1]);
    await mutateWorkspace(
      a,
      {
        type: "migrate",
        workspace: {
          ...emptyWorkspace,
          aircraft: deals.map((deal, index) => ({
            ...demoAircraft[0],
            id: deal.aircraftId,
            serial: `FICTIONAL-CONTEXT-${index}-${randomUUID()}`,
          })),
          requirements: [requirementId, otherRequirementId].map((id) => ({
            id,
            client: "Fictional Commercial Context Buyer",
            aircraftModel: "Airbus A320",
            category: "Commercial" as const,
            quantity: 1,
            minYear: 2010,
            engine: "CFM56",
            budget: 30000000,
            deadline: "2027-12-01",
            destination: "India",
            status: "Confirmed" as const,
            description: note,
          })),
          contacts: [
            {
              id: "fictional-buyer",
              name: "Fictional Buyer",
              company: "Fictional Aircraft Company",
              role: "Fictional acquisitions",
              email: "context-fixture@example.com",
              location: "India",
              type: "Buyer",
              notes: note,
            },
          ],
          deals: [...deals, { ...deals[0], id: otherDealId, requirementId: otherRequirementId }],
        },
      },
      0,
    );
    activeSource = await retain(a, "Fictional current offer, title question and milestone");
    doneSource = await retain(a, "Fictional verified completion evidence");
    signedSource = await retain(a, "Fictional signed fee agreement");
    unrelatedSource = await retain(a, "Fictional unrelated requirement private evidence");
    foreignSource = await retain(b, "Fictional other owner's private evidence");
    await completeFictionalDeal();
    await change(activeId, {
      kind: "offer",
      side: "Buyer",
      contactId: "fictional-buyer",
      offerKind: "Offer",
      parentId: null,
      amount: "21000000",
      currency: "USD",
      basis: "Purchase price",
      quantity: 1,
      offeredOn: recordedOn,
      expiresOn: recordedOn,
      terms: note,
      sourceId: activeSource,
      note,
      attested: true,
    });
    await change(activeId, {
      kind: "evidence",
      key: "Title",
      sourceId: activeSource,
      occurredOn: recordedOn,
      party: "Fictional title reviewer",
      detail: note,
      note,
      attested: true,
    });
    await change(activeId, {
      kind: "finding",
      category: "Title",
      severity: "Blocking",
      title: "Fictional unresolved lien question",
      detail: note,
      sourceId: activeSource,
      dueOn: recordedOn,
      note,
      attested: true,
    });
    await change(lostId, {
      kind: "transition",
      status: "Lost",
      occurredOn: recordedOn,
      sourceId: activeSource,
      note,
      attested: true,
    });
    await change(deals[11].id, {
      kind: "configure",
      transactionKind: "Sale",
      nextAction: "Fictional hidden transaction action",
      dueOn: recordedOn,
      note,
    });
    activeEngagementId = (
      await createEngagement(a, { terms: terms(doneId), idempotencyKey: randomUUID() })
    ).engagement.id;
    await revenue(activeEngagementId, { kind: "activate", note, attested: true });
    let detail = await revenue(activeEngagementId, {
      kind: "earn",
      earnedOn: recordedOn,
      basisAmount: null,
      sourceId: doneSource,
      note,
      attested: true,
    });
    detail = await revenue(activeEngagementId, {
      kind: "invoice",
      earningId: detail.earnings[0].id,
      amount: "1000",
      taxAmount: "0",
      taxLabel: "",
      issuedOn: recordedOn,
      dueOn: recordedOn,
      issuerName: "Fictional Founder",
      issuerEmail: "founder@example.com",
      issuerAddress: "Fictional office India",
      issuerRegistration: "",
      billToAddress: "Fictional client office India",
      description: "Fictional sourcing commission invoice",
      paymentInstructions: "PRIVATE-INSTRUCTIONS-MUST-NOT-ENTER-AGENT-CONTEXT",
      note,
      attested: true,
    });
    await revenue(activeEngagementId, {
      kind: "receipt",
      invoiceId: detail.invoices[0].id,
      amount: "400",
      paymentTotal: "400",
      receivedOn: recordedOn,
      reference: "FICTIONAL-PARTIAL-RECEIPT",
      sourceId: signedSource,
      note,
      attested: true,
    });
    otherEngagementId = (
      await createEngagement(a, {
        terms: terms(otherDealId, otherRequirementId, unrelatedSource),
        idempotencyKey: randomUUID(),
      })
    ).engagement.id;
    differentAircraftEngagementId = (
      await createEngagement(a, { terms: terms(activeId), idempotencyKey: randomUUID() })
    ).engagement.id;
    for (let index = 0; index < 10; index++)
      hiddenEngagementId = (
        await createEngagement(a, { terms: terms(doneId), idempotencyKey: randomUUID() })
      ).engagement.id;
  }, 60000);
  afterAll(async () => {
    if (!a) return;
    const db = await pool().connect();
    try {
      await db.query("begin");
      for (const table of [
        "activity",
        "communication_assignment_corrections",
        "communication_brief_revisions",
        "communication_analyses",
        "communication_messages",
        "lead_drafts",
        "lead_sources",
        "lead_enrichments",
        "lead_cases",
        "discovery_leads",
        "discovery_results",
        "discovery_searches",
        "agent_proposals",
        "agent_steps",
        "agent_runs",
        "case_actions",
        "readiness_items",
        "shortlist_decisions",
        "case_contacts",
        "outreach_drafts",
        "execution_cases",
        "revenue_operations",
        "revenue_receipts",
        "revenue_payments",
        "revenue_expenses",
        "revenue_invoices",
        "revenue_earnings",
        "revenue_engagements",
        "transaction_requests",
        "transaction_offer_decisions",
        "transaction_findings",
        "transaction_evidence",
        "transaction_offers",
        "transaction_cases",
        "sources",
      ])
        await db.query(`delete from aerion.${table} where workspace_id=any($1::uuid[])`, [
          [a.workspaceId, b.workspaceId],
        ]);
      await db.query("delete from aerion.workspaces where owner_id=any($1::uuid[])", [actors]);
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    } finally {
      db.release();
      await pool().end();
    }
  });
  it("distinguishes authoritative Completed and Lost outcomes from unmanaged legacy stages", async () => {
    const context = await readCommercialContext(a, requirementId);
    const completed = context.transactions.find((item) => item.dealId === doneId);
    expect(completed).toMatchObject({
      managed: true,
      status: "Completed",
      cycle: 1,
      legacyStage: "Closing",
      contextChanged: false,
      completedOn: recordedOn,
      completionSourceId: doneSource,
    });
    expect(completed?.milestones).toHaveLength(9);
    expect(
      completed?.milestones.every(
        (item) =>
          item.state === "Verification recorded" &&
          item.reviewer === "Fictional named qualified reviewer",
      ),
    ).toBe(true);
    expect(context.transactions.find((item) => item.dealId === lostId)).toMatchObject({
      managed: true,
      status: "Lost",
      legacyStage: "Closing",
    });
    expect(context.transactions.find((item) => item.dealId === deals[3].id)).toMatchObject({
      managed: false,
      status: null,
      cycle: null,
      legacyStage: "Sourcing",
    });
  });
  it("includes current offer expiry, actual evidence state and the open source-backed blocking finding", async () => {
    const context = await transaction(a.actorId, a.workspaceId, (db) =>
      commercialContextInTransaction(db, a, requirementId, deals[1].aircraftId),
    );
    expect(context.transactions).toHaveLength(1);
    const active = context.transactions[0];
    expect(active.offers[0]).toMatchObject({
      expiresOn: recordedOn,
      status: "Recorded",
      amount: "21000000.00",
      sourceId: activeSource,
    });
    expect(active.milestones[0]).toMatchObject({
      key: "Title",
      state: "Received",
      sourceId: activeSource,
      reviewer: null,
    });
    expect(active.findings[0]).toMatchObject({
      category: "Title",
      severity: "Blocking",
      status: "Open",
      dueOn: recordedOn,
      sourceId: activeSource,
    });
    expect(context.engagements.map((item) => item.id)).toEqual([differentAircraftEngagementId]);
    expect(context.sourceIds).toContain(activeSource);
    expect(context.sourceIds).not.toContain(doneSource);
  });
  it("returns recorded fee, invoice and receipt totals without unrelated finance or private instructions", async () => {
    const context = await readCommercialContext(a, requirementId, deals[0].aircraftId);
    const fee = context.engagements.find((item) => item.id === activeEngagementId);
    expect(fee).toMatchObject({
      status: "Active",
      effectiveStatus: "Active",
      earningTrigger: "Closing",
      currency: "USD",
      signedSourceId: signedSource,
      totals: {
        earnedMinor: "100000",
        invoicedMinor: "100000",
        invoiceTotalMinor: "100000",
        receivedMinor: "40000",
        outstandingMinor: "60000",
      },
    });
    expect(fee?.invoices[0]).toMatchObject({
      status: "Issued",
      dueOn: recordedOn,
      totalMinor: "100000",
      receivedMinor: "40000",
      outstandingMinor: "60000",
    });
    expect(fee?.earnings[0]).toMatchObject({ status: "Recorded", sourceId: doneSource });
    expect(context.engagements.map((item) => item.id)).not.toContain(otherEngagementId);
    expect(context.engagements.map((item) => item.id)).not.toContain(differentAircraftEngagementId);
    expect(context.sourceIds).not.toContain(unrelatedSource);
    expect(JSON.stringify(context)).not.toContain("PRIVATE-INSTRUCTIONS");
    expect(JSON.stringify(context)).not.toContain("context-fixture@example.com");
  });
  it("exposes truncation and hashes every scoped case/engagement revision, including undisplayed records", async () => {
    const first = await readCommercialContext(a, requirementId);
    expect(first.coverage.transactions).toEqual({ total: 12, shown: 10, truncated: 2 });
    expect(first.coverage.engagements).toEqual({ total: 12, shown: 10, truncated: 2 });
    expect(first.revisionState.transactions).toHaveLength(12);
    expect(first.revisionState.engagements).toHaveLength(12);
    expect(
      await transaction(a.actorId, a.workspaceId, (db) =>
        commercialRevisionStateInTransaction(db, a, requirementId),
      ),
    ).toEqual(first.revisionState);
    await change(deals[11].id, {
      kind: "configure",
      transactionKind: "Sale",
      nextAction: "Fictional hidden transaction revised",
      dueOn: recordedOn,
      note,
    });
    const next = await transaction(a.actorId, a.workspaceId, (db) =>
      commercialRevisionStateInTransaction(db, a, requirementId),
    );
    expect(fingerprint(next)).not.toBe(fingerprint(first.revisionState));
    const original = fingerprint(next);
    const hidden = await readRevenueDetail(a, hiddenEngagementId);
    await revenue(hiddenEngagementId, {
      kind: "edit",
      terms: { ...hidden.engagement.terms, title: "Fictional revised hidden engagement" },
    });
    expect(
      fingerprint(
        await transaction(a.actorId, a.workspaceId, (db) =>
          commercialRevisionStateInTransaction(db, a, requirementId),
        ),
      ),
    ).not.toBe(original);
  });
  it("grants tools only the selected case's actual commercial evidence and returns authoritative Completed state", async () => {
    const run = await runRole("due-diligence");
    const tools = toolsFor(run);
    const context = (await tools.invoke("case_context", {})) as { commercial: CommercialContext };
    expect(context.commercial.transactions).toHaveLength(1);
    expect(context.commercial.transactions[0]).toMatchObject({
      dealId: doneId,
      managed: true,
      status: "Completed",
      legacyStage: "Closing",
    });
    for (const sourceId of [doneSource, signedSource]) {
      const passage = (await tools.invoke("source_passages", { sourceId, page: 1, offset: 0 })) as {
        sourceId: string;
        text: string;
      };
      expect(passage.sourceId).toBe(sourceId);
      expect(passage.text).toContain("Clearly fictional");
    }
    for (const sourceId of [unrelatedSource, activeSource, foreignSource])
      await expect(
        tools.invoke("source_passages", { sourceId, page: 1, offset: 0 }),
      ).rejects.toThrow(/not selected or linked/i);
    expect(run.steps.find((step) => step.tool === "case_context")?.output).toMatchObject({
      commercial: { transactions: [{ status: "Completed" }] },
    });
  });
  it("runtime diligence and coordination use current milestones, stop terminal sourcing follow-ups and surface an overdue unpaid invoice", async () => {
    for (const role of ["due-diligence", "deal-coordination"] as const) {
      const run = await runRole(role);
      const text = JSON.stringify(run.report);
      expect(text).toContain("Recorded Completed, cycle 1");
      expect(run.report?.findings.some((finding) => finding.title.startsWith("Missing:"))).toBe(
        false,
      );
      expect(
        run.report?.findings.some((finding) => finding.title.startsWith("Before Offer:")),
      ).toBe(false);
      expect(
        run.proposals.some((proposal) => proposal.title.startsWith("Transaction follow-up:")),
      ).toBe(false);
      expect(run.proposals.some((proposal) => proposal.title.startsWith("Obtain evidence:"))).toBe(
        false,
      );
      if (role === "deal-coordination") {
        expect(
          run.report?.findings.some((finding) => finding.title.startsWith("Overdue invoice:")),
        ).toBe(true);
        expect(text).toContain("USD 600.00");
        expect(paymentProposal(run).action).toMatchObject({
          type: "execution",
          requirementId,
          action: { type: "add-action", dueDate: recordedOn },
        });
      }
    }
    const active = await runRole("deal-coordination", deals[1].aircraftId);
    expect(
      active.report?.findings.some((finding) => finding.title.startsWith("Expired offer:")),
    ).toBe(true);
    expect(
      active.report?.findings.some((finding) =>
        finding.title.includes("Blocking finding: Fictional unresolved lien question"),
      ),
    ).toBe(true);
    expect(active.proposals.some((proposal) => proposal.title.startsWith("Resolve finding:"))).toBe(
      true,
    );
    expect(JSON.stringify(active.report)).not.toContain("Recorded Completed");
  });
  it("marks a runtime follow-up obsolete after linked transaction or engagement APIs change its commercial context", async () => {
    const transactionRun = await runRole("deal-coordination");
    const transactionProposal = paymentProposal(transactionRun);
    await change(activeId, {
      kind: "configure",
      transactionKind: "Sale",
      nextAction: "Fictional newly reviewed transaction next action",
      dueOn: recordedOn,
      note,
    });
    expect(
      await decideProposal(a, transactionProposal.id, {
        decision: "accept",
        revision: transactionRun.revision,
        note,
        attested: true,
      }),
    ).toMatchObject({ status: "obsolete", appliedRef: null });
    expect(
      (await readAgentRun(a, transactionRun.id)).proposals.find(
        (item) => item.id === transactionProposal.id,
      )?.status,
    ).toBe("obsolete");
    const engagementRun = await runRole("deal-coordination");
    const engagementProposal = paymentProposal(engagementRun);
    const draft = await readRevenueDetail(a, hiddenEngagementId);
    await revenue(hiddenEngagementId, {
      kind: "edit",
      terms: {
        ...draft.engagement.terms,
        paymentTerms: "Fictional revised engagement payment condition for staleness regression.",
      },
    });
    expect(
      await decideProposal(a, engagementProposal.id, {
        decision: "accept",
        revision: engagementRun.revision,
        note,
        attested: true,
      }),
    ).toMatchObject({ status: "obsolete", appliedRef: null });
    const actions = await transaction(a.actorId, a.workspaceId, (db) =>
      db.query("select title from aerion.case_actions where workspace_id=$1", [a.workspaceId]),
    );
    expect(actions.rows.some((item) => item.title === engagementProposal.title)).toBe(false);
  });
  it("accepts an otherwise current runtime follow-up after unrelated workspace changes", async () => {
    const run = await runRole("deal-coordination");
    const proposal = paymentProposal(run);
    await mutateWorkspace(
      b,
      {
        type: "contact",
        item: {
          id: `fictional-unrelated-${randomUUID()}`,
          name: "Fictional Unrelated Owner",
          company: "Fictional Other Company",
          role: "Fictional Research",
          email: "unrelated@example.com",
          location: "India",
          type: "Buyer",
          notes: note,
        },
      },
      0,
    );
    expect(
      await decideProposal(a, proposal.id, {
        decision: "accept",
        revision: run.revision,
        note,
        attested: true,
      }),
    ).toMatchObject({ status: "accepted" });
    expect(
      (await readAgentRun(a, run.id)).proposals.find((item) => item.id === proposal.id)?.status,
    ).toBe("accepted");
  });
  it("uses the authoritative changed-context completion check and denies cross-workspace reads", async () => {
    await transaction(a.actorId, a.workspaceId, (db) =>
      db.query(
        "update aerion.transaction_cases set context_hash=$1,revision=revision+1 where workspace_id=$2 and deal_id=$3",
        ["fictional-obsolete-context", a.workspaceId, doneId],
      ),
    );
    const context = await readCommercialContext(a, requirementId, deals[0].aircraftId);
    expect(context.transactions[0]).toMatchObject({
      status: "Completed",
      contextChanged: true,
      completionSourceId: null,
    });
    await expect(readCommercialContext(b, requirementId)).rejects.toThrow(/not found/i);
    await expect(
      readCommercialContext({ actorId: b.actorId, workspaceId: a.workspaceId }, requirementId),
    ).rejects.toThrow(/not found/i);
    await expect(readCommercialContext(a, "fictional-nonexistent-requirement")).rejects.toThrow(
      /not found/i,
    );
    await expect(
      readCommercialContext(a, requirementId, "fictional-nonexistent-aircraft"),
    ).rejects.toThrow(/not found/i);
  });
  it("runtime match_aircraft excludes an old buyer brief after a reviewed reply assignment correction", async () => {
    async function seedFictionalLead(organization: string) {
      const sourceId = await retain(a, `${organization} requires Airbus A320`);
      const request: RunInput = {
        ...input("buyer-discovery", null),
        requirementId: null,
        allowExternalSources: true,
        discovery: {
          side: "Buyer",
          buyerIntent: "Demand",
          target: "Airbus A320",
          market: "Commercial",
          region: "",
          method: "urls",
          query: "",
          urls: [`https://fictional.example.com/${randomUUID()}`],
          freshness: "any",
        },
      };
      const queued = await enqueueAgent(a, request);
      const run = await readAgentRun(a, queued.id);
      const manifest = await discoverSources(a, run, new AbortController().signal);
      const resultId = manifest.results[0].id;
      const proposalId = await transaction(a.actorId, a.workspaceId, async (db) => {
        await db.query(
          "update aerion.discovery_results set status='retained',source_id=$1 where workspace_id=$2 and id=$3",
          [sourceId, a.workspaceId, resultId],
        );
        await db.query(
          "update aerion.agent_runs set status='review',finished_at=now() where workspace_id=$1 and id=$2",
          [a.workspaceId, queued.id],
        );
        return retainProposal(db, a, queued.id, "buyer-discovery", {
          title: "Review fictional buyer lead",
          reason: note,
          action: {
            type: "lead",
            resultId,
            sourceId,
            values: {
              side: "Buyer",
              basis: "Stated demand",
              organization,
              aircraftModel: "Airbus A320",
              geography: null,
              contactName: null,
              email: null,
              phone: null,
              summary: note,
            },
          },
          citations: [{ sourceId, page: 1, quote: `${organization} requires Airbus A320` }],
        });
      });
      if (!proposalId) throw new Error("Expected fictional lead proposal");
      const result = await decideProposal(a, proposalId, {
        decision: "accept",
        revision: (await readAgentRun(a, queued.id)).revision,
        note,
        attested: true,
      });
      if (!result.appliedRef) throw new Error("Expected saved fictional lead");
      return result.appliedRef;
    }
    const priorLead = await seedFictionalLead(`Fictional Prior Buyer ${randomUUID()}`);
    const correctLead = await seedFictionalLead(`Fictional Correct Buyer ${randomUUID()}`);
    await mutateLeadCase(a, priorLead, 0, { kind: "link-requirement", requirementId, note });
    const retained = await retainEmailUpload(
      a,
      Buffer.from(
        `From: fictional-correct@example.com\r\nTo: founder@example.com\r\nSubject: Fictional corrected buyer response\r\nMessage-ID: <${randomUUID()}@example.com>\r\n\r\n${note}`,
      ),
      "fictional-corrected-reply.eml",
    );
    await actOnCommunication(a, retained.id, {
      kind: "link",
      revision: 0,
      leadId: priorLead,
      note,
      attested: true,
    });
    await actOnCommunication(a, retained.id, {
      kind: "correct-link",
      revision: (await readCommunicationMessage(a, retained.id)).revision,
      leadId: correctLead,
      note,
      attested: true,
    });
    const run = await runRole("matching");
    const matchStep = run.steps.find((step) => step.tool === "match_aircraft");
    expect(matchStep?.output).toMatchObject({
      requalificationRequired: true,
      counts: { eligible: 0, unknown: 0, excluded: 12 },
    });
    const output = (await toolsFor(run).invoke("match_aircraft", {})) as {
      matches: { state: string; checks: { label: string; result: string }[] }[];
      requalificationRequired: boolean;
    };
    expect(output.requalificationRequired).toBe(true);
    expect(
      output.matches.every(
        (match) =>
          match.state === "excluded" &&
          match.checks.some(
            (check) => check.label === "Current buyer brief" && check.result === "fail",
          ),
      ),
    ).toBe(true);
    expect(
      run.proposals.some(
        (proposal) =>
          proposal.action.type === "execution" && proposal.action.action.type === "shortlist",
      ),
    ).toBe(false);
  });
});
