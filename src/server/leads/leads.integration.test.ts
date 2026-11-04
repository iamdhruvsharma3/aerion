import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, transaction, workspaceFor, type Scope } from "../db";
import { createSource, decideReview, readPipeline, readWorkspace } from "../repository";
import { enqueueExtraction, processNext } from "../jobs";
import { sampleSource } from "../../lib/intelligence/schema";
import { calendarDate } from "../../lib/format";
import { runInputSchema, type AgentProposal } from "../../lib/agents/schema";
import { decideProposal, enqueueAgent, readAgentRun } from "../agents/repository";
import { processNextAgent } from "../agents/runtime";
import { AgentTools } from "../agents/tools";
import * as model from "../agents/model";
import * as collector from "../agents/collector";
import { mutateExecution } from "../execution";
import { queueDelivery, processNextDelivery, readMailStatus } from "../agents/delivery";
import { readLeadCase, mutateLeadCase } from "./workflow";
import { researchLead } from "./research";

const smtp = vi.hoisted(() => ({ send: vi.fn(), close: vi.fn(), create: vi.fn() }));
vi.mock("nodemailer", () => ({ default: { createTransport: smtp.create } }));
const testUrl = process.env.AERION_TEST_DATABASE_URL;
describe.skipIf(!testUrl)(
  "Buyer sourcing through qualification, opportunity and reviewed delivery",
  () => {
    const actors = [randomUUID(), randomUUID()];
    let a: Scope,
      b: Scope,
      leadId: string,
      aircraftId: string,
      originalRun: string,
      contactRun: string,
      briefId: string;
    const note =
      "Fictional engineering evidence and workflow reviewed; no real buyer or transaction is represented.";
    const company = "Fictional Meridian Aviation";
    const wanted = `${company} is seeking an Airbus A319 aircraft. This is a fictional engineering fixture only.`;
    const contactText = `${company} Acquisitions Desk. Business email: fixture-buyer@example.com. Location: India. Fictional engineering fixture only.`;
    const brief = `Client: ${company}\nAircraft family: Airbus A319\nMarket: Commercial\nQuantity: 1\nMinimum year: 2010\nEngine: CFM56\nBudget USD: 23000000\nDelivery deadline: 2027-06-01\nDestination: India\nFictional engineering fixture only. No real mandate.`;
    async function change(action: Parameters<typeof mutateLeadCase>[3]) {
      const detail = await readLeadCase(a, leadId);
      return mutateLeadCase(a, leadId, detail.revision, action);
    }
    async function accept(runId: string) {
      let run = await readAgentRun(a, runId);
      for (const p of run.proposals.filter((p) => p.status === "proposed")) {
        await decideProposal(a, p.id, {
          decision: "accept",
          revision: run.revision,
          note,
          attested: true,
        });
        run = await readAgentRun(a, runId);
      }
      return run;
    }
    beforeAll(async () => {
      if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
        throw new Error("Dedicated _test database required.");
      process.env.DATABASE_URL = testUrl;
      execFileSync(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
        env: { ...process.env, DATABASE_URL: testUrl },
        stdio: "pipe",
      });
      a = await workspaceFor(actors[0]);
      b = await workspaceFor(actors[1]);
      vi.stubEnv("NVIDIA_API_KEY", "fake-test-key");
      vi.stubEnv("NVIDIA_MODEL", "nvidia/test-model");
      vi.stubEnv("AERION_MAIL_OWNER_ID", a.actorId);
      vi.stubEnv("SMTP_HOST", "smtp.example.com");
      vi.stubEnv("SMTP_PORT", "465");
      vi.stubEnv("SMTP_USER", "founder-fixture@example.com");
      vi.stubEnv("SMTP_FROM", "founder-fixture@example.com");
      vi.stubEnv("SMTP_PASSWORD", "fake-test-password");
      vi.stubEnv("SMTP_ACCESS_TOKEN", "");
      smtp.create.mockReturnValue({ sendMail: smtp.send, close: smtp.close });
      smtp.send.mockImplementation(async (message: { to: string }) => ({
        accepted: [message.to],
        response: "250 Fictional SMTP acceptance",
      }));
      vi.spyOn(collector, "fetchPublicSource").mockImplementation(async (url) => ({
        url,
        contentType: "text/html",
        original: Buffer.from(
          `<html><main>${url.includes("contact") ? contactText : wanted}</main></html>`,
        ),
      }));
      vi.spyOn(model, "runModel").mockImplementation(async (tools) => {
        const manifest = (await tools.invoke("discover_sources", {})) as {
          results: { id: string }[];
        };
        const page = (await tools.invoke("inspect_discovery_source", {
          resultId: manifest.results[0].id,
        })) as { resultId: string; sourceId: string; text: string };
        let proposal: AgentProposal;
        if (tools.run.input.discovery?.purpose === "contacts") {
          const selected = (await tools.invoke("workspace_context", {})) as {
            lead: { id: string };
            contacts?: unknown;
          };
          expect(selected.lead.id).toBe(leadId);
          expect(selected.contacts).toBeUndefined();
          proposal = {
            title: "Retain fictional published acquisitions contact",
            reason: note,
            action: {
              type: "lead-enrichment",
              leadId: tools.run.input.leadId ?? "",
              resultId: page.resultId,
              sourceId: page.sourceId,
              values: {
                organization: company,
                contactName: "Acquisitions Desk",
                email: "fixture-buyer@example.com",
                phone: null,
                geography: "India",
                summary:
                  "Fictional published business details; relationship and address ownership are not established.",
              },
            },
            citations: [{ sourceId: page.sourceId, page: 1, quote: page.text }],
          };
        } else
          proposal = {
            title: "Review fictional stated acquisition demand",
            reason: note,
            action: {
              type: "lead",
              resultId: page.resultId,
              sourceId: page.sourceId,
              values: {
                side: "Buyer",
                basis: "Stated demand",
                organization: company,
                aircraftModel: "Airbus A319",
                geography: null,
                contactName: null,
                email: null,
                phone: null,
                summary:
                  "Fictional sourced demand signal requiring qualification; no real buyer is represented.",
              },
            },
            citations: [{ sourceId: page.sourceId, page: 1, quote: page.text }],
          };
        await tools.invoke("propose_action", proposal);
        return {
          report: {
            summary: note,
            findings: [
              {
                title: "Fictional source retained",
                detail: note,
                severity: "review",
                citations: proposal.citations,
              },
            ],
            limitations: ["Fictional integration test only."],
          },
          usage: { inputTokens: 0, outputTokens: 0, requests: 0 },
        };
      });
      const aircraft = await createSource(a, {
        title: "Fictional qualification aircraft",
        kind: "text",
        sourceUrl: null,
        filename: "fixture.txt",
        contentType: "text/plain",
        original: Buffer.from(sampleSource),
        pages: [{ page: 1, text: sampleSource }],
      });
      await enqueueExtraction(a, aircraft.id, "local");
      await processNext(a);
      const review = (await readPipeline(a)).reviews[0];
      aircraftId =
        (await decideReview(a, review.id, { decision: "approve", note: "", attested: true }))
          .aircraftId ?? "";
      const original = await enqueueAgent(
        a,
        runInputSchema.parse({
          agentId: "buyer-discovery",
          provider: "nvidia",
          aircraftId: null,
          requirementId: null,
          contactId: null,
          sourceIds: [],
          connectorIds: [],
          objective: note,
          allowExternalSources: true,
          allowModelData: true,
          idempotencyKey: randomUUID(),
          discovery: {
            side: "Buyer",
            target: "Airbus A319",
            market: "Any",
            region: "",
            method: "urls",
            query: "",
            urls: ["https://fictional.example.com/wanted"],
            freshness: "any",
            buyerIntent: "Demand",
          },
        }),
      );
      originalRun = original.id;
      await processNextAgent(a);
      await accept(original.id);
      const first = await readAgentRun(a, original.id);
      leadId = first.proposals[0].appliedRef ?? "";
    });
    afterAll(async () => {
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      if (!a) return;
      const db = await pool().connect();
      try {
        await db.query("begin");
        for (const table of [
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
          "agent_runs",
          "readiness_items",
          "case_actions",
          "outreach_drafts",
          "shortlist_decisions",
          "case_contacts",
          "execution_cases",
          "reviews",
          "extractions",
          "sources",
        ]) {
          const exists = await db.query("select to_regclass($1) as name", [`aerion.${table}`]);
          if (exists.rows[0].name)
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
    it("saves a reviewed signal as a working lead without inventing a contact or confirmed brief", async () => {
      expect(leadId).toBeTruthy();
      const detail = await readLeadCase(a, leadId);
      expect(detail.contact).toBeNull();
      expect(detail.requirement).toBeNull();
      expect(detail.sources.map((s) => s.purpose)).toContain("Original");
      expect(detail.readiness.every((r) => !r.ready)).toBe(true);
      await expect(readLeadCase(b, leadId)).rejects.toThrow(/not found/);
      await expect(
        mutateLeadCase(a, leadId, detail.revision + 1, {
          kind: "update",
          status: "Qualifying",
          nextAction: "",
          dueOn: null,
        }),
      ).rejects.toThrow(/changed/);
    });
    it("researches and reviews contact evidence while keeping CRM creation a separate decision", async () => {
      const detail = await readLeadCase(a, leadId);
      const result = await researchLead(a, leadId, {
        revision: detail.revision,
        kind: "contacts",
        provider: "nvidia",
        allowExternalSources: true,
        allowModelData: true,
        urls: ["https://fictional.example.com/contact"],
        idempotencyKey: randomUUID(),
      });
      if (!("id" in result)) throw new Error("Expected agent run");
      contactRun = result.id;
      await processNextAgent(a);
      expect((await readAgentRun(a, contactRun)).status).toBe("review");
      await accept(contactRun);
      const next = await readLeadCase(a, leadId);
      expect(next.enrichments).toHaveLength(1);
      expect(next.enrichments[0].values.email).toBe("fixture-buyer@example.com");
      expect(next.sources.some((s) => s.purpose === "Contact")).toBe(true);
      expect((await readWorkspace(a)).data.contacts).toHaveLength(0);
      await change({
        kind: "create-contact",
        values: {
          name: "Acquisitions Desk",
          company,
          email: "fixture-buyer@example.com",
          role: "Buyer representative",
          location: "India",
          type: "Buyer",
          notes: note,
        },
        note,
        attested: true,
      });
      expect((await readLeadCase(a, leadId)).contact?.email).toBe("fixture-buyer@example.com");
    });
    it("prepares an enquiry, rejects unreviewed delivery and submits only its reviewed immutable version", async () => {
      await change({ kind: "prepare-draft" });
      let detail = await readLeadCase(a, leadId);
      const draft = detail.drafts[0];
      expect(draft.body).toContain("Could you confirm");
      expect(draft.recipient).toBe("fixture-buyer@example.com");
      await expect(
        queueDelivery(a, {
          draftId: draft.id,
          kind: "lead",
          idempotencyKey: randomUUID(),
          attested: true,
          note,
        }),
      ).rejects.toThrow(/reviewed/);
      await change({
        kind: "review-draft",
        draftId: draft.id,
        status: "Reviewed",
        note,
        attested: true,
      });
      const request = {
        draftId: draft.id,
        kind: "lead" as const,
        idempotencyKey: randomUUID(),
        attested: true as const,
        note,
      };
      const queued = await queueDelivery(a, request);
      expect((await queueDelivery(a, request)).id).toBe(queued.id);
      await processNextDelivery(a);
      const mail = await readMailStatus(a, draft.id);
      expect(mail.deliveries[0].status).toBe("accepted");
      expect(mail.deliveries[0].requirementId).toBeNull();
      expect(smtp.send).toHaveBeenCalledTimes(1);
      expect(smtp.send.mock.calls[0][0].text).toBe(draft.body);
      detail = await readLeadCase(a, leadId);
      expect(detail.drafts[0].status).toBe("Reviewed");
    });
    it("analyzes an attached buyer reply into a Draft brief bound to the original lead", async () => {
      const source = await createSource(a, {
        title: "Fictional buyer reply",
        kind: "text",
        sourceUrl: null,
        filename: "reply.txt",
        contentType: "text/plain",
        original: Buffer.from(brief),
        pages: [{ page: 1, text: brief }],
      });
      briefId = source.id;
      await change({ kind: "attach-source", sourceId: briefId, purpose: "Buyer brief", note });
      const detail = await readLeadCase(a, leadId);
      await expect(
        researchLead(a, leadId, {
          revision: detail.revision,
          kind: "brief",
          provider: "rules",
          allowExternalSources: false,
          allowModelData: false,
          sourceIds: [],
          idempotencyKey: randomUUID(),
        }),
      ).rejects.toThrow(/Attach/);
      const run = await researchLead(a, leadId, {
        revision: detail.revision,
        kind: "brief",
        provider: "rules",
        allowExternalSources: false,
        allowModelData: false,
        idempotencyKey: randomUUID(),
      });
      if (!("id" in run)) throw new Error("Expected agent run");
      const later = await createSource(a, {
        title: "Fictional later attachment",
        kind: "text",
        sourceUrl: null,
        filename: "later.txt",
        contentType: "text/plain",
        original: Buffer.from("Fictional later private attachment. Not selected for this run."),
        pages: [
          { page: 1, text: "Fictional later private attachment. Not selected for this run." },
        ],
      });
      await change({ kind: "attach-source", sourceId: later.id, purpose: "Buyer brief", note });
      const queuedRun = await readAgentRun(a, run.id),
        queuedTools = new AgentTools(
          a,
          queuedRun,
          new AbortController().signal,
          async () => {},
          async () => {},
        );
      expect((await queuedTools.sources()).map((s) => s.id)).toEqual([briefId]);
      await processNextAgent(a);
      const result = await readAgentRun(a, run.id);
      expect(result.status, result.error ?? "").toBe("review");
      expect(
        result.proposals.some((p) => p.action.type === "requirement" && p.action.leadId === leadId),
      ).toBe(true);
      await accept(run.id);
      const next = await readLeadCase(a, leadId);
      expect(next.requirement?.status).toBe("Draft");
      expect(next.requirement?.minYear).toBe(2010);
      expect(next.desk?.confirmation).toBeNull();
    });
    it("blocks an opportunity before confirmation, then creates shortlist, offer and deal atomically", async () => {
      const action = {
        kind: "opportunity",
        aircraftId,
        dueOn: calendarDate(),
        note,
        attested: true,
      };
      await expect(change(action)).rejects.toThrow(/Confirm/);
      expect((await readLeadCase(a, leadId)).desk?.deals).toHaveLength(0);
      await change({
        kind: "confirm",
        confirmation: { contact: "Acquisitions Desk", confirmedOn: calendarDate(), basis: note },
        note,
        attested: true,
      });
      const before = await readLeadCase(a, leadId);
      expect(before.desk?.matches.find((m) => m.aircraft.id === aircraftId)?.state).toBe(
        "eligible",
      );
      const result = await change(action);
      const detail = await readLeadCase(a, leadId);
      expect(detail.desk?.deals[0].id).toBe(result.recordId);
      expect(detail.desk?.drafts).toHaveLength(1);
      expect(detail.desk?.contacts[0].email).toBe("fixture-buyer@example.com");
      expect(detail.desk?.decisions.find((d) => d.aircraftId === aircraftId)?.decision).toBe(
        "Shortlisted",
      );
      expect(detail.readiness.every((r) => r.ready)).toBe(true);
      expect(detail.drafts[0].stale).toBe(true);
      expect((await change(action)).recordId).toBe(result.recordId);
      expect((await readLeadCase(a, leadId)).desk?.drafts).toHaveLength(1);
    });
    it("reviews and submits the evidence-backed aircraft offer using the existing delivery workflow", async () => {
      const callsBefore = smtp.send.mock.calls.length;
      const detail = await readLeadCase(a, leadId);
      if (!detail.desk) throw new Error("Expected execution desk");
      const draft = detail.desk.drafts[0];
      expect(draft.claims.some((c) => c.field === "aircraft.serial")).toBe(true);
      await mutateExecution(
        a,
        detail.desk.requirement.id,
        { type: "review-draft", draftId: draft.id, status: "Reviewed", note, attested: true },
        detail.desk.revision,
      );
      const queued = await queueDelivery(a, {
        draftId: draft.id,
        idempotencyKey: randomUUID(),
        attested: true,
        note,
      });
      expect(queued.reused).toBe(false);
      await processNextDelivery(a);
      expect((await readMailStatus(a, draft.id)).deliveries[0]).toMatchObject({
        id: queued.id,
        status: "accepted",
      });
      expect(smtp.send).toHaveBeenCalledTimes(callsBefore + 1);
    });
    it("deduplicates approved contact facts and rejects cross-lead substitutions or immutable edits", async () => {
      const detail = await readLeadCase(a, leadId);
      const result = await researchLead(a, leadId, {
        revision: detail.revision,
        kind: "contacts",
        provider: "nvidia",
        allowExternalSources: true,
        allowModelData: true,
        urls: ["https://fictional.example.com/contact"],
        idempotencyKey: randomUUID(),
      });
      if (!("id" in result)) throw new Error("Expected run");
      await processNextAgent(a);
      const run = await readAgentRun(a, result.id);
      expect(run.proposals).toHaveLength(0);
      expect(run.steps.find((s) => s.tool === "propose_action")?.output).toMatchObject({
        alreadySaved: true,
      });
      expect((await readLeadCase(a, leadId)).enrichments).toHaveLength(1);
      const original = await readAgentRun(a, contactRun);
      const action = original.proposals[0].action;
      if (action.type !== "lead-enrichment") throw new Error("Expected enrichment");
      const tools = new AgentTools(
        a,
        run,
        new AbortController().signal,
        async () => {},
        async () => {},
      );
      const inspected = run.steps.find((step) => step.tool === "inspect_discovery_source")
        ?.input as { resultId: string };
      await tools.invoke("inspect_discovery_source", inspected);
      await expect(
        tools.invoke("propose_action", {
          ...original.proposals[0],
          action: { ...action, resultId: inspected.resultId, leadId: randomUUID() },
        }),
      ).rejects.toThrow(/authorized/);
      await expect(
        transaction(a.actorId, a.workspaceId, (db) =>
          db.query("update aerion.lead_drafts set body='changed' where workspace_id=$1", [
            a.workspaceId,
          ]),
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        transaction(b.actorId, a.workspaceId, (db) =>
          db.query("select * from aerion.lead_enrichments"),
        ),
      ).resolves.toMatchObject({ rows: [] });
      expect(originalRun).toBeTruthy();
      expect(briefId).toBeTruthy();
    });
    it("rechecks a queued qualification draft before SMTP and does not send after the lead is dismissed", async () => {
      await change({ kind: "prepare-draft" });
      const draft = (await readLeadCase(a, leadId)).drafts[0];
      await change({
        kind: "review-draft",
        draftId: draft.id,
        status: "Reviewed",
        note,
        attested: true,
      });
      await queueDelivery(a, {
        draftId: draft.id,
        kind: "lead",
        idempotencyKey: randomUUID(),
        attested: true,
        note,
      });
      const calls = smtp.send.mock.calls.length;
      await change({
        kind: "update",
        status: "Dismissed",
        nextAction: "Fictional test complete",
        dueOn: null,
      });
      await processNextDelivery(a);
      expect((await readMailStatus(a, draft.id)).deliveries[0].status).toBe("failed");
      expect(smtp.send.mock.calls.length).toBe(calls);
    });
  },
);
