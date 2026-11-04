import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sampleSource } from "../lib/intelligence/schema";
import { pool, workspaceFor, type Scope } from "./db";
import { createSource, decideReview, readPipeline, readWorkspace } from "./repository";
import { enqueueExtraction, processNext } from "./jobs";
import { enqueueAgent, readAgentRun, decideProposal } from "./agents/repository";
import { processNextAgent } from "./agents/runtime";
import type { AgentId } from "../lib/agents/catalog";
const testUrl = process.env.AERION_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("Reviewed sale/lease source intake", () => {
  const actor = randomUUID();
  const note =
    "Fictional sale/lease intake fixture only. No actual counterparty, sourcing mandate, aircraft offer or transaction is represented.";
  let scope: Scope;
  const aircraftIds = new Map<string, string>();
  async function retain(title: string, text: string) {
    return (
      await createSource(scope, {
        title,
        kind: "text",
        sourceUrl: null,
        filename: "fictional-terms.txt",
        contentType: "text/plain",
        original: Buffer.from(text),
        pages: [{ page: 1, text }],
      })
    ).id;
  }
  async function run(agentId: AgentId, sourceIds: string[], aircraftId: string | null = null) {
    const queued = await enqueueAgent(scope, {
      agentId,
      provider: "rules",
      aircraftId,
      requirementId: null,
      contactId: null,
      sourceIds,
      connectorIds: [],
      objective: note,
      allowExternalSources: false,
      allowModelData: false,
      allowMailbox: false,
      idempotencyKey: randomUUID(),
    });
    await processNextAgent(scope);
    const detail = await readAgentRun(scope, queued.id);
    expect(detail.error).toBeNull();
    return detail;
  }
  beforeAll(async () => {
    if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
      throw new Error("Dedicated _test database required");
    process.env.DATABASE_URL = testUrl;
    execFileSync(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
      env: { ...process.env, DATABASE_URL: testUrl },
      stdio: "pipe",
    });
    scope = await workspaceFor(actor);
  });
  afterAll(async () => {
    if (!scope) return;
    const db = await pool().connect();
    try {
      await db.query("begin");
      for (const table of [
        "activity",
        "agent_proposals",
        "agent_steps",
        "agent_runs",
        "reviews",
        "extractions",
        "sources",
      ])
        await db.query(`delete from aerion.${table} where workspace_id=$1`, [scope.workspaceId]);
      await db.query("delete from aerion.workspaces where owner_id=$1", [actor]);
      await db.query("commit");
    } catch (error) {
      await db.query("rollback");
      throw error;
    } finally {
      db.release();
      await pool().end();
    }
  });
  it("retains and approves purchase, lease, dual and ambiguous aircraft without applying legacy sale defaults to new unknowns", async () => {
    for (const [name, terms, expected] of [
      [
        "Lease",
        "Offering: Lease\nLeaseRate: 200000\nLeaseCurrency: EUR\nLeaseBasis: Monthly rent",
        {
          offering: "Lease",
          price: null,
          leaseRate: 200000,
          leaseCurrency: "EUR",
          leaseBasis: "Monthly rent",
        },
      ],
      ["Unknown", "", { offering: "Not supplied", price: null, leaseRate: null }],
      ["Sale", "Price USD: 21500000", { offering: "Sale", price: 21500000, leaseRate: null }],
      [
        "Dual",
        "Offering: Sale or lease\nPurchase price USD: 21500000\nLease rate USD per hour: 1800",
        {
          offering: "Sale or lease",
          price: 21500000,
          leaseRate: 1800,
          leaseCurrency: "USD",
          leaseBasis: "Hourly rate",
        },
      ],
    ] as const) {
      const text = sampleSource
        .replace("LOCAL-EXAMPLE-01", `FICTIONAL-TERMS-${randomUUID()}`)
        .replace("Price USD: 21500000", terms);
      const sourceId = await retain(`Fictional ${name} aircraft`, text);
      await enqueueExtraction(scope, sourceId, "local");
      await processNext(scope);
      const review = (await readPipeline(scope)).reviews.find((item) => item.sourceId === sourceId);
      if (!review) throw new Error("Expected retained source review");
      const result = await decideReview(scope, review.id, {
        decision: "approve",
        note,
        attested: true,
      });
      if (!result.aircraftId) throw new Error("Expected approved aircraft");
      aircraftIds.set(name, result.aircraftId);
      expect(
        (await readWorkspace(scope)).data.aircraft.find((item) => item.id === result.aircraftId),
      ).toMatchObject(expected);
    }
    const intelligence = await run("aircraft-intelligence", [], aircraftIds.get("Lease"));
    const brief = intelligence.report?.findings.find((finding) =>
      finding.title.includes("FICTIONAL-TERMS"),
    );
    expect(brief?.detail).toContain("lease rate: 200000 EUR (Monthly rent)");
    expect(brief?.citations.some((citation) => citation.quote.includes("LeaseRate: 200000"))).toBe(
      true,
    );
    expect(
      intelligence.report?.findings.find(
        (finding) => finding.title === "Missing aircraft information",
      )?.detail ?? "",
    ).not.toContain("purchase asking");
  });
  it("rules agent produces source-backed Lease and explicit unknown drafts and routes monthly Budget USD away from purchase budget", async () => {
    for (const [name, terms, expected] of [
      [
        "Explicit lease",
        "Transaction: Lease\nLease budget: 200000\nLease currency: EUR\nLease basis: Monthly rent",
        {
          transactionKind: "Lease",
          budget: null,
          leaseBudget: 200000,
          leaseCurrency: "EUR",
          leaseBasis: "Monthly rent",
        },
      ],
      [
        "Ambiguous",
        "No commercial terms supplied.",
        { transactionKind: "Not supplied", budget: null, leaseBudget: null },
      ],
      [
        "Rental budget label",
        "Transaction: Lease\nBudget USD: 200000 per month",
        {
          transactionKind: "Lease",
          budget: null,
          leaseBudget: 200000,
          leaseCurrency: "USD",
          leaseBasis: "Monthly rent",
        },
      ],
    ] as const) {
      const client = `Fictional ${name} ${randomUUID()}`;
      const text = `Client: ${client}\nAircraft family: Airbus A319\nMarket: Commercial\nQuantity: 1\nMinimum year: 2010\nDestination: India\n${terms}\n${note}`;
      const sourceId = await retain(`Fictional ${name} buyer brief`, text);
      let detail = await run("buyer-requirements", [sourceId]);
      const proposal = detail.proposals.find((item) => item.action.type === "requirement");
      expect(proposal?.action).toMatchObject({ type: "requirement", values: expected });
      if (!proposal) throw new Error("Expected requirement proposal");
      const accepted = await decideProposal(scope, proposal.id, {
        decision: "accept",
        revision: detail.revision,
        note,
        attested: true,
      });
      expect(accepted.status).toBe("accepted");
      expect(
        (await readWorkspace(scope)).data.requirements.find((item) => item.id === accepted.appliedRef),
      ).toMatchObject({ ...expected, status: "Draft" });
      detail = await readAgentRun(scope, detail.id);
      expect(detail.proposals.find((item) => item.id === proposal.id)?.status).toBe("accepted");
    }
  });
});
