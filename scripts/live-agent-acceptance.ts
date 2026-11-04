import nextEnv from "@next/env";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pool, workspaceFor } from "../src/server/db";
import { calendarDate } from "../src/lib/format";
import { agentIds, type AgentId } from "../src/lib/agents/catalog";
import {
  createSource as source,
  decideReview,
  mutateWorkspace,
  readPipeline,
  readWorkspace,
} from "../src/server/repository";
import { enqueueExtraction, processNext } from "../src/server/jobs";
import { sampleSource } from "../src/lib/intelligence/schema";
import { mutateExecution, readExecution } from "../src/server/execution";
import { enqueueAgent, readAgentRun, decideProposal } from "../src/server/agents/repository";
import { processNextAgent } from "../src/server/agents/runtime";
import type { RunInput } from "../src/lib/agents/schema";

nextEnv.loadEnvConfig(process.cwd());
const args = process.argv.slice(2);
if (!args.includes("--live"))
  throw new Error(
    "Pass --live to authorize actual bounded NVIDIA calls on fictional fixtures. This command sends no email and uses no public collectors.",
  );
const testUrl = process.env.AERION_TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("Set AERION_TEST_DATABASE_URL to a migrated dedicated _test database.");
if (!process.env.NVIDIA_API_KEY?.trim())
  throw new Error("Configure NVIDIA_API_KEY server-side first.");
process.env.DATABASE_URL = testUrl;
const reportFlag = args.indexOf("--report");
const reportPath = resolve(
  reportFlag >= 0 ? args[reportFlag + 1] : `.aerion/reports/live-agents-${Date.now()}.json`,
);
const rolesFlag = args.indexOf("--roles");
const requested =
  rolesFlag >= 0
    ? args[rolesFlag + 1].split(",")
    : [
        "aircraft-intelligence",
        "buyer-requirements",
        "matching",
        "outreach",
        "communication",
        "due-diligence",
        "deal-coordination",
        "negotiation",
        "crm",
      ];
if (
  requested.some(
    (id) =>
      !agentIds.includes(id as AgentId) || ["aircraft-discovery", "buyer-discovery"].includes(id),
  )
)
  throw new Error(
    "Only retained-document roles are supported here. Discovery uses the existing separately retained public validation runs.",
  );
const leaseBrief = args.includes("--lease-brief");
if (leaseBrief && (requested.length !== 1 || requested[0] !== "buyer-requirements"))
  throw new Error("Use --lease-brief only with --roles buyer-requirements.");
const note =
  "Fictional live API acceptance fixture only. No actual buyer, mandate, offer, communication, verification or transaction is represented.";
const report: {
  checkedAt: string;
  database: string;
  actorId?: string;
  fixture?: unknown;
  results: unknown[];
  realMessagesSent: number;
  limitations: string[];
} = {
  checkedAt: new Date().toISOString(),
  database: new URL(testUrl).pathname.slice(1),
  results: [],
  realMessagesSent: 0,
  limitations: [
    note,
    "A successful bounded API/tool run is a capability acceptance check, not a business-outcome or domain-quality benchmark.",
  ],
};
async function save() {
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
}
async function main() {
  const scope = await workspaceFor(randomUUID());
  report.actorId = scope.actorId;
  const ids: Record<string, string> = {};
  async function retain(key: string, text: string) {
    ids[key] = (
      await source(scope, {
        title: `Fictional live acceptance: ${key}`,
        kind: "text",
        sourceUrl: null,
        filename: `${key}.txt`,
        contentType: "text/plain",
        original: Buffer.from(text),
        pages: [{ page: 1, text }],
      })
    ).id;
  }
  const future = calendarDate(new Date(Date.now() + 365 * 86400000));
  await retain(
    "aircraft",
    sampleSource
      .replace("LOCAL-EXAMPLE-01", `LIVE-FIXTURE-${randomUUID()}`)
      .replace(
        /AvailableDate: .*/,
        `AvailableDate: ${calendarDate(new Date(Date.now() + 90 * 86400000))}`,
      ),
  );
  await enqueueExtraction(scope, ids.aircraft, "local");
  await processNext(scope);
  const review = (await readPipeline(scope)).reviews.find((r) => r.sourceId === ids.aircraft);
  if (!review) throw new Error("Fixture aircraft extraction did not produce a review.");
  const aircraftId = (
    await decideReview(scope, review.id, { decision: "approve", note, attested: true })
  ).aircraftId;
  if (!aircraftId) throw new Error("Fixture approval did not publish an aircraft.");
  const requirementId = randomUUID(),
    contactId = randomUUID();
  let workspace = await readWorkspace(scope);
  workspace = await mutateWorkspace(
    scope,
    {
      type: "requirement",
      item: {
        id: requirementId,
        client: "Fictional Acceptance Buyer",
        aircraftModel: "Airbus A319",
        category: "Commercial",
        quantity: 1,
        minYear: 2010,
        engine: "CFM56",
        budget: 23000000,
        deadline: future,
        destination: "India",
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
        id: contactId,
        name: "Fictional Acquisitions Desk",
        company: "Fictional Acceptance Buyer",
        role: "Acquisitions",
        type: "Buyer",
        email: "live-agent-fixture@example.com",
        location: "India",
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
        contact: "Fictional Acquisitions Desk",
        confirmedOn: calendarDate(),
        basis: note,
      },
      attested: true,
    },
    0,
  );
  await mutateExecution(scope, requirementId, { type: "link-contact", contactId }, 1);
  await mutateExecution(
    scope,
    requirementId,
    { type: "shortlist", aircraftId, decision: "Shortlisted", reason: note },
    2,
  );
  workspace = await readWorkspace(scope);
  const aircraft = workspace.data.aircraft.find((a) => a.id === aircraftId);
  if (!aircraft) throw new Error("Approved fixture aircraft is unavailable.");
  await mutateWorkspace(
    scope,
    {
      type: "deal",
      item: {
        id: randomUUID(),
        title: "Fictional live acceptance opportunity",
        aircraftId,
        requirementId,
        stage: "Sourcing",
        nextAction: "Review engineering fixture evidence only",
        dueDate: calendarDate(),
        evidence: aircraft.evidence,
      },
    },
    workspace.revision,
  );
  await retain(
    "brief",
    `Client: Fictional New Acceptance Brief\nAircraft family: Airbus A319\nMarket: Commercial\nQuantity: 2\nMinimum year: 2012\nEngine: CFM56\n${leaseBrief ? "Transaction kind: Lease\nLease budget: 225000\nLease currency: EUR\nLease basis: Monthly rent" : "Budget USD: 25000000"}\nDelivery deadline: ${future}\nDestination: India\n${note}`,
  );
  await retain(
    "technical-a",
    `Aircraft serial: FICTIONAL-TECH\nEngine 2 LLP cycles remaining: 1200\nReport date: ${calendarDate()}\n${note}`,
  );
  await retain(
    "technical-b",
    `Aircraft serial: FICTIONAL-TECH\nEngine 2 LLP cycles remaining: 900\nReport date: ${calendarDate()}\n${note}`,
  );
  await retain(
    "message",
    `Contact email: live-agent-fixture@example.com\nOccurredOn: ${calendarDate()}\nDirection: Inbound\nSummary: Please reconfirm the current specification and availability.\n${note}`,
  );
  await retain(
    "comparable",
    `Manufacturer: Airbus\nModel: A319-112\nYear: 2014\nAmount USD: 20500000\nBasis: Asking price\nReportedOn: ${calendarDate()}\n${note}`,
  );
  await retain(
    "contact",
    `Name: Fictional New Contact\nRole: Acquisitions\nCompany: Fictional New Company\nEmail: new-live-fixture@example.com\nLocation: India\nContact type: Buyer\n${note}`,
  );
  const selections: Partial<Record<AgentId, string[]>> = {
    "buyer-requirements": [ids.brief],
    documents: [ids["technical-a"], ids["technical-b"]],
    "due-diligence": [ids["technical-a"], ids["technical-b"]],
    communication: [ids.message],
    negotiation: [ids.comparable],
    crm: [ids.contact],
  };
  report.fixture = {
    workspaceId: scope.workspaceId,
    aircraftId,
    requirementId,
    contactId,
    sourceIds: ids,
    briefKind: leaseBrief ? "Lease" : "Sale",
  };
  await save();
  for (const id of requested as AgentId[]) {
    const tasks: Partial<Record<AgentId, string>> = {
      "aircraft-intelligence":
        "Call aircraft_evidence for the selected aircraft. Produce a compact report of supported aircraft observations and missing technical records. Reuse exact source excerpts from workspace_context; founder-recorded case fields must not be presented as publisher quotes.",
      "buyer-requirements":
        "This is a NEW distinct buyer brief. Propose one new Draft requirement using every explicit required value in the selected brief; do not modify or reuse the unrelated existing confirmed requirement. Use exact source passages for the proposed values.",
      matching:
        "Call match_aircraft and report the actual eligibility checks for the selected confirmed requirement. Existing shortlist decisions can remain unchanged.",
      outreach:
        "Propose execution prepare-draft for the eligible shortlisted aircraft and linked Buyer contact. This creates only a private draft for engineering review.",
      communication:
        "Propose one interaction record from the selected retained inbound message: actual selected contactId, selected requirementId, sourceId, literal OccurredOn, Direction and Summary. Do not invent a message or send anything.",
      "due-diligence":
        "Read case_context and propose at least one execution add-action question to obtain a currently missing readiness document. Explain the recorded missing evidence and cite exact source excerpts only when describing document claims.",
      "deal-coordination":
        "A sourcing opportunity ALREADY EXISTS. Propose one execution add-action follow-up on the selected requirement for the next recorded deadline. Do not propose another deal. Use current workspace dates and attribute case facts as founder records.",
      negotiation:
        "Propose one comparable record from the selected explicit Asking price document: exact manufacturer, model, year, numeric amountUsd, basis, reportedOn and sourceId. Explain that it is a fictional asking observation, not a valuation or offer.",
      crm: "Propose the new factual contact from the selected retained contact source. Every name/company/email/role/location/type value must be literally cited. Do not invent relationship history.",
    };
    const input: RunInput = {
      agentId: id,
      provider: "nvidia",
      aircraftId: id === "buyer-requirements" ? null : aircraftId,
      requirementId: id === "buyer-requirements" ? null : requirementId,
      contactId: id === "buyer-requirements" ? null : contactId,
      sourceIds: selections[id] ?? [],
      connectorIds: [],
      objective: `${note} ${tasks[id] ?? "Inspect the selected retained documents."} Use exact literal source quotes; do not paraphrase quotes or invent source IDs. Keep the report compact and finish within the bounded run budget.`,
      allowExternalSources: false,
      allowModelData: true,
      allowMailbox: false,
      idempotencyKey: randomUUID(),
    };
    const queued = await enqueueAgent(scope, input);
    console.log(JSON.stringify({ event: "started", agentId: id, runId: queued.id }));
    await processNextAgent(scope);
    let run = await readAgentRun(scope, queued.id);
    const proposed = run.proposals.filter((p) => p.status === "proposed");
    const applied: string[] = [],
      acceptanceErrors: string[] = [];
    for (const proposal of proposed) {
      try {
        if (leaseBrief && proposal.action.type === "requirement") {
          const terms = proposal.action.values;
          if (
            terms.transactionKind !== "Lease" ||
            terms.budget !== null ||
            terms.leaseBudget !== 225000 ||
            terms.leaseCurrency !== "EUR" ||
            terms.leaseBasis !== "Monthly rent"
          )
            throw new Error(
              "Lease acceptance needs the exact EUR 225000 monthly ceiling and a null purchase budget. No proposal was applied.",
            );
        }
        await decideProposal(scope, proposal.id, {
          decision: "accept",
          revision: run.revision,
          note,
          attested: true,
        });
        applied.push(proposal.id);
        run = await readAgentRun(scope, queued.id);
      } catch (e) {
        acceptanceErrors.push(e instanceof Error ? e.message : "Proposal acceptance failed");
      }
    }
    const acceptedActions = run.proposals
      .filter((p) => p.status === "accepted")
      .map((p) =>
        p.action.type === "execution" ? `execution.${p.action.action.type}` : p.action.type,
      );
    const expected: Partial<Record<AgentId, string>> = {
      "buyer-requirements": "requirement",
      outreach: "execution.prepare-draft",
      communication: "interaction",
      "due-diligence": "execution.add-action",
      "deal-coordination": "execution.add-action",
      negotiation: "comparable",
      crm: "contact",
    };
    const requiredTool =
      id === "aircraft-intelligence"
        ? "aircraft_evidence"
        : id === "matching"
          ? "match_aircraft"
          : null;
    const acceptancePassed = Boolean(
      run.report &&
        !run.error &&
        !acceptanceErrors.length &&
        (!expected[id] || acceptedActions.includes(expected[id] ?? "")) &&
        (!requiredTool || run.steps.some((step) => step.tool === requiredTool)),
    );
    const result = {
      agentId: id,
      runId: run.id,
      provider: run.provider,
      model: run.model,
      status: run.status,
      error: run.error,
      usage: run.usage,
      steps: run.steps.map((s) => s.tool),
      proposals: proposed.length,
      applied: applied.length,
      acceptedActions,
      expectedAction: expected[id] ?? null,
      acceptancePassed,
      acceptanceErrors,
      summary: run.report?.summary,
      evidencePassed: Boolean(run.report && !run.error),
      finishedAt: run.finishedAt,
    };
    report.results.push(result);
    if (!acceptancePassed) process.exitCode = 1;
    await save();
    console.log(JSON.stringify({ event: "finished", ...result }));
    // No delivery worker is invoked. Queue-only extraction proposals are handled locally.
    while (await processNext(scope)) {
      /* Explicit fixture extraction jobs only. */
    }
  }
  const desk = await readExecution(scope, requirementId);
  console.log(
    JSON.stringify({
      event: "report",
      path: reportPath,
      sha256: createHash("sha256").update(JSON.stringify(report)).digest("hex"),
      fixtureDrafts: desk.drafts.length,
    }),
  );
}
try {
  await main();
} finally {
  await save();
  await pool().end();
}
