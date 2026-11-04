import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { workspaceSchema, type Workspace } from "../../lib/schema";
import { calendarDate } from "../../lib/format";
import { maxMinor, moneyMinor, percentageFee, type Currency } from "../../lib/revenue/money";
import {
  createEngagementSchema,
  engagementTermsSchema,
  revenueMutationSchema,
  type Engagement,
  type EngagementSummary,
  type EngagementTerms,
  type Earning,
  type RevenueCenter,
  type RevenueDetail,
  type RevenueExpense,
  type RevenueInvoice,
  type RevenueReceipt,
  type RevenuePayment,
  type RevenueTotals,
  type InvoiceSnapshot,
} from "../../lib/revenue/schema";
import { transaction, audit, type Scope } from "../db";
import { HttpError } from "../http";
import { fingerprint } from "../agents/evidence";
import { readTransactionCompletion } from "../transactions/workflow";

const engagementColumns = `e.id,e.revision,e.status,e.terms,e.parties,e.activated_at as "activatedAt",e.activation_note as "activationNote",to_char(e.ended_on,'YYYY-MM-DD') as "endedOn",e.ended_note as "endedNote",e.created_at as "createdAt",e.updated_at as "updatedAt"`;
const earningColumns = `id,engagement_id as "engagementId",to_char(earned_on,'YYYY-MM-DD') as "earnedOn",amount_minor::text as "amountMinor",basis_minor::text as "basisMinor",source_id as "sourceId",note,status,void_note as "voidNote",transaction_snapshot as "transactionSnapshot",created_at as "createdAt"`;
const invoiceColumns = `i.id,i.engagement_id as "engagementId",i.earning_id as "earningId",i.invoice_number as number,i.currency,to_char(i.issued_on,'YYYY-MM-DD') as "issuedOn",to_char(i.due_on,'YYYY-MM-DD') as "dueOn",i.subtotal_minor::text as "subtotalMinor",i.tax_minor::text as "taxMinor",i.total_minor::text as "totalMinor",i.snapshot,i.status,i.void_note as "voidNote",i.created_at as "createdAt",coalesce(p.received,0)::text as "receivedMinor",(case when i.status='Voided' then 0 else i.total_minor-coalesce(p.received,0) end)::text as "outstandingMinor"`;
const receiptColumns = `id,engagement_id as "engagementId",invoice_id as "invoiceId",payment_id as "paymentId",amount_minor::text as "amountMinor",to_char(received_on,'YYYY-MM-DD') as "receivedOn",reference,source_id as "sourceId",note,status,reversal_note as "reversalNote",reversal_source_id as "reversalSourceId",created_at as "createdAt"`;
const paymentQuery = `select p.id,p.payer_contact_id as "payerContactId",p.payer_snapshot as payer,p.reference,p.currency,p.amount_minor::text as "amountMinor",to_char(p.received_on,'YYYY-MM-DD') as "receivedOn",p.source_id as "sourceId",p.note,p.legacy_amount as "legacyAmount",p.status,p.void_note as "voidNote",p.created_at as "createdAt",coalesce(a.allocated,0)::text as "allocatedMinor",(case when p.status='Voided' then 0 else p.amount_minor-coalesce(a.allocated,0) end)::text as "unallocatedMinor" from aerion.revenue_payments p left join lateral(select sum(amount_minor) allocated from aerion.revenue_receipts where workspace_id=p.workspace_id and payment_id=p.id and status='Recorded') a on true`;
const expenseColumns = `id,engagement_id as "engagementId",amount_minor::text as "amountMinor",to_char(incurred_on,'YYYY-MM-DD') as "incurredOn",category,description,reference,source_id as "sourceId",note,status,reversal_note as "reversalNote",reversal_source_id as "reversalSourceId",created_at as "createdAt"`;

const totalsQuery = `select ${engagementColumns},coalesce(a.amount,0)::text as earned,coalesce(i.subtotal,0)::text as invoiced,coalesce(i.total,0)::text as total,coalesce(r.amount,0)::text as received,coalesce(x.amount,0)::text as expenses
 from aerion.revenue_engagements e
 left join lateral (select sum(amount_minor) amount from aerion.revenue_earnings where workspace_id=e.workspace_id and engagement_id=e.id and status='Recorded') a on true
 left join lateral (select sum(subtotal_minor) subtotal,sum(total_minor) total from aerion.revenue_invoices where workspace_id=e.workspace_id and engagement_id=e.id and status='Issued') i on true
 left join lateral (select sum(p.amount_minor) amount from aerion.revenue_receipts p join aerion.revenue_invoices v on v.id=p.invoice_id and v.workspace_id=p.workspace_id where p.workspace_id=e.workspace_id and p.engagement_id=e.id and p.status='Recorded' and v.status='Issued') r on true
 left join lateral (select sum(amount_minor) amount from aerion.revenue_expenses where workspace_id=e.workspace_id and engagement_id=e.id and status='Recorded') x on true`;

function estimated(terms: EngagementTerms): bigint | null {
  if (terms.feeType === "Fixed") return moneyMinor(terms.fixedAmount ?? "", terms.currency);
  return terms.estimateBasis
    ? percentageFee(moneyMinor(terms.estimateBasis, terms.currency), terms.percentage ?? "")
    : null;
}
function summarize(
  row: Engagement & {
    earned: string;
    invoiced: string;
    total: string;
    received: string;
    expenses: string;
  },
): EngagementSummary {
  const estimate = estimated(row.terms),
    today = calendarDate();
  return {
    id: row.id,
    revision: row.revision,
    status: row.status,
    terms: row.terms,
    parties: row.parties,
    activatedAt: row.activatedAt,
    activationNote: row.activationNote,
    endedOn: row.endedOn,
    endedNote: row.endedNote,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    estimatedMinor: estimate?.toString() ?? null,
    effectiveStatus:
      row.status !== "Active"
        ? row.status
        : row.terms.startsOn > today
          ? "Upcoming"
          : row.terms.endsOn && row.terms.endsOn < today
            ? "Expired"
            : "Active",
    totals: {
      currency: row.terms.currency,
      estimatedMinor: row.status === "Draft" ? (estimate ?? 0n).toString() : "0",
      contractedMinor: row.status !== "Draft" ? (estimate ?? 0n).toString() : "0",
      earnedMinor: row.earned,
      invoicedMinor: row.invoiced,
      outstandingMinor: (BigInt(row.total) - BigInt(row.received)).toString(),
      receivedMinor: row.received,
      expensesMinor: row.expenses,
      netCashMinor: (BigInt(row.received) - BigInt(row.expenses)).toString(),
    },
  };
}
const sourceList = async (db: PoolClient, scope: Scope) =>
  (
    await db.query(
      "select id,title from aerion.sources where workspace_id=$1 order by created_at desc limit 500",
      [scope.workspaceId],
    )
  ).rows as RevenueCenter["sources"];
async function summaryInTransaction(db: PoolClient, scope: Scope, id: string) {
  const row = (
    await db.query(`${totalsQuery} where e.workspace_id=$1 and e.id=$2`, [scope.workspaceId, id])
  ).rows[0];
  if (!row) throw new HttpError(404, "Engagement not found.");
  return summarize(row);
}
export async function readRevenueCenter(scope: Scope): Promise<RevenueCenter> {
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    const engagements = (
      await db.query(
        `${totalsQuery} where e.workspace_id=$1 order by e.created_at desc limit 500`,
        [scope.workspaceId],
      )
    ).rows.map(summarize);
    const totals = new Map<Currency, RevenueTotals>();
    for (const engagement of engagements) {
      const total = totals.get(engagement.terms.currency);
      if (!total) totals.set(engagement.terms.currency, { ...engagement.totals });
      else
        for (const field of [
          "estimatedMinor",
          "contractedMinor",
          "earnedMinor",
          "invoicedMinor",
          "outstandingMinor",
          "receivedMinor",
          "expensesMinor",
          "netCashMinor",
        ] as const)
          total[field] = (BigInt(total[field]) + BigInt(engagement.totals[field])).toString();
    }
    return {
      engagements,
      totals: [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency)),
      sources: await sourceList(db, scope),
    };
  });
}
async function invoicesInTransaction(db: PoolClient, scope: Scope, id: string) {
  return (
    await db.query(
      `select ${invoiceColumns} from aerion.revenue_invoices i left join lateral (select sum(amount_minor) received from aerion.revenue_receipts where workspace_id=i.workspace_id and invoice_id=i.id and status='Recorded') p on true where i.workspace_id=$1 and i.engagement_id=$2 order by i.created_at desc`,
      [scope.workspaceId, id],
    )
  ).rows as RevenueInvoice[];
}
async function detailInTransaction(
  db: PoolClient,
  scope: Scope,
  id: string,
): Promise<RevenueDetail> {
  const engagement = await summaryInTransaction(db, scope, id);
  // A transaction owns one pg client; its queries execute in order rather than queue concurrently.
  const earnings = await db.query(
    `select ${earningColumns} from aerion.revenue_earnings where workspace_id=$1 and engagement_id=$2 order by created_at desc`,
    [scope.workspaceId, id],
  );
  const invoices = await invoicesInTransaction(db, scope, id);
  const receipts = await db.query(
    `select ${receiptColumns} from aerion.revenue_receipts where workspace_id=$1 and engagement_id=$2 order by created_at desc`,
    [scope.workspaceId, id],
  );
  const expenses = await db.query(
    `select ${expenseColumns} from aerion.revenue_expenses where workspace_id=$1 and engagement_id=$2 order by created_at desc`,
    [scope.workspaceId, id],
  );
  const activity = await db.query(
    'select id,action,detail,created_at as "createdAt" from aerion.activity where workspace_id=$1 and record_id=$2 order by created_at desc limit 100',
    [scope.workspaceId, id],
  );
  const sources = await sourceList(db, scope);
  const payments = (
    await db.query(
      `${paymentQuery} where p.workspace_id=$1 and p.payer_contact_id=$2 order by p.created_at desc limit 10000`,
      [scope.workspaceId, engagement.terms.payerContactId],
    )
  ).rows as RevenuePayment[];
  let completionWarning: string | null = null;
  const historical = earnings.rows.find(
    (earning: Earning) => earning.status === "Recorded" && earning.transactionSnapshot,
  ) as Earning | undefined;
  if (historical?.transactionSnapshot && engagement.terms.dealId) {
    try {
      const current = await readTransactionCompletion(db, scope, engagement.terms.dealId);
      if (
        current?.status !== "Completed" ||
        current.contextChanged ||
        current.cycle !== historical.transactionSnapshot.cycle ||
        current.completionSourceId !== historical.transactionSnapshot.completionSourceId
      )
        completionWarning =
          "The transaction completion changed after this fee was recorded. The historical earning and payment records remain retained; review the agreement and record any necessary evidence-backed accounting correction.";
    } catch (error) {
      if (!(error instanceof HttpError && error.status === 404)) throw error;
      completionWarning =
        "The linked opportunity is no longer available. Historical earned and received amounts remain retained; review their supporting agreement and documents.";
    }
  }
  return {
    engagement,
    earnings: earnings.rows as Earning[],
    invoices,
    receipts: receipts.rows as RevenueReceipt[],
    payments,
    expenses: expenses.rows as RevenueExpense[],
    activity: activity.rows,
    sources,
    completionWarning,
  };
}
export async function readRevenueDetail(scope: Scope, id: string) {
  return transaction(scope.actorId, scope.workspaceId, (db) => detailInTransaction(db, scope, id));
}
export async function readRevenueInvoice(scope: Scope, id: string): Promise<RevenueInvoice> {
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    const row = (
      await db.query(
        `select ${invoiceColumns} from aerion.revenue_invoices i left join lateral (select sum(amount_minor) received from aerion.revenue_receipts where workspace_id=i.workspace_id and invoice_id=i.id and status='Recorded') p on true where i.workspace_id=$1 and i.id=$2`,
        [scope.workspaceId, id],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, "Invoice not found.");
    return row as RevenueInvoice;
  });
}
async function sourceExists(db: PoolClient, scope: Scope, id: string) {
  if (
    !(
      await db.query("select id from aerion.sources where workspace_id=$1 and id=$2", [
        scope.workspaceId,
        id,
      ])
    ).rows.length
  )
    throw new HttpError(404, "The retained evidence document was not found in this workspace.");
}
async function workspaceData(db: PoolClient, scope: Scope, lock = false) {
  const row = (
    await db.query(`select data from aerion.workspaces where id=$1${lock ? " for update" : ""}`, [
      scope.workspaceId,
    ])
  ).rows[0];
  if (!row) throw new HttpError(404, "Workspace not found.");
  return workspaceSchema.parse(row.data);
}
async function validateTerms(
  db: PoolClient,
  scope: Scope,
  terms: EngagementTerms,
  data: Workspace,
) {
  const client = data.contacts.find((c) => c.id === terms.clientContactId),
    payer = data.contacts.find((c) => c.id === terms.payerContactId);
  if (!client || !payer)
    throw new HttpError(404, "Select saved client and fee-payer contacts from this workspace.");
  if (terms.requirementId && !data.requirements.some((r) => r.id === terms.requirementId))
    throw new HttpError(404, "The linked requirement was not found.");
  const deal = terms.dealId ? data.deals.find((d) => d.id === terms.dealId) : null;
  if (terms.dealId && !deal) throw new HttpError(404, "The linked opportunity was not found.");
  if (deal && terms.requirementId && deal.requirementId !== terms.requirementId)
    throw new HttpError(422, "The opportunity and requirement must refer to the same buyer brief.");
  if (terms.signedSourceId) await sourceExists(db, scope, terms.signedSourceId);
  return { client, payer };
}
function parseAmount(value: string, currency: Currency, zero = false) {
  try {
    return moneyMinor(value, currency, zero);
  } catch (error) {
    throw new HttpError(422, error instanceof Error ? error.message : "Invalid currency amount.");
  }
}
function feeAmount(basis: bigint, percentage: string) {
  try {
    return percentageFee(basis, percentage);
  } catch (error) {
    throw new HttpError(422, error instanceof Error ? error.message : "Invalid calculated fee.");
  }
}
function pastOrToday(value: string, label: string) {
  if (value > calendarDate()) throw new HttpError(422, `${label} cannot be in the future.`);
}
const referenceKey = (value: string) =>
  value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
async function recordLimit(
  db: PoolClient,
  table: "revenue_invoices" | "revenue_receipts" | "revenue_expenses",
  scope: Scope,
  id: string,
  maximum: number,
) {
  const n = (
    await db.query(
      `select count(*)::int n from aerion.${table} where workspace_id=$1 and engagement_id=$2`,
      [scope.workspaceId, id],
    )
  ).rows[0].n;
  if (n >= maximum)
    throw new HttpError(
      422,
      `This engagement reached its ${maximum}-record ${table.replace("revenue_", "")} limit.`,
    );
}
export async function createEngagement(scope: Scope, raw: unknown): Promise<RevenueDetail> {
  const input = createEngagementSchema.parse(raw),
    hash = fingerprint(input.terms);
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    const data = await workspaceData(db, scope, true);
    const previous = (
      await db.query(
        "select id,request_hash from aerion.revenue_engagements where workspace_id=$1 and idempotency_key=$2",
        [scope.workspaceId, input.idempotencyKey],
      )
    ).rows[0];
    if (previous) {
      if (previous.request_hash !== hash)
        throw new HttpError(409, "This request key was used for different engagement terms.");
      return detailInTransaction(db, scope, previous.id);
    }
    if (
      (
        await db.query(
          "select count(*)::int n from aerion.revenue_engagements where workspace_id=$1",
          [scope.workspaceId],
        )
      ).rows[0].n >= 500
    )
      throw new HttpError(422, "This workspace reached its 500-engagement limit.");
    const parties = await validateTerms(db, scope, input.terms, data),
      id = randomUUID();
    await db.query(
      "insert into aerion.revenue_engagements(id,workspace_id,terms,parties,signed_source_id,idempotency_key,request_hash) values($1,$2,$3,$4,$5,$6,$7)",
      [
        id,
        scope.workspaceId,
        input.terms,
        parties,
        input.terms.signedSourceId,
        input.idempotencyKey,
        hash,
      ],
    );
    await audit(db, scope, "revenue.engagement-created", id, {
      title: input.terms.title,
      note: "Draft only; client engagement and compensation require signed evidence and founder review.",
    });
    return detailInTransaction(db, scope, id);
  });
}
export async function mutateRevenue(
  scope: Scope,
  id: string,
  raw: unknown,
): Promise<RevenueDetail> {
  const input = revenueMutationSchema.parse(raw),
    action = input.action,
    hash = fingerprint({ id, action });
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    const data = await workspaceData(db, scope, true);
    const row = (
      await db.query(
        `select ${engagementColumns} from aerion.revenue_engagements e where e.workspace_id=$1 and e.id=$2 for update`,
        [scope.workspaceId, id],
      )
    ).rows[0] as Engagement | undefined;
    if (!row) throw new HttpError(404, "Engagement not found.");
    const previous = (
      await db.query(
        "select engagement_id,request_hash from aerion.revenue_operations where workspace_id=$1 and idempotency_key=$2",
        [scope.workspaceId, input.idempotencyKey],
      )
    ).rows[0];
    if (previous) {
      if (previous.request_hash !== hash || previous.engagement_id !== id)
        throw new HttpError(409, "This request key was already used for another action.");
      return detailInTransaction(db, scope, id);
    }
    if (row.revision !== input.revision)
      throw new HttpError(
        409,
        "This engagement changed in another session. Refresh its current records before retrying.",
      );
    const terms = engagementTermsSchema.parse(row.terms),
      currency = terms.currency;
    let recordId: string | null = null;
    if (action.kind === "edit") {
      if (row.status !== "Draft")
        throw new HttpError(
          422,
          "Activated engagement terms are immutable. Retain an amendment as a new agreement record.",
        );
      const parties = await validateTerms(db, scope, action.terms, data);
      await db.query(
        "update aerion.revenue_engagements set terms=$1,parties=$2,signed_source_id=$3 where workspace_id=$4 and id=$5",
        [action.terms, parties, action.terms.signedSourceId, scope.workspaceId, id],
      );
    } else if (action.kind === "activate") {
      if (row.status !== "Draft")
        throw new HttpError(422, "Only a Draft engagement can be activated.");
      if (!terms.signedSourceId || !terms.signedOn || terms.signatory.length < 2)
        throw new HttpError(
          422,
          "Retain the signed engagement and record its signatory and signing date before activation.",
        );
      pastOrToday(terms.signedOn, "The signing date");
      const parties = await validateTerms(db, scope, terms, data);
      if (terms.earningTrigger === "Closing" && !terms.dealId)
        throw new HttpError(422, "A closing-based engagement needs a linked opportunity.");
      await db.query(
        "update aerion.revenue_engagements set status='Active',reviewer=$1,activated_at=now(),activation_note=$2,parties=$5 where workspace_id=$3 and id=$4",
        [scope.actorId, action.note, scope.workspaceId, id, parties],
      );
    } else if (action.kind === "end") {
      if (row.status !== "Active")
        throw new HttpError(422, "Only an activated engagement can be ended.");
      pastOrToday(action.endedOn, "The end date");
      if (action.endedOn < terms.startsOn)
        throw new HttpError(422, "End date cannot precede the recorded start date.");
      if (
        (
          await db.query(
            "select id from aerion.revenue_earnings where workspace_id=$1 and engagement_id=$2 and status='Recorded' and earned_on>$3 limit 1",
            [scope.workspaceId, id, action.endedOn],
          )
        ).rows.length
      )
        throw new HttpError(
          422,
          "The end date cannot precede a recorded earning. Correct an erroneous earning with retained evidence first: reverse any receipts, void its invoices, then void the earning before recording an earlier end date.",
        );
      await sourceExists(db, scope, action.sourceId);
      await db.query(
        "update aerion.revenue_engagements set status='Ended',ended_on=$1,ended_note=$2,ended_source_id=$3 where workspace_id=$4 and id=$5",
        [action.endedOn, action.note, action.sourceId, scope.workspaceId, id],
      );
    } else if (action.kind === "earn") {
      if (row.status === "Draft")
        throw new HttpError(
          422,
          "Activate and review the signed engagement before recording an earned fee.",
        );
      pastOrToday(action.earnedOn, "The earning date");
      if (
        action.earnedOn < terms.startsOn ||
        (terms.endsOn && action.earnedOn > terms.endsOn) ||
        (row.endedOn && action.earnedOn > row.endedOn)
      )
        throw new HttpError(
          422,
          "The earning date must fall within this recorded engagement term. Retain any extension or amendment separately.",
        );
      await sourceExists(db, scope, action.sourceId);
      if (
        (
          await db.query(
            "select id from aerion.revenue_earnings where workspace_id=$1 and engagement_id=$2 and status='Recorded'",
            [scope.workspaceId, id],
          )
        ).rows.length
      )
        throw new HttpError(
          409,
          "This engagement already has a recorded fee. Void an incorrect unbilled earning with evidence before replacing it.",
        );
      const basis =
        terms.feeType === "Percentage"
          ? action.basisAmount
            ? parseAmount(action.basisAmount, currency)
            : null
          : null;
      if (terms.feeType === "Percentage" && !basis)
        throw new HttpError(
          422,
          "Record the actual agreed calculation basis from retained evidence for a percentage fee.",
        );
      if (terms.feeType === "Fixed" && action.basisAmount)
        throw new HttpError(422, "A fixed fee does not take a percentage calculation basis.");
      const amount =
        terms.feeType === "Fixed"
          ? parseAmount(terms.fixedAmount ?? "", currency)
          : feeAmount(basis ?? 0n, terms.percentage ?? "");
      // Closing eligibility is connected below through the transaction module; the snapshot remains historical evidence.
      const transactionSnapshot = await closingSnapshot(
        db,
        scope,
        terms,
        action.sourceId,
        action.earnedOn,
      );
      recordId = randomUUID();
      await db.query(
        "insert into aerion.revenue_earnings(id,workspace_id,engagement_id,earned_on,amount_minor,basis_minor,source_id,note,actor_id,transaction_snapshot) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [
          recordId,
          scope.workspaceId,
          id,
          action.earnedOn,
          amount.toString(),
          basis?.toString() ?? null,
          action.sourceId,
          action.note,
          scope.actorId,
          transactionSnapshot,
        ],
      );
    } else if (action.kind === "void-earning") {
      await sourceExists(db, scope, action.sourceId);
      const earning = (
        await db.query(
          "select id,status from aerion.revenue_earnings where workspace_id=$1 and engagement_id=$2 and id=$3",
          [scope.workspaceId, id, action.earningId],
        )
      ).rows[0];
      if (!earning) throw new HttpError(404, "Earning not found.");
      if (earning.status !== "Recorded")
        throw new HttpError(422, "This earning is already voided.");
      if (
        (
          await db.query(
            "select id from aerion.revenue_invoices where workspace_id=$1 and earning_id=$2 and status='Issued'",
            [scope.workspaceId, earning.id],
          )
        ).rows.length
      )
        throw new HttpError(422, "Void its issued invoices before reversing this earning.");
      await db.query(
        "update aerion.revenue_earnings set status='Voided',void_note=$1,void_source_id=$2 where workspace_id=$3 and id=$4",
        [action.note, action.sourceId, scope.workspaceId, earning.id],
      );
      recordId = earning.id;
    } else if (action.kind === "invoice") {
      if (row.status === "Draft")
        throw new HttpError(
          422,
          "An issued invoice requires an activated agreement and a recorded earned fee.",
        );
      await recordLimit(db, "revenue_invoices", scope, id, 200);
      pastOrToday(action.issuedOn, "The invoice issue date");
      if (action.dueOn < action.issuedOn)
        throw new HttpError(422, "Invoice due date cannot precede issue date.");
      const earning = (
        await db.query(
          "select amount_minor::text amount,to_char(earned_on,'YYYY-MM-DD') as date,status,transaction_snapshot as snapshot from aerion.revenue_earnings where workspace_id=$1 and engagement_id=$2 and id=$3",
          [scope.workspaceId, id, action.earningId],
        )
      ).rows[0];
      if (earning?.status !== "Recorded")
        throw new HttpError(422, "Select a recorded, unvoided earned fee.");
      if (
        earning.date < terms.startsOn ||
        (terms.endsOn && earning.date > terms.endsOn) ||
        (row.endedOn && earning.date > row.endedOn)
      )
        throw new HttpError(
          422,
          "This recorded earning falls outside the engagement term. Review its retained agreement and correct the earning with evidence before issuing another invoice; existing financial history remains retained.",
        );
      if (terms.earningTrigger === "Closing") {
        if (!earning.snapshot?.completionSourceId)
          throw new HttpError(
            422,
            "The closing earning has no retained completion snapshot. Review its original record before invoicing.",
          );
        const completion = await closingSnapshot(
          db,
          scope,
          terms,
          earning.snapshot.completionSourceId,
          earning.date,
        );
        if (
          completion?.cycle !== earning.snapshot.cycle ||
          completion?.completionSourceId !== earning.snapshot.completionSourceId
        )
          throw new HttpError(
            422,
            "The transaction completion cycle changed after this fee was recorded. Resolve the earning evidence before issuing another invoice.",
          );
      }
      if (action.issuedOn < earning.date)
        throw new HttpError(422, "The invoice cannot precede the recorded earning event.");
      const subtotal = parseAmount(action.amount, currency),
        tax = parseAmount(action.taxAmount, currency, true),
        total = subtotal + tax;
      if (total > maxMinor) throw new HttpError(422, "Invoice total exceeds the supported bound.");
      if (tax > 0n && !action.taxLabel.trim())
        throw new HttpError(
          422,
          "Name the explicitly recorded tax or additional statutory charge.",
        );
      const allocated = (
        await db.query(
          "select coalesce(sum(subtotal_minor),0)::text n from aerion.revenue_invoices where workspace_id=$1 and earning_id=$2 and status='Issued'",
          [scope.workspaceId, action.earningId],
        )
      ).rows[0].n;
      if (BigInt(allocated) + subtotal > BigInt(earning.amount))
        throw new HttpError(422, "Invoice commission exceeds the remaining unbilled earned fee.");
      const count = (
        await db.query(
          "select count(*)::int n from aerion.revenue_invoices where workspace_id=$1",
          [scope.workspaceId],
        )
      ).rows[0].n;
      const number = `AER-${action.issuedOn.slice(0, 4)}-${String(count + 1).padStart(6, "0")}`;
      const snapshot: InvoiceSnapshot = {
        issuerName: action.issuerName,
        issuerEmail: action.issuerEmail,
        issuerAddress: action.issuerAddress,
        issuerRegistration: action.issuerRegistration,
        billTo: {
          name: row.parties.payer.name,
          company: row.parties.payer.company,
          email: row.parties.payer.email,
          address: action.billToAddress,
        },
        engagementTitle: terms.title,
        description: action.description,
        paymentInstructions: action.paymentInstructions,
        taxLabel: action.taxLabel,
        feeTerms: {
          type: terms.feeType,
          percentage: terms.percentage,
          basisDescription: terms.basisDescription,
          earningTerms: terms.earningTerms,
          paymentTerms: terms.paymentTerms,
        },
      };
      recordId = randomUUID();
      await db.query(
        "insert into aerion.revenue_invoices(id,workspace_id,engagement_id,earning_id,invoice_number,currency,issued_on,due_on,subtotal_minor,tax_minor,total_minor,snapshot,actor_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)",
        [
          recordId,
          scope.workspaceId,
          id,
          action.earningId,
          number,
          currency,
          action.issuedOn,
          action.dueOn,
          subtotal.toString(),
          tax.toString(),
          total.toString(),
          snapshot,
          scope.actorId,
        ],
      );
    } else if (action.kind === "void-invoice") {
      await sourceExists(db, scope, action.sourceId);
      const invoice = (await invoicesInTransaction(db, scope, id)).find(
        (i) => i.id === action.invoiceId,
      );
      if (!invoice) throw new HttpError(404, "Invoice not found.");
      if (invoice.status !== "Issued") throw new HttpError(422, "This invoice is already voided.");
      if (BigInt(invoice.receivedMinor) > 0n)
        throw new HttpError(
          422,
          "An invoice with recorded receipts cannot be voided. Record evidence-backed receipt reversals first.",
        );
      await db.query(
        "update aerion.revenue_invoices set status='Voided',void_note=$1,void_source_id=$2 where workspace_id=$3 and id=$4",
        [action.note, action.sourceId, scope.workspaceId, invoice.id],
      );
      recordId = invoice.id;
    } else if (action.kind === "receipt") {
      await recordLimit(db, "revenue_receipts", scope, id, 1000);
      await sourceExists(db, scope, action.sourceId);
      pastOrToday(action.receivedOn, "The receipt date");
      const invoice = (await invoicesInTransaction(db, scope, id)).find(
        (i) => i.id === action.invoiceId,
      );
      if (invoice?.status !== "Issued")
        throw new HttpError(422, "Record receipt against an issued, unvoided invoice.");
      if (action.receivedOn < invoice.issuedOn)
        throw new HttpError(422, "The receipt date cannot precede this invoice's issue date.");
      const amount = parseAmount(action.amount, currency),
        paymentTotal = parseAmount(action.paymentTotal, currency);
      if (amount > paymentTotal)
        throw new HttpError(422, "The allocated amount exceeds the actual transfer total.");
      if (amount > BigInt(invoice.outstandingMinor))
        throw new HttpError(
          422,
          "Receipt exceeds the invoice's outstanding total. Record only its allocated received amount.",
        );
      if (
        (
          await db.query(
            "select id from aerion.revenue_receipts where workspace_id=$1 and invoice_id=$2 and reference_key=$3 and status='Recorded'",
            [scope.workspaceId, invoice.id, referenceKey(action.reference)],
          )
        ).rows.length
      )
        throw new HttpError(
          409,
          "This payment reference is already recorded against this invoice.",
        );
      let payment = (
        await db.query(
          `${paymentQuery} where p.workspace_id=$1 and p.reference_key=$2 and p.status='Recorded'`,
          [scope.workspaceId, referenceKey(action.reference)],
        )
      ).rows[0] as RevenuePayment | undefined;
      if (payment) {
        if (
          payment.payerContactId !== terms.payerContactId ||
          payment.currency !== currency ||
          BigInt(payment.amountMinor) !== paymentTotal ||
          payment.sourceId !== action.sourceId ||
          payment.receivedOn !== action.receivedOn
        )
          throw new HttpError(
            409,
            "This transfer reference already has a different retained payer, currency, total, date or evidence. Reuse its original recorded details, or reverse allocations and void an incorrect payment record before correcting it.",
          );
        if (amount > BigInt(payment.unallocatedMinor))
          throw new HttpError(
            422,
            "Allocation exceeds the recorded transfer's unallocated amount across all invoices.",
          );
      } else {
        const count = (
          await db.query(
            "select count(*)::int n from aerion.revenue_payments where workspace_id=$1",
            [scope.workspaceId],
          )
        ).rows[0].n;
        if (count >= 10000)
          throw new HttpError(422, "This workspace reached its 10,000-payment record limit.");
        const paymentId = randomUUID();
        await db.query(
          "insert into aerion.revenue_payments(id,workspace_id,payer_contact_id,payer_snapshot,reference,reference_key,currency,amount_minor,received_on,source_id,note,actor_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
          [
            paymentId,
            scope.workspaceId,
            terms.payerContactId,
            row.parties.payer,
            action.reference,
            referenceKey(action.reference),
            currency,
            paymentTotal.toString(),
            action.receivedOn,
            action.sourceId,
            action.note,
            scope.actorId,
          ],
        );
        payment = (
          await db.query(`${paymentQuery} where p.workspace_id=$1 and p.id=$2`, [
            scope.workspaceId,
            paymentId,
          ])
        ).rows[0] as RevenuePayment;
      }
      recordId = randomUUID();
      await db.query(
        "insert into aerion.revenue_receipts(id,workspace_id,engagement_id,invoice_id,payment_id,amount_minor,received_on,reference,reference_key,source_id,note,actor_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        [
          recordId,
          scope.workspaceId,
          id,
          invoice.id,
          payment.id,
          amount.toString(),
          action.receivedOn,
          action.reference,
          referenceKey(action.reference),
          action.sourceId,
          action.note,
          scope.actorId,
        ],
      );
    } else if (action.kind === "void-payment") {
      await sourceExists(db, scope, action.sourceId);
      const payment = (
        await db.query(
          `${paymentQuery} where p.workspace_id=$1 and p.id=$2 and p.payer_contact_id=$3`,
          [scope.workspaceId, action.paymentId, terms.payerContactId],
        )
      ).rows[0] as RevenuePayment | undefined;
      if (!payment) throw new HttpError(404, "Payment record not found for this fee payer.");
      if (payment.status !== "Recorded")
        throw new HttpError(422, "This payment is already voided.");
      if (BigInt(payment.allocatedMinor) > 0n)
        throw new HttpError(
          422,
          "Reverse all active invoice allocations before voiding this payment record.",
        );
      await db.query(
        "update aerion.revenue_payments set status='Voided',void_note=$1,void_source_id=$2 where workspace_id=$3 and id=$4",
        [action.note, action.sourceId, scope.workspaceId, payment.id],
      );
      recordId = payment.id;
    } else if (action.kind === "reverse-receipt") {
      await sourceExists(db, scope, action.sourceId);
      const item = (
        await db.query(
          "select id,status from aerion.revenue_receipts where workspace_id=$1 and engagement_id=$2 and id=$3",
          [scope.workspaceId, id, action.receiptId],
        )
      ).rows[0];
      if (!item) throw new HttpError(404, "Receipt not found.");
      if (item.status !== "Recorded") throw new HttpError(422, "This receipt is already reversed.");
      await db.query(
        "update aerion.revenue_receipts set status='Reversed',reversal_note=$1,reversal_source_id=$2 where workspace_id=$3 and id=$4",
        [action.note, action.sourceId, scope.workspaceId, item.id],
      );
      recordId = item.id;
    } else if (action.kind === "expense") {
      await recordLimit(db, "revenue_expenses", scope, id, 1000);
      await sourceExists(db, scope, action.sourceId);
      pastOrToday(action.incurredOn, "The expense date");
      const amount = parseAmount(action.amount, currency);
      if (
        (
          await db.query(
            "select id from aerion.revenue_expenses where workspace_id=$1 and reference_key=$2 and status='Recorded'",
            [scope.workspaceId, referenceKey(action.reference)],
          )
        ).rows.length
      )
        throw new HttpError(
          409,
          "This paid expense reference is already recorded in this workspace. Reverse an incorrect record before reallocating it.",
        );
      recordId = randomUUID();
      await db.query(
        "insert into aerion.revenue_expenses(id,workspace_id,engagement_id,amount_minor,incurred_on,category,description,reference,reference_key,source_id,note,actor_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        [
          recordId,
          scope.workspaceId,
          id,
          amount.toString(),
          action.incurredOn,
          action.category,
          action.description,
          action.reference,
          referenceKey(action.reference),
          action.sourceId,
          action.note,
          scope.actorId,
        ],
      );
    } else if (action.kind === "reverse-expense") {
      await sourceExists(db, scope, action.sourceId);
      const item = (
        await db.query(
          "select id,status from aerion.revenue_expenses where workspace_id=$1 and engagement_id=$2 and id=$3",
          [scope.workspaceId, id, action.expenseId],
        )
      ).rows[0];
      if (!item) throw new HttpError(404, "Expense not found.");
      if (item.status !== "Recorded") throw new HttpError(422, "This expense is already reversed.");
      await db.query(
        "update aerion.revenue_expenses set status='Reversed',reversal_note=$1,reversal_source_id=$2 where workspace_id=$3 and id=$4",
        [action.note, action.sourceId, scope.workspaceId, item.id],
      );
      recordId = item.id;
    }
    await db.query(
      "update aerion.revenue_engagements set revision=revision+1,updated_at=now() where workspace_id=$1 and id=$2",
      [scope.workspaceId, id],
    );
    await db.query(
      "insert into aerion.revenue_operations(workspace_id,engagement_id,idempotency_key,request_hash) values($1,$2,$3,$4)",
      [scope.workspaceId, id, input.idempotencyKey, hash],
    );
    await audit(db, scope, `revenue.${action.kind}`, id, {
      recordId,
      note: "note" in action ? action.note : "Draft terms updated.",
      ...(action.kind === "edit" ? { termsHash: fingerprint(action.terms) } : {}),
    });
    return detailInTransaction(db, scope, id);
  });
}

async function closingSnapshot(
  db: PoolClient,
  scope: Scope,
  terms: EngagementTerms,
  sourceId: string,
  earnedOn: string,
): Promise<Earning["transactionSnapshot"]> {
  if (terms.earningTrigger !== "Closing") return null;
  if (!terms.dealId)
    throw new HttpError(422, "A closing-triggered fee needs a linked opportunity.");
  const completion = await readTransactionCompletion(db, scope, terms.dealId);
  if (
    completion?.status !== "Completed" ||
    completion.contextChanged ||
    !completion.completedOn ||
    !completion.completionSourceId
  )
    throw new HttpError(
      422,
      "The linked transaction needs current, completed closing evidence before recording a closing-triggered fee.",
    );
  if (completion.completedOn > earnedOn)
    throw new HttpError(
      422,
      "The earning date cannot precede the linked transaction's completion date.",
    );
  if (completion.completionSourceId !== sourceId)
    throw new HttpError(
      422,
      "Use the linked transaction's current closing completion document as the earning evidence.",
    );
  return {
    cycle: completion.cycle,
    completedOn: completion.completedOn,
    completionSourceId: completion.completionSourceId,
    revision: completion.revision,
  };
}
