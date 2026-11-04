import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, workspaceFor, transaction, type Scope } from "../db";
import { createSource, readWorkspace } from "../repository";
import { runInputSchema } from "../../lib/agents/schema";
import {
  enqueueAgent,
  readAgentRun,
  retainProposal,
  decideProposal,
  changeRun,
} from "../agents/repository";
import { discoverSources } from "../discovery/service";
import { readLeadCase, mutateLeadCase } from "../leads/workflow";
import { queueDelivery, readMailStatus } from "../agents/delivery";
import { processNextAgent } from "../agents/runtime";
import { AgentTools } from "../agents/tools";
import { calendarDate } from "../../lib/format";
import { readExecution } from "../execution";
import {
  actOnCommunication,
  decideSuppression,
  readCommunicationInbox,
  readCommunicationMessage,
  retainEmailUpload,
} from "./service";
import { assertCommunicationDelivery } from "./delivery-guard";
import { retiredReplySourceIds, requirementNeedsRequalification } from "./context";

const testUrl = process.env.AERION_TEST_DATABASE_URL;
function required<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) throw new Error(`Missing fictional fixture: ${label}`);
  return value;
}
describe.skipIf(!testUrl)("Retained replies through reviewed buyer-brief revision", () => {
  const actors = [randomUUID(), randomUUID()],
    note =
      "Fictional communication engineering fixture only. No real buyer, instruction or external message is represented.";
  const company = "Fictional Reply Meridian",
    recipient = "fictional-reply-buyer@example.com",
    sender = "fictional-founder@example.com";
  let a: Scope,
    b: Scope,
    leadId: string,
    otherLeadId: string,
    replyId: string,
    originalRequirementId: string,
    revisionRunId: string,
    revisionProposalId: string,
    revisedRequirementId: string;
  let delivered: { id: string; messageId: string }[], initialRunId: string;
  const body = (quantity: number) =>
    `Client: ${company}\nAircraft family: Airbus A319\nMarket: Commercial\nQuantity: ${quantity}\nMinimum year: 2010\nEngine: CFM56\nBudget USD: 23000000\nDelivery deadline: 2027-06-01\nDestination: India\n${note}`;
  const email = (key: string, content: string, refs: string[], from = recipient) =>
    Buffer.from(
      `From: Acquisitions <${from}>\r\nTo: ${sender}\r\nSubject: Fictional reply ${key}\r\nMessage-ID: <${key}@example.com>\r\nIn-Reply-To: ${refs[0] ?? "<unmatched@example.com>"}\r\nReferences: ${refs.join(" ")}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${content}`,
    );
  async function changeLead(id: string, action: Parameters<typeof mutateLeadCase>[3]) {
    return mutateLeadCase(a, id, (await readLeadCase(a, id)).revision, action);
  }
  async function act(id: string, action: Record<string, unknown>) {
    return actOnCommunication(a, id, {
      revision: (await readCommunicationMessage(a, id)).revision,
      ...action,
    });
  }
  async function accept(runId: string) {
    let run = await readAgentRun(a, runId);
    for (const proposal of run.proposals.filter((p) => p.status === "proposed")) {
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
  async function seedLead(suffix: string, organization = company) {
    const text = `${organization} is seeking an Airbus A319 aircraft. ${note}`;
    const source = await createSource(a, {
      title: `Fictional reply signal ${suffix}`,
      kind: "text",
      sourceUrl: `https://fictional.example.com/${suffix}`,
      filename: `${suffix}.txt`,
      contentType: "text/plain",
      original: Buffer.from(`${text}\n${suffix}`),
      pages: [{ page: 1, text }],
    });
    const run = await enqueueAgent(
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
          urls: [`https://fictional.example.com/${suffix}`],
          freshness: "any",
        },
      }),
    );
    const manifest = await discoverSources(
        a,
        await readAgentRun(a, run.id),
        new AbortController().signal,
      ),
      resultId = manifest.results[0].id;
    const proposalId = await transaction(a.actorId, a.workspaceId, async (db) => {
      await db.query(
        "update aerion.discovery_results set status='retained',source_id=$1 where workspace_id=$2 and id=$3",
        [source.id, a.workspaceId, resultId],
      );
      await db.query(
        "update aerion.agent_runs set status='review',finished_at=now() where workspace_id=$1 and id=$2",
        [a.workspaceId, run.id],
      );
      return retainProposal(db, a, run.id, "buyer-discovery", {
        title: "Review fictional buyer demand",
        reason: note,
        action: {
          type: "lead",
          resultId,
          sourceId: source.id,
          values: {
            side: "Buyer",
            basis: "Stated demand",
            organization,
            aircraftModel: "Airbus A319",
            geography: null,
            contactName: null,
            email: null,
            phone: null,
            summary: note,
          },
        },
        citations: [{ sourceId: source.id, page: 1, quote: text }],
      });
    });
    const detail = await readAgentRun(a, run.id);
    await decideProposal(a, required(proposalId, "lead proposal"), {
      decision: "accept",
      revision: detail.revision,
      note,
      attested: true,
    });
    return required((await readAgentRun(a, run.id)).proposals[0].appliedRef, "saved lead");
  }
  beforeAll(async () => {
    if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
      throw new Error("Dedicated _test database required.");
    process.env.DATABASE_URL = testUrl;
    a = await workspaceFor(actors[0]);
    b = await workspaceFor(actors[1]);
    vi.stubEnv("AERION_MAIL_OWNER_ID", a.actorId);
    vi.stubEnv("SMTP_HOST", "smtp.example.com");
    vi.stubEnv("SMTP_PORT", "465");
    vi.stubEnv("SMTP_USER", sender);
    vi.stubEnv("SMTP_FROM", sender);
    vi.stubEnv("SMTP_PASSWORD", "fake-test-only");
    vi.stubEnv("SMTP_ACCESS_TOKEN", "");
    leadId = await seedLead(`reply-a-${randomUUID()}`);
    otherLeadId = await seedLead(`reply-b-${randomUUID()}`);
    await changeLead(leadId, {
      kind: "create-contact",
      values: {
        name: "Fictional Acquisition Desk",
        company,
        email: recipient,
        role: "Fictional buyer representative",
        location: "India",
        type: "Buyer",
        notes: note,
      },
      note,
      attested: true,
    });
    const contact = required((await readLeadCase(a, leadId)).contact, "business contact");
    await changeLead(otherLeadId, { kind: "link-contact", contactId: contact.id, note });
    delivered = [];
    for (const id of [leadId, otherLeadId]) {
      await changeLead(id, { kind: "prepare-draft" });
      const draft = (await readLeadCase(a, id)).drafts[0];
      await changeLead(id, {
        kind: "review-draft",
        draftId: draft.id,
        status: "Reviewed",
        note,
        attested: true,
      });
      const queued = await queueDelivery(a, {
        draftId: draft.id,
        kind: "lead",
        idempotencyKey: randomUUID(),
        attested: true,
        note,
      });
      // Seed a fictional acceptance fixture. No SMTP client is executed in this suite.
      await transaction(a.actorId, a.workspaceId, (db) =>
        db.query(
          "update aerion.mail_deliveries set status='accepted',finished_at=now(),server_response='Fictional test fixture; no network submission' where workspace_id=$1 and id=$2",
          [a.workspaceId, queued.id],
        ),
      );
      const delivery = (await readMailStatus(a, draft.id)).deliveries[0];
      delivered.push({ id: delivery.id, messageId: delivery.messageId });
    }
  });
  afterAll(async () => {
    vi.unstubAllEnvs();
    if (!a) return;
    const db = await pool().connect();
    try {
      await db.query("begin");
      for (const table of [
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
        const exists = (await db.query("select to_regclass($1) as name", [`aerion.${table}`]))
          .rows[0].name;
        if (exists)
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
  it("retains exact originals, deduplicates uploads and suggests but never silently links a thread", async () => {
    const original = email(`first-${randomUUID()}`, body(1), [delivered[0].messageId]);
    const retained = await retainEmailUpload(a, original, "fictional-first.eml");
    replyId = retained.id;
    expect((await retainEmailUpload(a, original, "renamed.eml")).id).toBe(replyId);
    const message = await readCommunicationMessage(a, replyId);
    expect(message.state).toBe("Suggested");
    expect(message.leadId).toBeNull();
    expect(message.suggestedLeadIds).toEqual([leadId]);
    expect(message.matchedDeliveryIds).toEqual([delivered[0].id]);
    expect((await readLeadCase(a, leadId)).sources).toHaveLength(1);
    const bytes = await transaction(
      a.actorId,
      a.workspaceId,
      async (db) =>
        (
          await db.query("select original from aerion.sources where workspace_id=$1 and id=$2", [
            a.workspaceId,
            message.sourceId,
          ])
        ).rows[0].original,
    );
    expect(bytes.equals(original)).toBe(true);
  });
  it("keeps spoofed addresses unassigned and multi-lead references ambiguous", async () => {
    const spoof = await retainEmailUpload(
      a,
      email(`spoof-${randomUUID()}`, note, [delivered[0].messageId], "unrelated@example.com"),
      "spoof.eml",
    );
    expect((await readCommunicationMessage(a, spoof.id)).state).toBe("Unassigned");
    const ambiguous = await retainEmailUpload(
      a,
      email(
        `ambiguous-${randomUUID()}`,
        note,
        delivered.map((row) => row.messageId),
      ),
      "ambiguous.eml",
    );
    expect((await readCommunicationMessage(a, ambiguous.id)).state).toBe("Ambiguous");
    await act(ambiguous.id, { kind: "dismiss", note });
    expect((await readCommunicationMessage(a, ambiguous.id)).state).toBe("Dismissed");
    await act(ambiguous.id, { kind: "reopen", note });
    expect((await readCommunicationMessage(a, ambiguous.id)).state).toBe("Ambiguous");
    await act(ambiguous.id, { kind: "link", leadId: otherLeadId, note, attested: true });
    expect((await readCommunicationMessage(a, ambiguous.id)).leadId).toBe(otherLeadId);
  });
  it("requires owner scope, current revisions and reviewed manual assignment", async () => {
    await expect(readCommunicationMessage(b, replyId)).rejects.toThrow(/not found/);
    await expect(
      actOnCommunication(a, replyId, { kind: "link", leadId, revision: 99, note, attested: true }),
    ).rejects.toThrow(/changed/);
    await expect(
      actOnCommunication(a, replyId, { kind: "link", leadId, revision: 0, note, attested: false }),
    ).rejects.toThrow();
    await act(replyId, { kind: "link", leadId, note, attested: true });
    const message = await readCommunicationMessage(a, replyId);
    expect(message.state).toBe("Linked");
    expect(
      (await readLeadCase(a, leadId)).sources.some(
        (source) => source.id === message.sourceId && source.purpose === "Buyer brief",
      ),
    ).toBe(true);
    const hidden = await transaction(b.actorId, b.workspaceId, (db) =>
      db.query("select id from aerion.communication_messages where id=$1", [replyId]),
    );
    expect(hidden.rows).toHaveLength(0);
    await expect(
      transaction(a.actorId, a.workspaceId, (db) =>
        db.query(
          "update aerion.communication_messages set sender='changed@example.com' where id=$1",
          [replyId],
        ),
      ),
    ).rejects.toThrow(/permission/);
  });
  it("queues the exact reply selection and accepts a bound Draft before founder confirmation", async () => {
    const result = await act(replyId, {
      kind: "analyze",
      provider: "rules",
      allowModelData: false,
      idempotencyKey: randomUUID(),
    });
    initialRunId = String(result.runId);
    const queued = await readAgentRun(a, initialRunId),
      message = await readCommunicationMessage(a, replyId);
    expect(queued.input.sourceIds).toEqual([message.sourceId]);
    expect(queued.input.leadId).toBe(leadId);
    await processNextAgent(a);
    const accepted = await accept(initialRunId);
    expect(
      accepted.proposals.some(
        (proposal) => proposal.status === "accepted" && proposal.action.type === "requirement",
      ),
    ).toBe(true);
    const lead = await readLeadCase(a, leadId);
    originalRequirementId = required(lead.requirement, "initial requirement").id;
    expect(lead.requirement?.status).toBe("Draft");
    expect(lead.desk?.confirmation).toBeNull();
    await changeLead(leadId, {
      kind: "confirm",
      confirmation: {
        contact: "Fictional acquisition desk",
        confirmedOn: calendarDate(),
        basis: note,
      },
      note,
      attested: true,
    });
  });
  it("prepares a deduplicated private clarification draft with its actual connected recipient", async () => {
    const first = await act(replyId, { kind: "clarify", note, attested: true }),
      second = await act(replyId, { kind: "clarify", note, attested: true });
    expect(first.draftId).toBe(second.draftId);
    const draft = required(
      (await readLeadCase(a, leadId)).drafts.find((value) => value.id === first.draftId),
      "clarification draft",
    );
    expect(draft.status).toBe("Prepared");
    expect(draft.recipient).toBe(recipient);
    expect(draft.body).toContain("Budget amount, currency");
  });
  it("does not fill missing revised constraints from the existing requirement", async () => {
    const partial = await retainEmailUpload(
      a,
      email(`partial-${randomUUID()}`, `Quantity: 2\n${note}`, [delivered[0].messageId]),
      "partial.eml",
    );
    await act(partial.id, { kind: "link", leadId, note, attested: true });
    const queued = await act(partial.id, {
      kind: "analyze",
      provider: "rules",
      allowModelData: false,
      idempotencyKey: randomUUID(),
    });
    await processNextAgent(a);
    const run = await readAgentRun(a, String(queued.runId));
    expect(run.proposals).toHaveLength(0);
    expect(run.report?.findings.some((finding) => finding.detail.includes("client"))).toBe(true);
    expect((await readLeadCase(a, leadId)).requirement?.id).toBe(originalRequirementId);
  });
  it("requires an accepted reply-specific revision and preserves the old brief and confirmation", async () => {
    const revised = await retainEmailUpload(
      a,
      email(`complete-revision-${randomUUID()}`, body(2), [delivered[0].messageId]),
      "revision.eml",
    );
    await act(revised.id, { kind: "link", leadId, note, attested: true });
    const queued = await act(revised.id, {
      kind: "analyze",
      provider: "rules",
      allowModelData: false,
      idempotencyKey: randomUUID(),
    });
    revisionRunId = String(queued.runId);
    const run = await readAgentRun(a, revisionRunId);
    expect(run.input.leadId).toBeUndefined();
    expect(run.input.requirementId).toBeNull();
    await processNextAgent(a);
    const proposed = await readAgentRun(a, revisionRunId);
    expect(
      proposed.status,
      JSON.stringify({
        error: proposed.error,
        report: proposed.report,
        steps: proposed.steps.map((step) => ({ tool: step.tool, output: step.output })),
      }),
    ).toBe("review");
    revisionProposalId = required(
      proposed.proposals.find((proposal) => proposal.action.type === "requirement"),
      "revised requirement proposal",
    ).id;
    await expect(
      act(revised.id, {
        kind: "use-revision",
        runId: revisionRunId,
        proposalId: revisionProposalId,
        leadRevision: (await readLeadCase(a, leadId)).revision,
        note,
        attested: true,
      }),
    ).rejects.toThrow(/Accept/);
    await accept(revisionRunId);
    revisedRequirementId = required(
      (await readAgentRun(a, revisionRunId)).proposals.find(
        (proposal) => proposal.id === revisionProposalId,
      )?.appliedRef,
      "accepted revised requirement",
    );
    await act(revised.id, {
      kind: "use-revision",
      runId: revisionRunId,
      proposalId: revisionProposalId,
      leadRevision: (await readLeadCase(a, leadId)).revision,
      note,
      attested: true,
    });
    const lead = await readLeadCase(a, leadId);
    expect(lead.requirement?.id).toBe(revisedRequirementId);
    expect(lead.requirement?.quantity).toBe(2);
    expect(lead.requirement?.status).toBe("Draft");
    expect(lead.desk?.confirmation).toBeNull();
    expect((await readExecution(a, originalRequirementId)).confirmation).not.toBeNull();
    expect(
      (await readWorkspace(a)).data.requirements.some(
        (requirement) => requirement.id === originalRequirementId,
      ),
    ).toBe(true);
    expect((await readCommunicationMessage(a, revised.id)).revisions[0]).toMatchObject({
      priorRequirementId: originalRequirementId,
      requirementId: revisedRequirementId,
    });
    await expect(
      transaction(a.actorId, a.workspaceId, (db) =>
        assertCommunicationDelivery(db, a, recipient, originalRequirementId),
      ),
    ).rejects.toThrow(/superseded/);
    await expect(
      transaction(a.actorId, a.workspaceId, (db) =>
        assertCommunicationDelivery(db, a, recipient, revisedRequirementId),
      ),
    ).resolves.toBeUndefined();
  });
  it("records reviewed contact restrictions and requires an explicit lifting decision", async () => {
    await act(replyId, {
      kind: "suppress",
      email: recipient,
      reason: "Do not contact",
      note,
      attested: true,
    });
    await expect(
      transaction(a.actorId, a.workspaceId, (db) =>
        assertCommunicationDelivery(db, a, recipient.toUpperCase(), null),
      ),
    ).rejects.toThrow(/restriction/);
    const inbox = await readCommunicationInbox(a),
      entry = required(
        inbox.suppressions.find((row) => row.email === recipient),
        "contact restriction",
      );
    await expect(
      decideSuppression(b, {
        email: recipient,
        revision: entry.revision,
        active: false,
        note,
        attested: true,
      }),
    ).rejects.toThrow(/not found/);
    await decideSuppression(a, {
      email: recipient,
      revision: entry.revision,
      active: false,
      note,
      attested: true,
    });
    await expect(
      transaction(a.actorId, a.workspaceId, (db) =>
        assertCommunicationDelivery(db, a, recipient, null),
      ),
    ).resolves.toBeUndefined();
    expect((await readCommunicationInbox(b)).messages).toHaveLength(0);
  });
  it("retains supported attachments and freezes reply-analysis source selection", async () => {
    const key = randomUUID(),
      boundary = `fixture-${key}`;
    const original = Buffer.from(
      `From: ${recipient}\r\nTo: ${sender}\r\nSubject: Fictional attached buyer reply\r\nMessage-ID: <attachment-${key}@example.com>\r\nIn-Reply-To: ${delivered[0].messageId}\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=${boundary}\r\n\r\n--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${note}\r\n--${boundary}\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="fictional-reply-details.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(body(3)).toString("base64")}\r\n--${boundary}--\r\n`,
    );
    const retained = await retainEmailUpload(a, original, "attachments.eml", {
      title: "Founder supplied source title",
      sourceUrl: "https://fictional.example.com/reference",
    });
    let message = await readCommunicationMessage(a, retained.id);
    expect(message.title).toBe("Founder supplied source title");
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].filename).toBe("fictional-reply-details.txt");
    await act(retained.id, { kind: "link", leadId, note, attested: true });
    const result = await act(retained.id, {
      kind: "analyze",
      provider: "rules",
      allowModelData: false,
      idempotencyKey: randomUUID(),
    });
    const queued = await readAgentRun(a, String(result.runId));
    expect(new Set(queued.input.sourceIds)).toEqual(
      new Set([message.sourceId, message.attachments[0].id]),
    );
    const late = await createSource(a, {
      title: "Fictional late attachment",
      kind: "text",
      sourceUrl: null,
      filename: "late.txt",
      contentType: "text/plain",
      original: Buffer.from(`Later private attachment ${randomUUID()}`),
      pages: [{ page: 1, text: "Fictional late attachment outside the queued selection." }],
    });
    await transaction(a.actorId, a.workspaceId, (db) =>
      db.query(
        "insert into aerion.source_links(workspace_id,parent_id,child_id,relation) values($1,$2,$3,'attachment')",
        [a.workspaceId, message.sourceId, late.id],
      ),
    );
    const tools = new AgentTools(
      a,
      queued,
      new AbortController().signal,
      async () => {},
      async () => {},
    );
    expect((await tools.sources()).map((source) => source.id)).not.toContain(late.id);
    await changeRun(a, queued.id, queued.revision, "cancel");
    message = await readCommunicationMessage(a, retained.id);
    expect(message.attachments).toHaveLength(2);
  });
  it("corrects a reviewed wrong assignment prospectively and preserves adopted history", async () => {
    const correctedCompany = "Fictional Corrected Buyer",
      target = await seedLead(`corrected-${randomUUID()}`, correctedCompany);
    const retained = await retainEmailUpload(
      a,
      email(`correction-${randomUUID()}`, body(4).replace(company, correctedCompany), [
        delivered[0].messageId,
      ]),
      "correct-assignment.eml",
    );
    await act(retained.id, { kind: "link", leadId, note, attested: true });
    const wrongAnalysis = await act(retained.id, {
      kind: "analyze",
      provider: "rules",
      allowModelData: false,
      idempotencyKey: randomUUID(),
    });
    await processNextAgent(a);
    const oldRun = await readAgentRun(a, String(wrongAnalysis.runId));
    expect(oldRun.status).toBe("review");
    const historicalRequirementId = (await readLeadCase(a, leadId)).requirement?.id;
    await expect(
      actOnCommunication(b, retained.id, {
        kind: "correct-link",
        revision: 1,
        leadId: target,
        note,
        attested: true,
      }),
    ).rejects.toThrow(/not found/);
    await expect(
      act(retained.id, { kind: "correct-link", leadId: randomUUID(), note, attested: true }),
    ).rejects.toThrow(/not found/);
    await act(retained.id, { kind: "correct-link", leadId: target, note, attested: true });
    const corrected = await readCommunicationMessage(a, retained.id);
    expect(corrected.leadId).toBe(target);
    expect(corrected.assignmentCorrections).toHaveLength(1);
    expect(corrected.assignmentCorrections[0]).toMatchObject({
      priorLeadId: leadId,
      leadId: target,
      priorRequirementId: historicalRequirementId,
    });
    expect((await readLeadCase(a, leadId)).requirement?.id).toBe(historicalRequirementId);
    const obsolete = await readAgentRun(a, oldRun.id);
    expect(obsolete.status).toBe("cancelled");
    expect(obsolete.proposals.every((proposal) => proposal.status === "obsolete")).toBe(true);
    const oldInputs = await transaction(a.actorId, a.workspaceId, (db) =>
      retiredReplySourceIds(db, a, leadId),
    );
    expect(oldInputs.has(corrected.sourceId)).toBe(true);
    expect(
      await transaction(a.actorId, a.workspaceId, (db) =>
        requirementNeedsRequalification(
          db,
          a,
          required(historicalRequirementId, "old adopted requirement"),
        ),
      ),
    ).toBe(true);
    const rerouted = await act(retained.id, {
      kind: "analyze",
      provider: "rules",
      allowModelData: false,
      idempotencyKey: randomUUID(),
    });
    const next = await readAgentRun(a, String(rerouted.runId));
    expect(next.input.leadId).toBe(target);
    expect(next.input.sourceIds).toEqual([corrected.sourceId]);
    await processNextAgent(a);
    await accept(next.id);
    const newLead = await readLeadCase(a, target);
    expect(newLead.requirement?.client).toBe(correctedCompany);
    expect(newLead.requirement?.quantity).toBe(4);
    expect(newLead.requirement?.status).toBe("Draft");
    expect(newLead.desk?.confirmation).toBeNull();
    await expect(
      transaction(a.actorId, a.workspaceId, (db) =>
        db.query(
          "update aerion.communication_assignment_corrections set review_note='Changed history' where id=$1",
          [corrected.assignmentCorrections[0].id],
        ),
      ),
    ).rejects.toThrow(/permission/);
  });
  it("invalidates generic pending proposals and frozen queued context after assignment correction", async () => {
    const wrong = await seedLead(`generic-wrong-${randomUUID()}`, "Fictional Generic Wrong Lead");
    const actualCompany = "Fictional Generic Correct Lead",
      actual = await seedLead(`generic-correct-${randomUUID()}`, actualCompany);
    const retained = await retainEmailUpload(
      a,
      email(`generic-correction-${randomUUID()}`, body(5).replace(company, actualCompany), []),
      "generic-correction.eml",
    );
    await act(retained.id, { kind: "link", leadId: wrong, note, attested: true });
    const message = await readCommunicationMessage(a, retained.id);
    const request = (objective: string) =>
      runInputSchema.parse({
        agentId: "buyer-requirements",
        provider: "rules",
        leadId: wrong,
        aircraftId: null,
        requirementId: null,
        contactId: null,
        sourceIds: [message.sourceId],
        connectorIds: [],
        objective,
        allowExternalSources: false,
        allowModelData: false,
        idempotencyKey: randomUUID(),
      });
    const first = await enqueueAgent(
      a,
      request("Fictional generic proposal awaiting founder review."),
    );
    await processNextAgent(a);
    const proposal = required(
      (await readAgentRun(a, first.id)).proposals[0],
      "generic pending proposal",
    );
    const second = await enqueueAgent(
      a,
      request("Fictional generic queued run with a frozen source selection."),
    );
    await act(retained.id, { kind: "correct-link", leadId: actual, note, attested: true });
    const firstRun = await readAgentRun(a, first.id);
    const decision = await decideProposal(a, proposal.id, {
      decision: "accept",
      revision: firstRun.revision,
      note,
      attested: true,
    });
    expect(decision.status).toBe("obsolete");
    await processNextAgent(a);
    const rejected = await readAgentRun(a, second.id);
    expect(rejected.proposals).toHaveLength(0);
    expect((await readLeadCase(a, wrong)).requirement).toBeNull();
    await expect(
      enqueueAgent(a, request("Fictional attempt to enqueue retired wrong-assignment evidence.")),
    ).rejects.toThrow(/corrected/);
  });
});
