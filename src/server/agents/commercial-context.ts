import type { PoolClient } from "pg";
import { calendarDate } from "../../lib/format";
import { workspaceSchema, type Deal } from "../../lib/schema";
import { engagementTermsSchema, type EngagementTerms } from "../../lib/revenue/schema";
import type {
  TransactionStage,
  TransactionOffer,
  TransactionFinding,
  TransactionEvidence,
} from "../../lib/transactions/schema";
import { transaction, type Scope } from "../db";
import { HttpError } from "../http";
import { requirementNeedsRequalification } from "../communication/context";
import { readTransactionCompletion } from "../transactions/workflow";

export type ContextCoverage = { total: number; shown: number; truncated: number };
export type CommercialTransaction = {
  dealId: string;
  title: string;
  aircraftId: string;
  requirementId: string;
  managed: boolean;
  legacyStage: Deal["stage"];
  status: TransactionStage | null;
  cycle: number | null;
  revision: number | null;
  transactionKind: "Sale" | "Lease" | null;
  contextChanged: boolean;
  supersededRequirement: boolean;
  nextAction: string;
  dueOn: string | null;
  completedOn: string | null;
  completionSourceId: string | null;
  offers: Pick<
    TransactionOffer,
    | "id"
    | "side"
    | "contactId"
    | "offerKind"
    | "parentId"
    | "amount"
    | "currency"
    | "basis"
    | "quantity"
    | "offeredOn"
    | "expiresOn"
    | "terms"
    | "sourceId"
    | "status"
    | "decisionSourceId"
    | "decidedOn"
    | "recordedBy"
  >[];
  milestones: (Pick<
    TransactionEvidence,
    "key" | "sourceId" | "occurredOn" | "party" | "detail" | "state" | "reviewer" | "reviewedOn"
  > & { evidenceId: string })[];
  findings: Pick<
    TransactionFinding,
    "id" | "category" | "severity" | "title" | "detail" | "sourceId" | "dueOn" | "status"
  >[];
  coverage: { offers: ContextCoverage; milestones: ContextCoverage; findings: ContextCoverage };
};
export type CommercialEngagement = {
  id: string;
  revision: number;
  status: "Draft" | "Active" | "Ended";
  effectiveStatus: "Draft" | "Active" | "Ended" | "Upcoming" | "Expired";
  dealId: string;
  requirementId: string | null;
  title: string;
  representation: EngagementTerms["representation"];
  scope: string;
  startsOn: string;
  endsOn: string | null;
  currency: EngagementTerms["currency"];
  feeType: EngagementTerms["feeType"];
  fixedAmount: string | null;
  percentage: string | null;
  basisDescription: string;
  earningTrigger: EngagementTerms["earningTrigger"];
  earningTerms: string;
  paymentTerms: string;
  signedSourceId: string | null;
  signedOn: string | null;
  signatory: string;
  endedOn: string | null;
  endedSourceId: string | null;
  totals: {
    earnedMinor: string;
    invoicedMinor: string;
    invoiceTotalMinor: string;
    receivedMinor: string;
    outstandingMinor: string;
  };
  earnings: {
    id: string;
    earnedOn: string;
    amountMinor: string;
    sourceId: string;
    status: "Recorded" | "Voided";
    voidSourceId: string | null;
  }[];
  invoices: {
    id: string;
    number: string;
    status: "Issued" | "Voided";
    currency: string;
    issuedOn: string;
    dueOn: string;
    totalMinor: string;
    receivedMinor: string;
    outstandingMinor: string;
  }[];
  coverage: { earnings: ContextCoverage; invoices: ContextCoverage };
};
export type CommercialContext = {
  transactions: CommercialTransaction[];
  engagements: CommercialEngagement[];
  sourceIds: string[];
  revisionState: {
    requirementId: string;
    aircraftId: string | null;
    requalificationRequired: boolean;
    transactions: {
      dealId: string;
      aircraftId: string;
      revision: number | null;
      cycle: number | null;
      status: TransactionStage | null;
      legacyStage: Deal["stage"];
      nextAction: string;
      dueOn: string;
    }[];
    engagements: { id: string; revision: number; dealId: string }[];
  };
  coverage: { transactions: ContextCoverage; engagements: ContextCoverage };
};

const limits = {
  transactions: 10,
  engagements: 10,
  offers: 5,
  findings: 5,
  earnings: 3,
  invoices: 10,
};
const coverage = (total: number, shown: number): ContextCoverage => ({
  total,
  shown,
  truncated: Math.max(0, total - shown),
});
const emptyCoverage = () => coverage(0, 0);
const bounded = (value: string, length = 400) =>
  value.length > length ? `${value.slice(0, length)}…` : value;

async function commercialBase(
  db: PoolClient,
  scope: Scope,
  requirementId: string,
  aircraftId?: string | null,
) {
  const workspace = (
    await db.query("select data from aerion.workspaces where id=$1", [scope.workspaceId])
  ).rows[0];
  if (!workspace) throw new HttpError(404, "Workspace not found.");
  const data = workspaceSchema.parse(workspace.data);
  if (!data.requirements.some((item) => item.id === requirementId))
    throw new HttpError(404, "Requirement not found in this workspace.");
  if (aircraftId && !data.aircraft.some((item) => item.id === aircraftId))
    throw new HttpError(404, "Aircraft not found in this workspace.");
  const deals = data.deals.filter(
    (deal) =>
      deal.requirementId === requirementId && (!aircraftId || deal.aircraftId === aircraftId),
  );
  const dealIds = deals.map((deal) => deal.id);
  const rows = (
    await db.query(
      `select deal_id as "dealId",revision,cycle,status,transaction_kind as "transactionKind",next_action as "nextAction",to_char(due_on,'YYYY-MM-DD') as "dueOn" from aerion.transaction_cases where workspace_id=$1 and deal_id=any($2::text[])`,
      [scope.workspaceId, dealIds],
    )
  ).rows as {
    dealId: string;
    revision: number;
    cycle: number;
    status: TransactionStage;
    transactionKind: "Sale" | "Lease";
    nextAction: string;
    dueOn: string | null;
  }[];
  const requalificationRequired = await requirementNeedsRequalification(db, scope, requirementId);
  const engagementVersions = (
    await db.query(
      `select id,revision,terms->>'dealId' as "dealId" from aerion.revenue_engagements where workspace_id=$1 and terms->>'dealId'=any($2::text[]) and (terms->>'requirementId' is null or terms->>'requirementId'=$3) order by (status='Active') desc,created_at desc,id desc`,
      [scope.workspaceId, dealIds, requirementId],
    )
  ).rows as CommercialContext["revisionState"]["engagements"];
  const orderedDeals = [...deals].sort((a, b) => a.id.localeCompare(b.id));
  const revisionState: CommercialContext["revisionState"] = {
    requirementId,
    aircraftId: aircraftId ?? null,
    requalificationRequired,
    transactions: orderedDeals.map((deal) => {
      const row = rows.find((item) => item.dealId === deal.id);
      return {
        dealId: deal.id,
        aircraftId: deal.aircraftId,
        revision: row?.revision ?? null,
        cycle: row?.cycle ?? null,
        status: row?.status ?? null,
        legacyStage: deal.stage,
        nextAction: deal.nextAction,
        dueOn: deal.dueDate,
      };
    }),
    engagements: engagementVersions,
  };
  return { deals: orderedDeals, rows, engagementVersions, requalificationRequired, revisionState };
}

/** Same ownership/scoping and complete revision set as the detailed context, without evidence/accounting reads. */
export async function commercialRevisionStateInTransaction(
  db: PoolClient,
  scope: Scope,
  requirementId: string,
  aircraftId?: string | null,
): Promise<CommercialContext["revisionState"]> {
  return (await commercialBase(db, scope, requirementId, aircraftId)).revisionState;
}

/** Read-only commercial records for this exact requirement/optional aircraft; no parties or invoice payment instructions. */
export async function commercialContextInTransaction(
  db: PoolClient,
  scope: Scope,
  requirementId: string,
  aircraftId?: string | null,
): Promise<CommercialContext> {
  const { deals, rows, engagementVersions, requalificationRequired, revisionState } =
    await commercialBase(db, scope, requirementId, aircraftId);
  const sourceIds = new Set<string>();
  const retain = (id: string | null | undefined) => {
    if (id) sourceIds.add(id);
  };
  const transactions: CommercialTransaction[] = [];
  // Stable bounded order; retained legacy opportunities stay distinguishable from managed cases.
  for (const deal of deals.slice(0, limits.transactions)) {
    const row = rows.find((item) => item.dealId === deal.id);
    const completion = row ? await readTransactionCompletion(db, scope, deal.id) : null;
    const item: CommercialTransaction = {
      dealId: deal.id,
      title: deal.title,
      aircraftId: deal.aircraftId,
      requirementId,
      managed: Boolean(row),
      legacyStage: deal.stage,
      status: row?.status ?? null,
      cycle: row?.cycle ?? null,
      revision: row?.revision ?? null,
      transactionKind: row?.transactionKind ?? null,
      contextChanged: completion?.contextChanged ?? requalificationRequired,
      supersededRequirement: requalificationRequired,
      nextAction: row?.nextAction ?? deal.nextAction,
      dueOn: row ? row.dueOn : deal.dueDate,
      completedOn: completion?.completedOn ?? null,
      completionSourceId: completion?.completionSourceId ?? null,
      offers: [],
      milestones: [],
      findings: [],
      coverage: { offers: emptyCoverage(), milestones: emptyCoverage(), findings: emptyCoverage() },
    };
    retain(item.completionSourceId);
    if (row) {
      const offers = (
        await db.query(
          `select o.id,o.side,o.contact_id as "contactId",o.offer_kind as "offerKind",o.parent_id as "parentId",o.amount::text,o.currency,o.basis,o.quantity,to_char(o.offered_on,'YYYY-MM-DD') as "offeredOn",to_char(o.expires_on,'YYYY-MM-DD') as "expiresOn",o.terms,o.source_id as "sourceId",coalesce(d.decision,'Recorded') as status,d.source_id as "decisionSourceId",to_char(d.decided_on,'YYYY-MM-DD') as "decidedOn",d.recorded_by as "recordedBy",count(*) over()::int as total from aerion.transaction_offers o left join lateral(select * from aerion.transaction_offer_decisions d where d.workspace_id=o.workspace_id and d.offer_id=o.id order by d.created_at desc,d.id desc limit 1)d on true where o.workspace_id=$1 and o.deal_id=$2 and o.cycle=$3 order by o.created_at desc,o.id desc limit $4`,
          [scope.workspaceId, deal.id, row.cycle, limits.offers],
        )
      ).rows as (CommercialTransaction["offers"][number] & { total: number })[];
      item.offers = offers.map(({ total: _total, ...offer }) => ({
        ...offer,
        terms: bounded(offer.terms),
      }));
      item.coverage.offers = coverage(offers[0]?.total ?? 0, offers.length);
      for (const offer of item.offers) {
        retain(offer.sourceId);
        retain(offer.decisionSourceId);
      }
      const milestones = (
        await db.query(
          `select distinct on (key) id as "evidenceId",key,source_id as "sourceId",to_char(occurred_on,'YYYY-MM-DD') as "occurredOn",party,detail,state,reviewer,to_char(reviewed_on,'YYYY-MM-DD') as "reviewedOn" from aerion.transaction_evidence where workspace_id=$1 and deal_id=$2 and cycle=$3 order by key,created_at desc,id desc`,
          [scope.workspaceId, deal.id, row.cycle],
        )
      ).rows as CommercialTransaction["milestones"];
      item.milestones = milestones.map((evidence) => ({
        ...evidence,
        detail: bounded(evidence.detail),
      }));
      item.coverage.milestones = coverage(milestones.length, milestones.length);
      for (const evidence of item.milestones) retain(evidence.sourceId);
      const findings = (
        await db.query(
          `select id,category,severity,title,detail,source_id as "sourceId",to_char(due_on,'YYYY-MM-DD') as "dueOn",status,count(*) over()::int as total from aerion.transaction_findings where workspace_id=$1 and deal_id=$2 and cycle=$3 and status='Open' order by (severity='Blocking') desc,due_on nulls last,created_at,id limit $4`,
          [scope.workspaceId, deal.id, row.cycle, limits.findings],
        )
      ).rows as (CommercialTransaction["findings"][number] & { total: number })[];
      item.findings = findings.map(({ total: _total, ...finding }) => ({
        ...finding,
        detail: bounded(finding.detail),
      }));
      item.coverage.findings = coverage(findings[0]?.total ?? 0, findings.length);
      for (const finding of item.findings) retain(finding.sourceId);
    }
    transactions.push(item);
  }
  const engagements: CommercialEngagement[] = [];
  for (const version of engagementVersions.slice(0, limits.engagements)) {
    const row = (
      await db.query(
        `select e.id,e.revision,e.status,e.terms,to_char(e.ended_on,'YYYY-MM-DD') as "endedOn",e.ended_source_id as "endedSourceId",coalesce(a.amount,0)::text as "earnedMinor",coalesce(i.subtotal,0)::text as "invoicedMinor",coalesce(i.total,0)::text as "invoiceTotalMinor",coalesce(r.amount,0)::text as "receivedMinor" from aerion.revenue_engagements e left join lateral(select sum(amount_minor) amount from aerion.revenue_earnings where workspace_id=e.workspace_id and engagement_id=e.id and status='Recorded') a on true left join lateral(select sum(subtotal_minor) subtotal,sum(total_minor) total from aerion.revenue_invoices where workspace_id=e.workspace_id and engagement_id=e.id and status='Issued') i on true left join lateral(select sum(p.amount_minor) amount from aerion.revenue_receipts p join aerion.revenue_invoices v on v.id=p.invoice_id and v.workspace_id=p.workspace_id where p.workspace_id=e.workspace_id and p.engagement_id=e.id and p.status='Recorded' and v.status='Issued') r on true where e.workspace_id=$1 and e.id=$2`,
        [scope.workspaceId, version.id],
      )
    ).rows[0];
    const terms = engagementTermsSchema.parse(row.terms);
    const earnings = (
      await db.query(
        `select id,to_char(earned_on,'YYYY-MM-DD') as "earnedOn",amount_minor::text as "amountMinor",source_id as "sourceId",status,void_source_id as "voidSourceId",count(*) over()::int as total from aerion.revenue_earnings where workspace_id=$1 and engagement_id=$2 order by created_at desc,id desc limit $3`,
        [scope.workspaceId, version.id, limits.earnings],
      )
    ).rows as (CommercialEngagement["earnings"][number] & { total: number })[];
    const invoices = (
      await db.query(
        `select i.id,i.invoice_number as number,i.status,i.currency,to_char(i.issued_on,'YYYY-MM-DD') as "issuedOn",to_char(i.due_on,'YYYY-MM-DD') as "dueOn",i.total_minor::text as "totalMinor",coalesce(r.amount,0)::text as "receivedMinor",(case when i.status='Voided' then 0 else i.total_minor-coalesce(r.amount,0) end)::text as "outstandingMinor",count(*) over()::int as total from aerion.revenue_invoices i left join lateral(select sum(amount_minor) amount from aerion.revenue_receipts where workspace_id=i.workspace_id and invoice_id=i.id and status='Recorded') r on true where i.workspace_id=$1 and i.engagement_id=$2 order by (i.status='Issued' and i.total_minor>coalesce(r.amount,0)) desc,i.due_on,i.created_at desc,i.id desc limit $3`,
        [scope.workspaceId, version.id, limits.invoices],
      )
    ).rows as (CommercialEngagement["invoices"][number] & { total: number })[];
    const today = calendarDate();
    const item: CommercialEngagement = {
      id: row.id,
      revision: row.revision,
      status: row.status,
      effectiveStatus:
        row.status !== "Active"
          ? row.status
          : terms.startsOn > today
            ? "Upcoming"
            : terms.endsOn && terms.endsOn < today
              ? "Expired"
              : "Active",
      dealId: version.dealId,
      requirementId: terms.requirementId,
      title: terms.title,
      representation: terms.representation,
      scope: bounded(terms.scope),
      startsOn: terms.startsOn,
      endsOn: terms.endsOn,
      currency: terms.currency,
      feeType: terms.feeType,
      fixedAmount: terms.fixedAmount,
      percentage: terms.percentage,
      basisDescription: bounded(terms.basisDescription),
      earningTrigger: terms.earningTrigger,
      earningTerms: bounded(terms.earningTerms),
      paymentTerms: bounded(terms.paymentTerms),
      signedSourceId: terms.signedSourceId,
      signedOn: terms.signedOn,
      signatory: terms.signatory,
      endedOn: row.endedOn,
      endedSourceId: row.endedSourceId,
      totals: {
        earnedMinor: row.earnedMinor,
        invoicedMinor: row.invoicedMinor,
        invoiceTotalMinor: row.invoiceTotalMinor,
        receivedMinor: row.receivedMinor,
        outstandingMinor: (BigInt(row.invoiceTotalMinor) - BigInt(row.receivedMinor)).toString(),
      },
      earnings: earnings.map(({ total: _total, ...earning }) => earning),
      invoices: invoices.map(({ total: _total, ...invoice }) => invoice),
      coverage: {
        earnings: coverage(earnings[0]?.total ?? 0, earnings.length),
        invoices: coverage(invoices[0]?.total ?? 0, invoices.length),
      },
    };
    retain(item.signedSourceId);
    retain(item.endedSourceId);
    for (const earning of item.earnings) {
      retain(earning.sourceId);
      retain(earning.voidSourceId);
    }
    engagements.push(item);
  }
  return {
    transactions,
    engagements,
    sourceIds: [...sourceIds].sort(),
    revisionState,
    coverage: {
      transactions: coverage(deals.length, transactions.length),
      engagements: coverage(engagementVersions.length, engagements.length),
    },
  };
}

export async function readCommercialContext(
  scope: Scope,
  requirementId: string,
  aircraftId?: string | null,
) {
  return transaction(scope.actorId, scope.workspaceId, (db) =>
    commercialContextInTransaction(db, scope, requirementId, aircraftId),
  );
}
