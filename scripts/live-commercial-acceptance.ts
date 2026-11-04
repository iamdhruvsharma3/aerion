import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import nextEnv from "@next/env";
import type { AgentRunDetail, RunInput } from "../src/lib/agents/schema";
import { demoAircraft } from "../src/lib/demo-data";
import { calendarDate } from "../src/lib/format";
import type { RevenueAction } from "../src/lib/revenue/schema";
import {
  type MilestoneKey,
  milestoneKeys,
  type TransactionAction,
} from "../src/lib/transactions/schema";
import { emptyWorkspace } from "../src/lib/workspace";
import type { CommercialContext } from "../src/server/agents/commercial-context";
import { enqueueAgent, readAgentRun } from "../src/server/agents/repository";
import { processNextAgent } from "../src/server/agents/runtime";
import { pool, workspaceFor } from "../src/server/db";
import { mutateExecution } from "../src/server/execution";
import { createSource, mutateWorkspace, readWorkspace } from "../src/server/repository";
import {
  createEngagement,
  mutateRevenue,
  readRevenueDetail,
} from "../src/server/revenue/repository";
import { mutateTransaction, readTransaction } from "../src/server/transactions/workflow";

nextEnv.loadEnvConfig(process.cwd());
const args = process.argv.slice(2);
const permittedRoles = ["due-diligence", "deal-coordination"] as const;
type CommercialRole = (typeof permittedRoles)[number];
const roleFlags = args.flatMap((arg, index) =>
  arg === "--roles" || arg.startsWith("--roles=") ? [{ arg, index }] : [],
);
if (roleFlags.length > 1)
  throw new Error(
    "Pass --roles only once with a unique comma-separated subset of due-diligence,deal-coordination.",
  );
const roleFlag = roleFlags[0];
const roleValue = roleFlag
  ? roleFlag.arg === "--roles"
    ? args[roleFlag.index + 1]
    : roleFlag.arg.slice("--roles=".length)
  : null;
if (roleFlag && (roleValue === null || roleValue === undefined || roleValue.startsWith("--")))
  throw new Error(
    "--roles needs a nonempty comma-separated subset of due-diligence,deal-coordination.",
  );
const requestedRoles =
  roleValue === null ? [...permittedRoles] : roleValue.split(",").map((role) => role.trim());
if (
  !requestedRoles.length ||
  requestedRoles.some((role) => !permittedRoles.includes(role as CommercialRole)) ||
  new Set(requestedRoles).size !== requestedRoles.length
)
  throw new Error(
    "--roles permits only a nonempty unique subset of due-diligence,deal-coordination; unknown, empty or duplicate roles are rejected.",
  );
const selectedRoles = requestedRoles as CommercialRole[];
if (!args.includes("--live"))
  throw new Error(
    `Pass --live to authorize bounded NVIDIA runs for the selected roles (${selectedRoles.join(",")}) on a new fictional test workspace. No email, collectors, schedules or proposal approvals are invoked.`,
  );
const testUrl = process.env.AERION_TEST_DATABASE_URL;
if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
  throw new Error("Set AERION_TEST_DATABASE_URL to a migrated dedicated *_test database.");
if (!process.env.NVIDIA_API_KEY?.trim())
  throw new Error("Configure NVIDIA_API_KEY server-side first; never pass it as a CLI argument.");
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
  throw new Error("TLS certificate verification must remain enabled.");
process.env.DATABASE_URL = testUrl;
const reportFlag = args.indexOf("--report");
if (reportFlag >= 0 && !args[reportFlag + 1]) throw new Error("--report needs a file path.");
const reportPath = resolve(
  reportFlag >= 0 ? args[reportFlag + 1] : ".aerion/reports/live-commercial-acceptance.json",
);
const note =
  "Fictional commercial-context live acceptance fixture only. No actual buyer, aircraft, mandate, offer, legal/technical verification, transaction, invoice, payment or commission is represented.";
const report: {
  checkedAt: string;
  database: string;
  selectedRoles: CommercialRole[];
  actorId?: string;
  fixture?: Record<string, unknown>;
  runs: unknown[];
  errors: string[];
  realMessagesSent: number;
  proposalsAccepted: number;
  limitations: string[];
} = {
  checkedAt: new Date().toISOString(),
  database: new URL(testUrl).pathname.slice(1),
  selectedRoles,
  runs: [],
  errors: [],
  realMessagesSent: 0,
  proposalsAccepted: 0,
  limitations: [
    note,
    "One live run per selected role with existing six-request, thirty-business-tool, three-minute runtime limits; no retry or provider fallback.",
    "Literal output checks support review of the retained trace and prose; they are not a domain-quality or business-outcome certification.",
    "Fixtures and unaccepted proposals are retained in the isolated test workspace for inspection.",
  ],
};
async function save() {
  await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
  await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
}
const object = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
function truncated(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(truncated);
  return (
    object(value) &&
    ((typeof value.truncated === "number" && value.truncated > 0) ||
      value.truncated === true ||
      Object.values(value).some(truncated))
  );
}
async function main() {
  const migrations = (await readdir("db/migrations"))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const applied = (await pool().query("select name,sha256 from public.aerion_migrations")).rows as {
    name: string;
    sha256: string;
  }[];
  for (const name of migrations) {
    const expected = createHash("sha256")
      .update(await readFile(`db/migrations/${name}`))
      .digest("hex");
    if (applied.find((item) => item.name === name)?.sha256 !== expected)
      throw new Error(`Dedicated test database needs its unchanged applied migration: ${name}`);
  }
  const scope = await workspaceFor(randomUUID()),
    today = calendarDate(),
    future = calendarDate(new Date(Date.now() + 90 * 86400000));
  report.actorId = scope.actorId;
  const requirementId = randomUUID(),
    buyerId = randomUUID(),
    sellerId = randomUUID(),
    completedId = randomUUID(),
    activeId = randomUUID();
  const aircraft = ["COMPLETED", "ACTIVE"].map((suffix) => ({
    ...demoAircraft[0],
    id: randomUUID(),
    serial: `FICTIONAL-${suffix}-${randomUUID()}`,
    registration: `FICTIONAL-${suffix}`,
    model: "A319-112",
    year: 2015,
    engine: "CFM56-5B",
    price: 21000000,
    availableDate: today,
    sourceDate: today,
    source: "Fictional acceptance fixture",
    notes: note,
  }));
  const staleNextAction = `SOURCE_COMPLETED_SERIAL: source ${aircraft[0].serial} again as a new sourcing task`;
  await mutateWorkspace(
    scope,
    {
      type: "migrate",
      workspace: {
        ...emptyWorkspace,
        aircraft,
        requirements: [
          {
            id: requirementId,
            client: "Fictional Commercial Acceptance Buyer",
            aircraftModel: "Airbus A319",
            category: "Commercial",
            quantity: 2,
            minYear: 2010,
            engine: "CFM56",
            budget: 23000000,
            deadline: future,
            destination: "India",
            status: "Draft",
            description: note,
          },
        ],
        contacts: [
          {
            id: buyerId,
            name: "Fictional Buyer Desk",
            company: "Fictional Commercial Acceptance Buyer",
            role: "Fictional acquisitions",
            email: "commercial-buyer-fixture@example.com",
            location: "India",
            type: "Buyer",
            notes: note,
          },
          {
            id: sellerId,
            name: "Fictional Seller Desk",
            company: "Fictional Commercial Acceptance Seller",
            role: "Fictional seller",
            email: "commercial-seller-fixture@example.com",
            location: "France",
            type: "Seller",
            notes: note,
          },
        ],
      },
    },
    0,
  );
  await mutateExecution(
    scope,
    requirementId,
    {
      type: "confirm-brief",
      confirmation: {
        contact: "Fictional Buyer Desk",
        confirmedOn: today,
        basis: `${note} The fictional buyer confirms a current two-aircraft A319 requirement; each saved serial is a separate opportunity.`,
      },
      attested: true,
    },
    0,
  );
  await mutateExecution(scope, requirementId, { type: "link-contact", contactId: buyerId }, 1);
  for (const [index, dealId] of [completedId, activeId].entries()) {
    const workspace = await readWorkspace(scope);
    await mutateWorkspace(
      scope,
      {
        type: "deal",
        item: {
          id: dealId,
          title: `Fictional ${index ? "active" : "completed"} serial ${aircraft[index].serial}`,
          aircraftId: aircraft[index].id,
          requirementId,
          stage: "Sourcing",
          nextAction: index
            ? "Review the expiring fictional offer and blocking title finding"
            : staleNextAction,
          dueDate: today,
        },
      },
      workspace.revision,
    );
  }
  const sources: Record<string, string> = {};
  async function retain(key: string, facts: string) {
    const text = `${note}\n${facts}`;
    const id = (
      await createSource(scope, {
        title: `Fictional commercial acceptance: ${key}`,
        kind: "text",
        sourceUrl: null,
        filename: `${key}.txt`,
        contentType: "text/plain",
        original: Buffer.from(text),
        pages: [{ page: 1, text }],
      })
    ).id;
    sources[key] = id;
    return id;
  }
  async function change(dealId: string, action: TransactionAction) {
    return mutateTransaction(
      scope,
      dealId,
      (await readTransaction(scope, dealId)).revision,
      randomUUID(),
      action,
    );
  }
  async function evidence(dealId: string, key: MilestoneKey) {
    const serial = dealId === completedId ? aircraft[0].serial : aircraft[1].serial;
    const sourceId = await retain(
      `${dealId}-${key}`,
      `Serial: ${serial}\nOpportunity: ${dealId}\nMilestone: ${key}\nEvent date: ${today}\nFictional named service reviewer records this milestone as supported for this one serial. Delivery acceptance for the completed opportunity acknowledges delivery and settlement of the fictional purchase; the separate fixed fee is 1000.00 USD.`,
    );
    await change(dealId, {
      kind: "evidence",
      key,
      sourceId,
      occurredOn: today,
      party: "Fictional Independent Review Service",
      detail: `${note} ${key} for ${serial}.`,
      note,
      attested: true,
    });
    const current = (await readTransaction(scope, dealId)).evidence.find(
      (item) => item.current && item.key === key,
    );
    if (!current) throw new Error(`Missing retained ${key}`);
    for (const state of ["Reviewed", "Verification recorded"] as const)
      await change(dealId, {
        kind: "evidence-decision",
        evidenceId: current.id,
        state,
        recordedBy: "Fictional Named Reviewer",
        occurredOn: today,
        note,
        attested: true,
      });
    return sourceId;
  }
  async function transition(
    status: "Offer" | "LOI" | "Agreement" | "Inspection" | "Closing" | "Completed",
    sourceId: string | null = null,
  ) {
    await change(completedId, {
      kind: "transition",
      status,
      sourceId,
      occurredOn: today,
      note,
      attested: true,
    });
  }
  for (const [index, dealId] of [completedId, activeId].entries()) {
    await change(dealId, {
      kind: "configure",
      transactionKind: "Sale",
      nextAction: index
        ? "Resolve the blocking title finding and reconfirm the offer expiring today"
        : staleNextAction,
      dueOn: today,
      note,
    });
    const sourceId = await retain(
      `${dealId}-offer`,
      `Fictional buyer offer for one serial ${aircraft[index].serial}: 21000000.00 USD purchase price per aircraft. Offered ${today}; ${index ? `expires ${today}` : "no expiry recorded"}. Opportunity ${dealId}.`,
    );
    await change(dealId, {
      kind: "offer",
      side: "Buyer",
      contactId: buyerId,
      offerKind: "Offer",
      parentId: null,
      amount: "21000000.00",
      currency: "USD",
      basis: "Purchase price",
      quantity: 1,
      offeredOn: today,
      expiresOn: index ? today : null,
      terms: `${note} One specified serial, USD purchase price; separate fixed sourcing fee.`,
      sourceId,
      note,
      attested: true,
    });
    if (!index) {
      const offer = (await readTransaction(scope, dealId)).offers[0];
      const acceptance = await retain(
        "completed-offer-acceptance",
        `Fictional seller accepts buyer offer ${offer.id} on ${today} for serial ${aircraft[0].serial}, 21000000.00 USD.`,
      );
      await change(dealId, {
        kind: "offer-decision",
        offerId: offer.id,
        decision: "Accepted",
        sourceId: acceptance,
        decidedOn: today,
        recordedBy: "Fictional Seller Desk",
        note,
        attested: true,
      });
    }
    await evidence(dealId, "Representation");
    await evidence(dealId, "Availability");
    await change(dealId, {
      kind: "transition",
      status: "Offer",
      sourceId: null,
      occurredOn: today,
      note,
      attested: true,
    });
  }
  await evidence(completedId, "Letter of intent");
  await transition("LOI");
  await evidence(completedId, "Executed agreement");
  await transition("Agreement");
  await evidence(completedId, "Technical records");
  await transition("Inspection");
  await evidence(completedId, "Pre-purchase inspection");
  await evidence(completedId, "Title");
  await transition("Closing");
  await evidence(completedId, "Settlement");
  const completionSourceId = await evidence(completedId, "Delivery acceptance");
  await transition("Completed", completionSourceId);
  const titleSource = await retain(
    "active-title-finding",
    `Serial: ${aircraft[1].serial}\nOpportunity: ${activeId}\nFictional title review has an unresolved recorded lien release; this is a Blocking title finding, still Open on ${today}. No closing or delivery verification is recorded for this active serial.`,
  );
  await change(activeId, {
    kind: "finding",
    category: "Title",
    severity: "Blocking",
    title: "Fictional unresolved lien release blocks closing",
    detail: `${note} A recorded lien release is missing for ${aircraft[1].serial}; obtain a named title review and retain resolution evidence before closing.`,
    sourceId: titleSource,
    dueOn: today,
    note,
    attested: true,
  });
  const signedSourceId = await retain(
    "fee-agreement",
    `Fictional Buyer Desk engages the founder for opportunity ${completedId}, serial ${aircraft[0].serial}. Fixed fee 1000.00 USD earned at current verified delivery acceptance. Signed by Fictional Buyer Desk on ${today}; due on invoice. No fee is payable for the separate active opportunity under this agreement.`,
  );
  let revenue = await createEngagement(scope, {
    idempotencyKey: randomUUID(),
    terms: {
      title: "Fictional completed-serial closing fee",
      clientContactId: buyerId,
      payerContactId: buyerId,
      representation: "Buyer sourcing",
      requirementId,
      dealId: completedId,
      scope: `${note} Fixed service fee for the completed serial only.`,
      startsOn: today,
      endsOn: null,
      currency: "USD",
      feeType: "Fixed",
      fixedAmount: "1000.00",
      percentage: null,
      estimateBasis: null,
      basisDescription: "Fixed fictional service fee for one completed serial",
      earningTrigger: "Closing",
      earningTerms:
        "Fictional 1000.00 USD is earned at this opportunity's verified delivery acceptance.",
      paymentTerms: "Fictional fee due on invoice; no real money is requested.",
      signedSourceId,
      signatory: "Fictional Buyer Desk",
      signedOn: today,
    },
  });
  async function revenueChange(action: RevenueAction) {
    revenue = await mutateRevenue(scope, revenue.engagement.id, {
      revision: revenue.engagement.revision,
      idempotencyKey: randomUUID(),
      action,
    });
  }
  await revenueChange({ kind: "activate", note, attested: true });
  await revenueChange({
    kind: "earn",
    earnedOn: today,
    basisAmount: null,
    sourceId: completionSourceId,
    note,
    attested: true,
  });
  await revenueChange({
    kind: "invoice",
    earningId: revenue.earnings[0].id,
    amount: "1000.00",
    taxAmount: "0",
    taxLabel: "",
    issuedOn: today,
    dueOn: today,
    issuerName: "Fictional Founder Services",
    issuerEmail: "fictional-founder@example.com",
    issuerAddress: "Fictional acceptance-only address",
    issuerRegistration: "FICTIONAL-ONLY",
    billToAddress: "Fictional Buyer address for engineering validation",
    description: "Fictional completed-serial fixed sourcing fee",
    paymentInstructions: "Fictional fixture only. Do not send or transfer any money.",
    note,
    attested: true,
  });
  const paymentSourceId = await retain(
    "partial-payment",
    `Fictional transfer BANK-COMMERCIAL-FIXTURE-400 on ${today}: payer Fictional Buyer Desk, currency USD, actual fictional total 400.00 USD, allocated to invoice ${revenue.invoices[0].number}. Invoice total 1000.00 USD; remaining balance 600.00 USD. This invoice is partially paid, not paid in full.`,
  );
  await revenueChange({
    kind: "receipt",
    invoiceId: revenue.invoices[0].id,
    amount: "400.00",
    paymentTotal: "400.00",
    receivedOn: today,
    reference: "BANK-COMMERCIAL-FIXTURE-400",
    sourceId: paymentSourceId,
    note,
    attested: true,
  });
  revenue = await readRevenueDetail(scope, revenue.engagement.id);
  const invoice = revenue.invoices[0],
    completed = await readTransaction(scope, completedId),
    active = await readTransaction(scope, activeId);
  if (
    completed.status !== "Completed" ||
    completed.evidence.filter((item) => item.current && item.state === "Verification recorded")
      .length !== milestoneKeys.length ||
    active.status !== "Offer" ||
    invoice.outstandingMinor !== "60000" ||
    invoice.receivedMinor !== "40000"
  )
    throw new Error("Fictional fixture did not reach its required business states.");
  report.fixture = {
    workspaceId: scope.workspaceId,
    requirementId,
    buyerId,
    sellerId,
    completedDealId: completedId,
    activeDealId: activeId,
    completedSerial: aircraft[0].serial,
    activeSerial: aircraft[1].serial,
    sourceIds: sources,
    engagementId: revenue.engagement.id,
    invoiceId: invoice.id,
    invoiceNumber: invoice.number,
    invoiceCurrency: invoice.currency,
    invoiceTotalMinor: invoice.totalMinor,
    invoiceReceivedMinor: invoice.receivedMinor,
    invoiceOutstandingMinor: invoice.outstandingMinor,
    completedNextAction: staleNextAction,
    offerExpiresOn: today,
  };
  await save();
  console.log(
    JSON.stringify({
      event: "fixture-ready",
      workspaceId: scope.workspaceId,
      requirementId,
      completedDealId: completedId,
      activeDealId: activeId,
      invoiceId: invoice.id,
      reportPath,
    }),
  );
  for (const agentId of selectedRoles) {
    const input: RunInput = {
      agentId,
      provider: "nvidia",
      requirementId,
      aircraftId: null,
      contactId: buyerId,
      sourceIds: [],
      connectorIds: [],
      objective: `${note} Inspect case_context for this confirmed requirement across both serial-specific opportunities. Use authoritative commercial transaction status, current offers, findings, reviewed milestones and recorded fee/invoice balances. Give a compact founder-recorded status report and only appropriate next-step questions or private follow-up proposals, if warranted. Reconcile the older Deal nextAction with authoritative lifecycle state. No email, offers, funds, legal certification or automatic approvals. Read actual records rather than infer status from legacy stage. Keep all proposals pending for founder review and finish within the bounded run budget.`,
      allowExternalSources: false,
      allowModelData: true,
      allowMailbox: false,
      idempotencyKey: randomUUID(),
    };
    const queued = await enqueueAgent(scope, input),
      started = Date.now();
    report.runs.push({ agentId, runId: queued.id, status: "queued" });
    await save();
    console.log(
      JSON.stringify({
        event: "started",
        agentId,
        runId: queued.id,
        workspaceId: scope.workspaceId,
      }),
    );
    await processNextAgent(scope);
    const run: AgentRunDetail = await readAgentRun(scope, queued.id);
    const contexts = run.steps.filter(
      (step) =>
        step.tool === "case_context" && object(step.output) && object(step.output.commercial),
    );
    const commercial = contexts.map(
      (step) => (step.output as { commercial: CommercialContext }).commercial,
    );
    const contextTruncated = contexts.some((step) => truncated(step.output));
    const text = JSON.stringify({ report: run.report, proposals: run.proposals }).toLowerCase();
    const proposalSuspicions = run.proposals
      .filter((proposal) => {
        const value = JSON.stringify(proposal).toLowerCase();
        return (
          value.includes("source_completed_serial") ||
          ((value.includes(aircraft[0].serial.toLowerCase()) || value.includes(completedId)) &&
            /\b(?:sourcing|source again|shortlist|reconfirm availability)\b/.test(value))
        );
      })
      .map((proposal) => proposal.id);
    const paidClaimSuspicions = (
      run.report
        ? [
            run.report.summary,
            ...run.report.findings.map((finding) => `${finding.title}. ${finding.detail}`),
          ]
        : []
    ).filter(
      (value) =>
        /(?:invoice|fee|commission).{0,100}\b(?:fully paid|paid in full|zero balance|fully settled)\b/i.test(
          value,
        ) && !/\b(?:not|never|isn't|is not|no evidence)\b/i.test(value),
    );
    const checks = {
      runSucceeded: Boolean(
        run.report && !run.error && ["review", "completed", "needs-input"].includes(run.status),
      ),
      actualCaseContextRead: contexts.length > 0,
      contextComplete: contexts.length > 0 && !contextTruncated,
      authoritativeCompletedAndActive: commercial.some(
        (item) =>
          item.transactions.some(
            (txn) =>
              txn.dealId === completedId && txn.status === "Completed" && !txn.contextChanged,
          ) &&
          item.transactions.some(
            (txn) => txn.dealId === activeId && txn.status === "Offer" && !txn.contextChanged,
          ),
      ),
      contextContainsOpenBlockingTitle: commercial.some((item) =>
        item.transactions.some(
          (txn) =>
            txn.dealId === activeId &&
            txn.findings.some(
              (finding) =>
                finding.category === "Title" &&
                finding.severity === "Blocking" &&
                finding.status === "Open",
            ),
        ),
      ),
      contextContainsCurrentOfferExpiry: commercial.some((item) =>
        item.transactions.some(
          (txn) =>
            txn.dealId === activeId &&
            txn.offers.some(
              (offer) =>
                offer.expiresOn === today && offer.quantity === 1 && offer.status === "Recorded",
            ),
        ),
      ),
      contextContains600UsdBalance: commercial.some((item) =>
        item.engagements.some(
          (engagement) =>
            engagement.id === revenue.engagement.id &&
            engagement.invoices.some(
              (record) =>
                record.id === invoice.id &&
                record.currency === "USD" &&
                record.totalMinor === "100000" &&
                record.receivedMinor === "40000" &&
                record.outstandingMinor === "60000",
            ),
        ),
      ),
      reportIdentifiesTitleBlock:
        /\btitle\b/.test(text) && /\b(?:blocking|blocked|lien)\b/.test(text),
      reportIdentifiesExpiringOffer: /\b(?:offer|expiry)\b/.test(text) && /expir/.test(text),
      reportIdentifies600Balance:
        /\b600(?:\.00)?\b/.test(text) && /\b(?:outstanding|balance|remaining|unpaid)\b/.test(text),
      completedSourcingNotReproposed: proposalSuspicions.length === 0,
      invoiceNotClaimedFullyPaid:
        paidClaimSuspicions.length === 0 &&
        /\b(?:partial|partially|outstanding|remaining|unpaid)\b/.test(text),
      proposalsRemainUnaccepted: run.proposals.every(
        (proposal) => proposal.status === "proposed" && proposal.appliedRef === null,
      ),
      boundedActualUsage: Boolean(
        run.usage &&
          run.attempts === 1 &&
          run.usage.requests >= 1 &&
          run.usage.requests <= 6 &&
          run.steps.filter((step) => step.tool !== "finish_report").length <= 30 &&
          Date.now() - started < 185000,
      ),
    };
    const result = {
      agentId,
      runId: run.id,
      provider: run.provider,
      model: run.model,
      status: run.status,
      error: run.error,
      attempts: run.attempts,
      usage: run.usage,
      elapsedMs: Date.now() - started,
      checks,
      outcome: contextTruncated
        ? "inconclusive"
        : Object.values(checks).every(Boolean)
          ? "passed"
          : "failed",
      contextTruncated,
      proposalSuspicions,
      paidClaimSuspicions,
      report: run.report,
      proposals: run.proposals,
      trace: run.steps,
      finishedAt: run.finishedAt,
    };
    if (result.outcome !== "passed") process.exitCode = 1;
    report.runs[report.runs.length - 1] = result;
    await save();
    console.log(
      JSON.stringify({
        event: "finished",
        agentId,
        runId: run.id,
        status: run.status,
        outcome: result.outcome,
        usage: run.usage,
        failedChecks: Object.entries(checks)
          .filter(([, passed]) => !passed)
          .map(([key]) => key),
        reportPath,
      }),
    );
  }
}
try {
  await main();
} catch (error) {
  report.errors.push(error instanceof Error ? error.message : "Commercial live acceptance failed.");
  process.exitCode = 1;
} finally {
  await save();
  await pool().end();
  console.log(
    JSON.stringify({
      event: "report",
      path: reportPath,
      sha256: createHash("sha256")
        .update(await readFile(reportPath))
        .digest("hex"),
      realMessagesSent: 0,
      proposalsAccepted: 0,
    }),
  );
}
