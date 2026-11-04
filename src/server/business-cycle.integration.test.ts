import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, workspaceFor, transaction, type Scope } from "./db";
import {
  createSource,
  decideReview,
  mutateWorkspace,
  readPipeline,
  readWorkspace,
} from "./repository";
import { enqueueExtraction, processNext } from "./jobs";
import { sampleSource } from "../lib/intelligence/schema";
import { calendarDate } from "../lib/format";
import { runInputSchema } from "../lib/agents/schema";
import { enqueueAgent, readAgentRun, retainProposal, decideProposal } from "./agents/repository";
import { processNextAgent } from "./agents/runtime";
import { discoverSources } from "./discovery/service";
import { readLeadCase, mutateLeadCase } from "./leads/workflow";
import {
  retainEmailUpload,
  readCommunicationMessage,
  actOnCommunication,
} from "./communication/service";
import {
  readTransaction,
  mutateTransaction,
  readTransactionCompletion,
} from "./transactions/workflow";
import {
  createEngagement,
  mutateRevenue,
  readRevenueDetail,
  readRevenueInvoice,
} from "./revenue/repository";
import { invoiceHtml } from "./revenue/invoice";
import type { EngagementTerms, RevenueAction } from "../lib/revenue/schema";
import type { MilestoneKey, TransactionAction } from "../lib/transactions/schema";
import { readExecution } from "./execution";

const testUrl = process.env.AERION_TEST_DATABASE_URL;
function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined)
    throw new Error(`Missing fictional business-cycle record: ${label}`);
  return value;
}

describe.skipIf(!testUrl)(
  "Complete fictional sourcing engagement through recorded commission receipts",
  () => {
    const actors = [randomUUID(), randomUUID()],
      clientId = randomUUID(),
      today = calendarDate();
    const company = "Fictional Cycle Aviation",
      clientEmail = "fictional-cycle-client@example.com";
    const note =
      "Fictional integrated engineering evidence only. No real buyer, agreement, aircraft, inspection, invoice, commission or payment is represented.";
    let a: Scope,
      b: Scope,
      leadId: string,
      engagementId: string,
      dealId: string,
      alternateDealId: string,
      requirementId: string,
      aircraftIds: string[],
      signedSourceId: string,
      completionSourceId: string,
      invoiceId: string,
      newFeeEngagementId: string,
      revisedRequirementId: string;
    function terms(extra: Partial<EngagementTerms> = {}): EngagementTerms {
      return {
        title: "Fictional A319 sourcing fee",
        clientContactId: clientId,
        payerContactId: clientId,
        representation: "Buyer sourcing",
        requirementId: null,
        dealId: null,
        scope: note,
        startsOn: today,
        endsOn: null,
        currency: "USD",
        feeType: "Fixed",
        fixedAmount: "1500.00",
        percentage: null,
        estimateBasis: null,
        basisDescription: "Fixed fictional fee recorded in the retained test agreement.",
        earningTrigger: "Closing",
        earningTerms:
          "Fictional fee becomes earned only after the linked transaction completes with current delivery acceptance evidence.",
        paymentTerms:
          "Fictional fee payable by the invoice due date; this test does not request payment.",
        signedSourceId: null,
        signatory: "",
        signedOn: null,
        ...extra,
      };
    }
    async function source(title: string, text = note) {
      return (
        await createSource(a, {
          title,
          kind: "text",
          sourceUrl: null,
          filename: `fixture-${randomUUID()}.txt`,
          contentType: "text/plain",
          original: Buffer.from(`${title}\n${text}`),
          pages: [{ page: 1, text: `${title}\n${text}` }],
        })
      ).id;
    }
    async function leadChange(action: Parameters<typeof mutateLeadCase>[3]) {
      return mutateLeadCase(a, leadId, (await readLeadCase(a, leadId)).revision, action);
    }
    async function revenueChange(id: string, action: RevenueAction) {
      const detail = await readRevenueDetail(a, id);
      return mutateRevenue(a, id, {
        revision: detail.engagement.revision,
        idempotencyKey: randomUUID(),
        action,
      });
    }
    async function txnChange(id: string, action: TransactionAction) {
      return mutateTransaction(
        a,
        id,
        (await readTransaction(a, id)).revision,
        randomUUID(),
        action,
      );
    }
    async function advance(
      id: string,
      status: "Offer" | "LOI" | "Agreement" | "Inspection" | "Closing" | "Completed",
      sourceId: string | null = null,
    ) {
      return txnChange(id, {
        kind: "transition",
        status,
        sourceId,
        occurredOn: today,
        note,
        attested: true,
      });
    }
    async function accept(runId: string) {
      let run = await readAgentRun(a, runId);
      for (const proposal of run.proposals.filter((item) => item.status === "proposed")) {
        await decideProposal(a, proposal.id, {
          decision: "accept",
          revision: run.revision,
          note,
          attested: true,
        });
        run = await readAgentRun(a, runId);
      }
      return run;
    }
    async function evidence(id: string, key: MilestoneKey, sourceId: string) {
      await txnChange(id, {
        kind: "evidence",
        key,
        sourceId,
        occurredOn: today,
        party: "Fictional independent review service",
        detail: note,
        note,
        attested: true,
      });
      const record = required(
        (await readTransaction(a, id)).evidence.find((item) => item.current && item.key === key),
        key,
      );
      await txnChange(id, {
        kind: "evidence-decision",
        evidenceId: record.id,
        state: "Reviewed",
        recordedBy: "Fictional founder reviewer",
        occurredOn: today,
        note,
        attested: true,
      });
      await txnChange(id, {
        kind: "evidence-decision",
        evidenceId: record.id,
        state: "Verification recorded",
        recordedBy: "Fictional qualified service reviewer",
        occurredOn: today,
        note,
        attested: true,
      });
    }
    async function offered(id: string) {
      const offerSource = await source(
        `Fictional recorded offer ${id}`,
        `${note}\nBuyer: ${company}\nAircraft: Airbus A319\nAmount: 21500000 USD per aircraft\nQuantity: 1`,
      );
      await txnChange(id, {
        kind: "offer",
        side: "Buyer",
        contactId: clientId,
        offerKind: "Offer",
        parentId: null,
        amount: "21500000.00",
        currency: "USD",
        basis: "Purchase price",
        quantity: 1,
        offeredOn: today,
        expiresOn: null,
        terms: note,
        sourceId: offerSource,
        note,
        attested: true,
      });
      const offer = required((await readTransaction(a, id)).offers[0], "recorded offer");
      const acceptance = await source(
        `Fictional offer acceptance ${id}`,
        `${note}\nFictional buyer acceptance of the recorded offer ${offer.id}.`,
      );
      await txnChange(id, {
        kind: "offer-decision",
        offerId: offer.id,
        decision: "Accepted",
        sourceId: acceptance,
        decidedOn: today,
        recordedBy: "Fictional client representative",
        note,
        attested: true,
      });
    }
    async function reply(quantity: number) {
      const raw = Buffer.from(
        `From: Fictional Client <${clientEmail}>\r\nTo: fictional-founder@example.com\r\nSubject: Fictional current A319 sourcing brief\r\nMessage-ID: <business-cycle-${randomUUID()}@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nClient: ${company}\nAircraft family: Airbus A319\nMarket: Commercial\nQuantity: ${quantity}\nMinimum year: 2010\nEngine: CFM56\nBudget USD: 23000000\nDelivery deadline: 2027-06-01\nDestination: India\n${note}`,
      );
      const incoming = await retainEmailUpload(a, raw, "fictional-client-reply.eml");
      await actOnCommunication(a, incoming.id, {
        kind: "link",
        revision: (await readCommunicationMessage(a, incoming.id)).revision,
        leadId,
        note,
        attested: true,
      });
      const run = await actOnCommunication(a, incoming.id, {
        kind: "analyze",
        revision: (await readCommunicationMessage(a, incoming.id)).revision,
        provider: "rules",
        allowModelData: false,
        idempotencyKey: randomUUID(),
      });
      const runId = String(run.runId);
      await processNextAgent(a);
      const detail = await readAgentRun(a, runId);
      expect(detail.error).toBeNull();
      expect(detail.status, JSON.stringify(detail.report)).toBe("review");
      return {
        messageId: incoming.id,
        runId,
        proposalId: required(
          detail.proposals.find((proposal) => proposal.action.type === "requirement"),
          "reply requirement proposal",
        ).id,
      };
    }
    beforeAll(async () => {
      if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
        throw new Error("Dedicated _test database required.");
      process.env.DATABASE_URL = testUrl;
      const migrations = (
        await pool().query(
          "select name from public.aerion_migrations where name like '010%' or name like '011%' or name like '012%' or name like '013%'",
        )
      ).rows;
      if (migrations.length !== 4)
        throw new Error(
          "Apply the coordinated product migrations before the integrated acceptance test.",
        );
      a = await workspaceFor(actors[0]);
      b = await workspaceFor(actors[1]);
      await mutateWorkspace(
        a,
        {
          type: "contact",
          item: {
            id: clientId,
            name: "Fictional Authorized Client",
            company,
            email: clientEmail,
            role: "Fictional acquisitions representative",
            location: "India",
            type: "Buyer",
            notes: note,
          },
        },
        (await readWorkspace(a)).revision,
      );
      const wanted = `${company} is seeking an Airbus A319 aircraft. ${note}`,
        original = await source("Fictional retained buyer sourcing signal", wanted);
      const discovery = await enqueueAgent(
        a,
        runInputSchema.parse({
          agentId: "buyer-discovery",
          provider: "rules",
          aircraftId: null,
          requirementId: null,
          contactId: null,
          sourceIds: [],
          connectorIds: [],
          objective: note,
          allowExternalSources: true,
          allowModelData: false,
          idempotencyKey: randomUUID(),
          discovery: {
            side: "Buyer",
            buyerIntent: "Demand",
            target: "Airbus A319",
            market: "Commercial",
            region: "",
            method: "urls",
            query: "",
            urls: [`https://fictional.example.com/cycle-${randomUUID()}`],
            freshness: "any",
          },
        }),
      );
      const results = await discoverSources(
        a,
        await readAgentRun(a, discovery.id),
        new AbortController().signal,
      );
      const proposalId = await transaction(a.actorId, a.workspaceId, async (db) => {
        await db.query(
          "update aerion.discovery_results set status='retained',source_id=$1 where workspace_id=$2 and id=$3",
          [original, a.workspaceId, results.results[0].id],
        );
        await db.query(
          "update aerion.agent_runs set status='review',finished_at=now() where workspace_id=$1 and id=$2",
          [a.workspaceId, discovery.id],
        );
        return retainProposal(db, a, discovery.id, "buyer-discovery", {
          title: "Fictional buyer signal for an integrated sourcing cycle",
          reason: note,
          action: {
            type: "lead",
            resultId: results.results[0].id,
            sourceId: original,
            values: {
              side: "Buyer",
              basis: "Stated demand",
              organization: company,
              aircraftModel: "Airbus A319",
              geography: null,
              contactName: null,
              email: null,
              phone: null,
              summary: note,
            },
          },
          citations: [{ sourceId: original, page: 1, quote: wanted }],
        });
      });
      await decideProposal(a, required(proposalId, "discovery proposal"), {
        decision: "accept",
        revision: (await readAgentRun(a, discovery.id)).revision,
        note,
        attested: true,
      });
      leadId = required(
        (await readAgentRun(a, discovery.id)).proposals[0].appliedRef,
        "working buyer lead",
      );
      await leadChange({ kind: "link-contact", contactId: clientId, note });
    });
    afterAll(async () => {
      if (!a) return;
      const db = await pool().connect();
      try {
        await db.query("begin");
        for (const table of [
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
          "communication_assignment_corrections",
          "communication_brief_revisions",
          "communication_analyses",
          "communication_messages",
          "communication_suppressions",
          "activity",
          "delivery_attempts",
          "mail_deliveries",
          "lead_drafts",
          "lead_enrichments",
          "lead_sources",
          "lead_cases",
          "discovery_leads",
          "discovery_results",
          "discovery_searches",
          "agent_proposals",
          "agent_steps",
          "agent_validations",
          "agent_runs",
          "readiness_items",
          "case_actions",
          "outreach_drafts",
          "shortlist_decisions",
          "case_contacts",
          "execution_cases",
          "reviews",
          "extractions",
          "source_links",
          "sources",
          "operations_settings",
        ]) {
          const existing = (await db.query("select to_regclass($1) as name", [`aerion.${table}`]))
            .rows[0].name;
          if (existing)
            await db.query(`delete from aerion.${table} where workspace_id=any($1::uuid[])`, [
              [a.workspaceId, b.workspaceId],
            ]);
        }
        await db.query("delete from aerion.workspaces where owner_id=any($1::uuid[])", [actors]);
        await db.query("commit");
      } finally {
        db.release();
        await pool().end();
      }
    });
    it("starts with an engagement Draft, reviews the actual reply and approves inventory before creating opportunities", async () => {
      const draft = await createEngagement(a, { terms: terms(), idempotencyKey: randomUUID() });
      engagementId = draft.engagement.id;
      expect(draft.engagement.status).toBe("Draft");
      await expect(
        revenueChange(engagementId, { kind: "activate", note, attested: true }),
      ).rejects.toThrow(/signed engagement/);
      const incoming = await reply(1);
      await accept(incoming.runId);
      let lead = await readLeadCase(a, leadId);
      requirementId = required(lead.requirement, "accepted buyer brief").id;
      expect(lead.requirement?.status).toBe("Draft");
      expect(lead.desk?.confirmation).toBeNull();
      aircraftIds = [];
      for (let index = 0; index < 2; index++) {
        const text = sampleSource.replace(
          "LOCAL-EXAMPLE-01",
          `FICTIONAL-CYCLE-${index}-${randomUUID()}`,
        );
        const spec = await createSource(a, {
          title: `Fictional approved aircraft specification ${index + 1}`,
          kind: "text",
          sourceUrl: null,
          filename: `fictional-aircraft-${index}.txt`,
          contentType: "text/plain",
          original: Buffer.from(text),
          pages: [{ page: 1, text }],
        });
        await enqueueExtraction(a, spec.id, "local");
        await processNext(a);
        const review = required(
          (await readPipeline(a)).reviews.find((item) => item.sourceId === spec.id),
          "aircraft review",
        );
        const approved = await decideReview(a, review.id, {
          decision: "approve",
          note,
          attested: true,
        });
        aircraftIds.push(required(approved.aircraftId, "approved aircraft"));
      }
      await expect(
        leadChange({
          kind: "opportunity",
          aircraftId: aircraftIds[0],
          dueOn: today,
          note,
          attested: true,
        }),
      ).rejects.toThrow(/Confirm/);
      await leadChange({
        kind: "confirm",
        confirmation: { contact: "Fictional Authorized Client", confirmedOn: today, basis: note },
        note,
        attested: true,
      });
      lead = await readLeadCase(a, leadId);
      expect(lead.desk?.matches.filter((match) => match.state === "eligible")).toHaveLength(2);
      dealId = (
        await leadChange({
          kind: "opportunity",
          aircraftId: aircraftIds[0],
          dueOn: today,
          note,
          attested: true,
        })
      ).recordId;
      alternateDealId = (
        await leadChange({
          kind: "opportunity",
          aircraftId: aircraftIds[1],
          dueOn: today,
          note,
          attested: true,
        })
      ).recordId;
      const workspace = await readWorkspace(a);
      expect(workspace.data.deals.find((deal) => deal.id === dealId)).toMatchObject({
        requirementId,
        aircraftId: aircraftIds[0],
        stage: "Sourcing",
      });
      expect((await readLeadCase(a, leadId)).desk?.drafts).toHaveLength(2);
    });
    it("activates the signed linked fee agreement and refuses a closing-based fee before completion", async () => {
      signedSourceId = await source(
        "Fictional signed client engagement",
        `${note}\nClient and payer: ${company}\nScope: source the confirmed A319 requirement ${requirementId}.\nOpportunity: ${dealId}\nFee: 1500.00 USD fixed, earned at recorded completion and due on invoice.`,
      );
      await revenueChange(engagementId, {
        kind: "edit",
        terms: terms({
          requirementId,
          dealId,
          signedSourceId,
          signatory: "Fictional Authorized Client",
          signedOn: today,
        }),
      });
      await revenueChange(engagementId, { kind: "activate", note, attested: true });
      expect((await readRevenueDetail(a, engagementId)).engagement.status).toBe("Active");
      await expect(
        revenueChange(engagementId, {
          kind: "earn",
          earnedOn: today,
          basisAmount: null,
          sourceId: signedSourceId,
          note,
          attested: true,
        }),
      ).rejects.toThrow(/completed closing evidence/);
      await expect(readRevenueDetail(b, engagementId)).rejects.toThrow(/not found/);
      for (const id of [dealId, alternateDealId]) {
        await txnChange(id, {
          kind: "configure",
          transactionKind: "Sale",
          nextAction: "Review the fictional offer and source-backed transaction milestones",
          dueOn: today,
          note,
        });
        await offered(id);
        await expect(advance(id, "Offer")).rejects.toThrow(/Representation/);
        await evidence(id, "Representation", signedSourceId);
        const availability = await source(
          `Fictional current availability ${id}`,
          `${note}\nCurrent fictional availability for the aircraft connected to ${id}.`,
        );
        await evidence(id, "Availability", availability);
        await advance(id, "Offer");
        await evidence(id, "Letter of intent", await source(`Fictional letter of intent ${id}`));
      }
    });
    it("completes evidenced transaction milestones, then records an earned fee, invoice and partial/full receipts", async () => {
      await advance(dealId, "LOI");
      await evidence(
        dealId,
        "Executed agreement",
        await source("Fictional executed aircraft purchase agreement"),
      );
      await advance(dealId, "Agreement");
      await evidence(
        dealId,
        "Technical records",
        await source("Fictional reviewed aircraft technical records"),
      );
      await advance(dealId, "Inspection");
      await evidence(
        dealId,
        "Pre-purchase inspection",
        await source("Fictional completed pre-purchase inspection"),
      );
      await evidence(dealId, "Title", await source("Fictional clear-title report"));
      await advance(dealId, "Closing");
      await expect(advance(dealId, "Completed", signedSourceId)).rejects.toThrow(/Settlement/);
      await evidence(dealId, "Settlement", await source("Fictional settlement confirmation"));
      completionSourceId = await source(
        "Fictional signed delivery acceptance",
        `${note}\nFictional buyer acceptance and recorded delivery of the aircraft in opportunity ${dealId}.`,
      );
      await evidence(dealId, "Delivery acceptance", completionSourceId);
      await advance(dealId, "Completed", completionSourceId);
      const completed = await readTransaction(a, dealId);
      expect(completed.status).toBe("Completed");
      expect(completed.completedOn).toBe(today);
      expect(completed.completionSourceId).toBe(completionSourceId);
      await revenueChange(engagementId, {
        kind: "earn",
        earnedOn: today,
        basisAmount: null,
        sourceId: completionSourceId,
        note,
        attested: true,
      });
      let revenue = await readRevenueDetail(a, engagementId);
      const earning = required(revenue.earnings[0], "recorded earned fee");
      expect(earning.amountMinor).toBe("150000");
      expect(earning.transactionSnapshot).toMatchObject({
        cycle: 1,
        completedOn: today,
        completionSourceId,
      });
      expect(revenue.engagement.totals.receivedMinor).toBe("0");
      await revenueChange(engagementId, {
        kind: "invoice",
        earningId: earning.id,
        amount: "1500.00",
        taxAmount: "0",
        taxLabel: "",
        issuedOn: today,
        dueOn: today,
        issuerName: "Fictional Aerion Founder",
        issuerEmail: "fictional-founder@example.com",
        issuerAddress: "Fictional issuer address for engineering tests",
        issuerRegistration: "FICTIONAL-ONLY",
        billToAddress: "Fictional client address for engineering tests",
        description: "Fictional agreed aircraft sourcing fee after recorded completion",
        paymentInstructions:
          "Fictional fixture only. Do not send money or use these records as payment instructions.",
        note,
        attested: true,
      });
      revenue = await readRevenueDetail(a, engagementId);
      invoiceId = required(revenue.invoices[0], "issued invoice").id;
      expect((await readRevenueInvoice(a, invoiceId)).outstandingMinor).toBe("150000");
      expect(invoiceHtml(await readRevenueInvoice(a, invoiceId))).toContain(company);
      const firstPayment = await source(
        "Fictional first payment receipt",
        `${note}\nRecorded fictional receipt: 600.00 USD against invoice ${invoiceId}.`,
      );
      await revenueChange(engagementId, {
        kind: "receipt",
        invoiceId,
        amount: "600.00",
        paymentTotal: "600.00",
        receivedOn: today,
        reference: "FICTIONAL-CYCLE-PARTIAL",
        sourceId: firstPayment,
        note,
        attested: true,
      });
      expect(await readRevenueInvoice(a, invoiceId)).toMatchObject({
        receivedMinor: "60000",
        outstandingMinor: "90000",
      });
      const finalPayment = await source(
        "Fictional final payment receipt",
        `${note}\nRecorded fictional receipt: 900.00 USD against invoice ${invoiceId}.`,
      );
      await revenueChange(engagementId, {
        kind: "receipt",
        invoiceId,
        amount: "900.00",
        paymentTotal: "900.00",
        receivedOn: today,
        reference: "FICTIONAL-CYCLE-FINAL",
        sourceId: finalPayment,
        note,
        attested: true,
      });
      revenue = await readRevenueDetail(a, engagementId);
      expect(revenue.receipts).toHaveLength(2);
      expect(revenue.engagement.totals).toMatchObject({
        earnedMinor: "150000",
        invoicedMinor: "150000",
        receivedMinor: "150000",
        outstandingMinor: "0",
      });
      expect((await readRevenueInvoice(a, invoiceId)).outstandingMinor).toBe("0");
      expect((await readExecution(a, requirementId)).deals.some((deal) => deal.id === dealId)).toBe(
        true,
      );
    });
    it("supersedes the buyer brief without erasing historical receipts or allowing another stale closing-based earning", async () => {
      const supplemental = await createEngagement(a, {
        terms: terms({
          title: "Fictional additional closing service fee",
          requirementId,
          dealId,
          signedSourceId,
          signatory: "Fictional Authorized Client",
          signedOn: today,
        }),
        idempotencyKey: randomUUID(),
      });
      newFeeEngagementId = supplemental.engagement.id;
      await revenueChange(newFeeEngagementId, { kind: "activate", note, attested: true });
      const updated = await reply(2);
      await accept(updated.runId);
      const accepted = await readAgentRun(a, updated.runId);
      revisedRequirementId = required(
        accepted.proposals.find((proposal) => proposal.id === updated.proposalId)?.appliedRef,
        "accepted revised buyer brief",
      );
      await actOnCommunication(a, updated.messageId, {
        kind: "use-revision",
        revision: (await readCommunicationMessage(a, updated.messageId)).revision,
        leadRevision: (await readLeadCase(a, leadId)).revision,
        runId: updated.runId,
        proposalId: updated.proposalId,
        note,
        attested: true,
      });
      const lead = await readLeadCase(a, leadId);
      expect(lead.requirement?.id).toBe(revisedRequirementId);
      expect(lead.requirement?.status).toBe("Draft");
      expect(lead.desk?.confirmation).toBeNull();
      await expect(advance(alternateDealId, "LOI")).rejects.toThrow(/superseded|changed|current/i);
      const completion = await transaction(a.actorId, a.workspaceId, (db) =>
        readTransactionCompletion(db, a, dealId),
      );
      expect(completion).toMatchObject({
        status: "Completed",
        contextChanged: true,
        completionSourceId: null,
      });
      await expect(
        revenueChange(newFeeEngagementId, {
          kind: "earn",
          earnedOn: today,
          basisAmount: null,
          sourceId: completionSourceId,
          note,
          attested: true,
        }),
      ).rejects.toThrow(/completed closing evidence/);
      const historical = await readRevenueDetail(a, engagementId);
      expect(historical.earnings[0].transactionSnapshot?.completionSourceId).toBe(
        completionSourceId,
      );
      expect(historical.receipts).toHaveLength(2);
      expect(historical.engagement.totals.receivedMinor).toBe("150000");
      expect((await readRevenueInvoice(a, invoiceId)).outstandingMinor).toBe("0");
      const original = await readExecution(a, requirementId);
      expect(original.confirmation).not.toBeNull();
      expect((await readTransaction(a, dealId)).status).toBe("Completed");
    });
  },
);
