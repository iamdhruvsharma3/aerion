import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { workspaceSchema, type Aircraft, type Requirement } from "../../lib/schema";
import { calendarDate } from "../../lib/format";
import {
  transactionActionSchema,
  transactionGaps,
  isTerminal,
  nextTransactionStage,
  singleAircraftScopeMessage,
  type TransactionDetail,
  type TransactionSummary,
} from "../../lib/transactions/schema";
import { transaction, audit, type Scope } from "../db";
import { HttpError } from "../http";
import { fingerprint } from "../agents/evidence";
import { mutateWorkspaceInTransaction } from "../repository";
import { requirementNeedsRequalification } from "../communication/context";

const summaryColumns = `deal_id as "dealId",revision,cycle,status,transaction_kind as "transactionKind",next_action as "nextAction",to_char(due_on,'YYYY-MM-DD') as "dueOn",to_char(completed_on,'YYYY-MM-DD') as "completedOn",completion_source_id as "completionSourceId",updated_at as "updatedAt"`;
function commercialTerms(aircraft: Aircraft | undefined, requirement: Requirement | undefined) {
  const explicit =
    (aircraft &&
      ["offering", "leaseRate", "leaseCurrency", "leaseBasis"].some((key) => key in aircraft)) ||
    (requirement &&
      ["transactionKind", "leaseBudget", "leaseCurrency", "leaseBasis"].some(
        (key) => key in requirement,
      ));
  return explicit
    ? {
        aircraft: {
          offering: aircraft?.offering ?? "Sale",
          price: aircraft?.price,
          leaseRate: aircraft?.leaseRate ?? null,
          leaseCurrency: aircraft?.leaseCurrency ?? null,
          leaseBasis: aircraft?.leaseBasis ?? null,
        },
        requirement: {
          transactionKind: requirement?.transactionKind ?? "Sale",
          budget: requirement?.budget,
          leaseBudget: requirement?.leaseBudget ?? null,
          leaseCurrency: requirement?.leaseCurrency ?? null,
          leaseBasis: requirement?.leaseBasis ?? null,
        },
      }
    : null;
}
function commercialIssue(
  aircraft: Aircraft | undefined,
  requirement: Requirement | undefined,
  legacyKind?: "Sale" | "Lease",
): string | null {
  const kind = requirement?.transactionKind ?? legacyKind ?? "Sale";
  const offering =
    aircraft?.offering ??
    (legacyKind === "Lease" && requirement?.transactionKind === undefined
      ? "Sale or lease"
      : "Sale");
  if (kind === "Not supplied" || offering === "Not supplied")
    return "Clarify and reconfirm whether the buyer requires a sale or lease and which terms the aircraft is offered under before progressing this transaction.";
  if (offering !== "Sale or lease" && offering !== kind)
    return "The aircraft offering does not match the buyer's sale or lease requirement. Requalify the commercial scope with a current confirmed brief before progressing.";
  if (requirement?.transactionKind === "Lease" && requirement.budget !== null)
    return "Requalify the lease brief: a purchase budget cannot serve as a lease ceiling. Record lease-only budget, currency and rate basis before progressing.";
  if (
    kind === "Lease" &&
    (!requirement?.leaseCurrency || !requirement.leaseBasis) &&
    requirement?.transactionKind === "Lease"
  )
    return "Requalify and confirm the lease budget currency and monthly or hourly basis before recording lease offers or progressing.";
  return null;
}
function leaseOfferIssue(
  requirement: Requirement | undefined,
  offer: { amount: string; currency: string; basis: string },
) {
  if (requirement?.transactionKind !== "Lease") return null;
  if (offer.currency !== requirement.leaseCurrency || offer.basis !== requirement.leaseBasis)
    return "The offer must use the confirmed lease currency and monthly or hourly basis. Requalify the brief before accepting different commercial terms.";
  if (requirement.leaseBudget != null && Number(offer.amount) > requirement.leaseBudget)
    return "This offer exceeds the confirmed lease ceiling. Retain it as negotiation history, but obtain a compliant counteroffer or a newly confirmed brief before acceptance or progression.";
  return null;
}
async function envelope(db: PoolClient, scope: Scope, id: string) {
  const workspace = (
    await db.query("select data,revision from aerion.workspaces where id=$1", [scope.workspaceId])
  ).rows[0];
  if (!workspace) throw new HttpError(404, "Workspace not found.");
  const data = workspaceSchema.parse(workspace.data),
    deal = data.deals.find((d) => d.id === id);
  if (!deal) throw new HttpError(404, "Opportunity not found in this workspace.");
  const row = (
    await db.query(
      `select ${summaryColumns},context_hash from aerion.transaction_cases where workspace_id=$1 and deal_id=$2`,
      [scope.workspaceId, id],
    )
  ).rows[0];
  const aircraft = data.aircraft.find((item) => item.id === deal.aircraftId),
    requirement = data.requirements.find((item) => item.id === deal.requirementId);
  const terms = commercialTerms(aircraft, requirement);
  const contextHash = fingerprint({
    dealId: id,
    aircraftId: deal.aircraftId,
    requirementId: deal.requirementId,
    ...(terms ? { commercialTerms: terms } : {}),
  });
  const transactionKind =
    requirement?.transactionKind === "Lease"
      ? "Lease"
      : requirement?.transactionKind === "Sale"
        ? "Sale"
        : (row?.transactionKind ?? "Sale");
  let commercialScopeIssue = commercialIssue(aircraft, requirement, row?.transactionKind);
  const kindChanged = Boolean(
    row &&
      requirement?.transactionKind &&
      requirement.transactionKind !== "Not supplied" &&
      row.transactionKind !== requirement.transactionKind,
  );
  if (row && !commercialScopeIssue && requirement?.transactionKind === "Lease") {
    const accepted = (
      await db.query(
        "select o.amount::text,o.currency,o.basis from aerion.transaction_offers o where o.workspace_id=$1 and o.deal_id=$2 and o.cycle=$3 and (select d.decision from aerion.transaction_offer_decisions d where d.workspace_id=o.workspace_id and d.offer_id=o.id order by d.created_at desc,d.id desc limit 1)='Accepted'",
        [scope.workspaceId, id, row.cycle],
      )
    ).rows;
    commercialScopeIssue =
      accepted.map((offer) => leaseOfferIssue(requirement, offer)).find(Boolean) ?? null;
  }
  const supersededRequirement = await requirementNeedsRequalification(
    db,
    scope,
    deal.requirementId,
  );
  const singleAircraftScopeInvalid = Boolean(
    row &&
      (
        await db.query(
          "select 1 from aerion.transaction_offers o where o.workspace_id=$1 and o.deal_id=$2 and o.cycle=$3 and o.quantity>1 and (select d.decision from aerion.transaction_offer_decisions d where d.workspace_id=o.workspace_id and d.offer_id=o.id order by d.created_at desc,d.id desc limit 1)='Accepted' limit 1",
          [scope.workspaceId, id, row.cycle],
        )
      ).rows.length,
  );
  return {
    workspace,
    data,
    deal,
    row,
    contextHash,
    supersededRequirement,
    singleAircraftScopeInvalid,
    commercialScopeIssue,
    kindChanged,
    transactionKind,
    requirement,
  };
}
export async function readTransactionCompletion(
  db: PoolClient,
  scope: Scope,
  dealId: string,
): Promise<
  | (Pick<
      TransactionSummary,
      "status" | "cycle" | "completedOn" | "completionSourceId" | "revision"
    > & { contextChanged: boolean })
  | null
> {
  const context = await envelope(db, scope, dealId);
  if (!context.row) return null;
  const { status, cycle, completedOn, completionSourceId, revision } = context.row;
  const contextChanged =
    context.row.context_hash !== context.contextHash ||
    context.supersededRequirement ||
    context.singleAircraftScopeInvalid ||
    context.kindChanged ||
    Boolean(context.commercialScopeIssue);
  return {
    status,
    cycle,
    completedOn,
    completionSourceId: contextChanged ? null : completionSourceId,
    revision,
    contextChanged,
  };
}
export async function readTransactions(scope: Scope): Promise<TransactionSummary[]> {
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    const workspace = (
      await db.query("select data from aerion.workspaces where id=$1", [scope.workspaceId])
    ).rows[0];
    if (!workspace) throw new HttpError(404, "Workspace not found.");
    const data = workspaceSchema.parse(workspace.data),
      rows = (
        await db.query(
          `select ${summaryColumns} from aerion.transaction_cases where workspace_id=$1`,
          [scope.workspaceId],
        )
      ).rows;
    return data.deals.map(
      (deal) =>
        rows.find((r) => r.dealId === deal.id) ?? {
          dealId: deal.id,
          status: "Sourcing",
          cycle: 1,
          revision: 0,
          transactionKind:
            data.requirements.find((r) => r.id === deal.requirementId)?.transactionKind === "Lease"
              ? "Lease"
              : "Sale",
          nextAction: deal.nextAction,
          dueOn: deal.dueDate,
          completedOn: null,
          completionSourceId: null,
          updatedAt: null,
        },
    );
  });
}
async function detailInTransaction(
  db: PoolClient,
  scope: Scope,
  id: string,
): Promise<TransactionDetail> {
  const {
    data,
    deal,
    row,
    contextHash,
    supersededRequirement,
    singleAircraftScopeInvalid,
    commercialScopeIssue,
    kindChanged,
    transactionKind,
  } = await envelope(db, scope, id);
  const summary: TransactionSummary = row ?? {
    dealId: id,
    status: "Sourcing",
    cycle: 1,
    revision: 0,
    transactionKind,
    nextAction: deal.nextAction,
    dueOn: deal.dueDate,
    completedOn: null,
    completionSourceId: null,
    updatedAt: null,
  };
  const offers = (
    await db.query(
      `select o.id,o.cycle,o.side,o.contact_id as "contactId",o.contact_name as "contactName",o.contact_email as "contactEmail",o.offer_kind as "offerKind",o.parent_id as "parentId",o.amount::text,o.currency,o.basis,o.quantity,to_char(o.offered_on,'YYYY-MM-DD') as "offeredOn",to_char(o.expires_on,'YYYY-MM-DD') as "expiresOn",o.terms,o.source_id as "sourceId",o.note,coalesce(d.decision,'Recorded') as status,d.note as "decisionNote",to_char(d.decided_on,'YYYY-MM-DD') as "decidedOn",d.source_id as "decisionSourceId",d.recorded_by as "recordedBy",o.created_at as "createdAt" from aerion.transaction_offers o left join lateral(select * from aerion.transaction_offer_decisions d where d.workspace_id=o.workspace_id and d.offer_id=o.id order by d.created_at desc,d.id desc limit 1)d on true where o.workspace_id=$1 and o.deal_id=$2 order by o.created_at desc,o.id desc limit 300`,
      [scope.workspaceId, id],
    )
  ).rows;
  const evidence = (
    await db.query(
      `select e.id,e.cycle,e.key,e.source_id as "sourceId",s.title as "sourceTitle",to_char(e.occurred_on,'YYYY-MM-DD') as "occurredOn",e.party,e.detail,e.state,e.reviewer,e.review_note as "reviewNote",to_char(e.reviewed_on,'YYYY-MM-DD') as "reviewedOn",e.created_at as "createdAt",(row_number() over(partition by e.cycle,e.key order by e.created_at desc,e.id desc)=1) as current from aerion.transaction_evidence e join aerion.sources s on s.id=e.source_id and s.workspace_id=e.workspace_id where e.workspace_id=$1 and e.deal_id=$2 order by e.created_at desc,e.id desc limit 500`,
      [scope.workspaceId, id],
    )
  ).rows;
  const findings = (
    await db.query(
      `select id,cycle,category,severity,title,detail,source_id as "sourceId",to_char(due_on,'YYYY-MM-DD') as "dueOn",status,resolution,resolution_source_id as "resolutionSourceId",resolved_by as "resolvedBy",to_char(resolved_on,'YYYY-MM-DD') as "resolvedOn",resolution_note as "resolutionNote",created_at as "createdAt" from aerion.transaction_findings where workspace_id=$1 and deal_id=$2 order by created_at desc,id desc limit 300`,
      [scope.workspaceId, id],
    )
  ).rows;
  const sources = (
    await db.query(
      "select id,title from aerion.sources where workspace_id=$1 order by created_at desc limit 500",
      [scope.workspaceId],
    )
  ).rows;
  const activity = (
    await db.query(
      `select id,action,detail,created_at as "createdAt" from aerion.activity where workspace_id=$1 and record_id=$2 and action like 'transaction.%' order by created_at desc,id desc limit 150`,
      [scope.workspaceId, id],
    )
  ).rows;
  const aircraft = data.aircraft.find((a) => a.id === deal.aircraftId),
    requirement = data.requirements.find((r) => r.id === deal.requirementId);
  return {
    ...summary,
    deal,
    contextChanged:
      Boolean(row && row.context_hash !== contextHash) ||
      supersededRequirement ||
      singleAircraftScopeInvalid ||
      kindChanged ||
      Boolean(commercialScopeIssue),
    supersededRequirement,
    singleAircraftScopeInvalid,
    commercialScopeIssue,
    aircraft: aircraft
      ? { manufacturer: aircraft.manufacturer, model: aircraft.model, serial: aircraft.serial }
      : null,
    requirement: requirement
      ? {
          client: requirement.client,
          aircraftModel: requirement.aircraftModel,
          quantity: requirement.quantity,
          transactionKind: requirement.transactionKind,
          leaseCurrency: requirement.leaseCurrency,
          leaseBasis: requirement.leaseBasis,
        }
      : null,
    contacts: data.contacts.map(({ id, name, company, type, email }) => ({
      id,
      name,
      company,
      type,
      email,
    })),
    sources,
    offers,
    evidence,
    findings,
    activity,
  };
}
export async function readTransaction(scope: Scope, id: string) {
  return transaction(scope.actorId, scope.workspaceId, (db) => detailInTransaction(db, scope, id));
}
async function assertSource(db: PoolClient, scope: Scope, id: string | null) {
  if (
    id &&
    !(
      await db.query("select id from aerion.sources where workspace_id=$1 and id=$2", [
        scope.workspaceId,
        id,
      ])
    ).rows.length
  )
    throw new HttpError(422, "Select a retained source from this workspace.");
}
function pastOrToday(value: string, today: string, label: string) {
  if (value > today) throw new HttpError(422, `${label} cannot be in the future.`);
}
async function offerDecision(
  db: PoolClient,
  scope: Scope,
  id: string,
  cycle: number,
  offerId: string,
  decision: string,
  sourceId: string,
  decidedOn: string,
  recordedBy: string,
  note: string,
) {
  await db.query(
    "insert into aerion.transaction_offer_decisions(id,workspace_id,deal_id,cycle,offer_id,decision,source_id,decided_on,recorded_by,note,actor_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
    [
      randomUUID(),
      scope.workspaceId,
      id,
      cycle,
      offerId,
      decision,
      sourceId,
      decidedOn,
      recordedBy,
      note,
      scope.actorId,
    ],
  );
}
export async function mutateTransaction(
  scope: Scope,
  id: string,
  revision: number,
  idempotencyKey: string,
  raw: unknown,
) {
  const action = transactionActionSchema.parse(raw),
    key = z.uuid().parse(idempotencyKey),
    payloadHash = fingerprint({ id, action });
  const result = await transaction(scope.actorId, scope.workspaceId, async (db) => {
    await db.query("select id from aerion.workspaces where id=$1 for update", [scope.workspaceId]);
    const previous = (
      await db.query(
        "select deal_id,payload_hash from aerion.transaction_requests where workspace_id=$1 and idempotency_key=$2",
        [scope.workspaceId, key],
      )
    ).rows[0];
    if (previous) {
      if (previous.deal_id !== id || previous.payload_hash !== payloadHash)
        throw new HttpError(
          409,
          "This request key was already used for a different transaction action.",
        );
      await envelope(db, scope, id);
      return { reused: true };
    }
    const context = await envelope(db, scope, id),
      detail = await detailInTransaction(db, scope, id),
      today = calendarDate();
    if (detail.revision !== revision)
      throw new HttpError(
        409,
        "This transaction changed in another session. Refresh and review the current state before retrying.",
      );
    const archivalOutcome =
      action.kind === "transition" && ["Lost", "Cancelled"].includes(action.status);
    if (detail.supersededRequirement && !archivalOutcome)
      throw new HttpError(
        422,
        "This opportunity's buyer brief was superseded or its supporting reply assignment was corrected. Its records remain historical; use a newly reviewed and confirmed brief for a new opportunity. Only loss or cancellation can be newly recorded here.",
      );
    if (detail.singleAircraftScopeInvalid && action.kind !== "reopen" && !archivalOutcome)
      throw new HttpError(422, singleAircraftScopeMessage);
    if (detail.commercialScopeIssue && action.kind !== "reopen" && !archivalOutcome)
      throw new HttpError(422, detail.commercialScopeIssue);
    if (action.kind === "reopen" && !archivalOutcome) {
      const issue = commercialIssue(
        context.data.aircraft.find((a) => a.id === context.deal.aircraftId),
        context.requirement,
        context.transactionKind,
      );
      if (issue) throw new HttpError(422, issue);
    }
    if (detail.contextChanged && action.kind !== "reopen" && !archivalOutcome)
      throw new HttpError(
        409,
        "The linked opportunity changed. Reopen the cycle against its current records.",
      );
    if (isTerminal(detail.status) && action.kind !== "reopen")
      throw new HttpError(
        422,
        "This transaction is terminal. Reopen a new cycle before adding or changing records.",
      );
    if (!context.row)
      await db.query(
        "insert into aerion.transaction_cases(workspace_id,deal_id,context_hash,next_action,due_on,transaction_kind) values($1,$2,$3,$4,$5,$6)",
        [
          scope.workspaceId,
          id,
          context.contextHash,
          detail.nextAction,
          detail.dueOn,
          context.transactionKind,
        ],
      );
    let auditDetail: Record<string, unknown> = { cycle: detail.cycle, note: action.note };
    if ("sourceId" in action) await assertSource(db, scope, action.sourceId);
    if ("occurredOn" in action) pastOrToday(action.occurredOn, today, "Recorded event date");
    if (action.kind === "configure") {
      if (
        action.transactionKind !==
        (context.requirement?.transactionKind ?? context.row?.transactionKind ?? "Sale")
      )
        throw new HttpError(
          422,
          "Transaction type must match the buyer's confirmed sale or lease brief. Requalify the brief before changing commercial scope.",
        );
      if (
        action.transactionKind !== detail.transactionKind &&
        detail.offers.some((o) => o.cycle === detail.cycle)
      )
        throw new HttpError(
          422,
          "Start a new cycle to change sale/lease basis after an offer was recorded.",
        );
      await db.query(
        "update aerion.transaction_cases set transaction_kind=$1,next_action=$2,due_on=$3 where workspace_id=$4 and deal_id=$5",
        [action.transactionKind, action.nextAction, action.dueOn, scope.workspaceId, id],
      );
    } else if (action.kind === "offer") {
      if (!["Sourcing", "Offer"].includes(detail.status))
        throw new HttpError(
          422,
          "Offer terms are locked after the LOI milestone. Reopen a new cycle to record changed commercial terms.",
        );
      if (detail.offers.length >= 300)
        throw new HttpError(422, "This transaction supports up to 300 retained offer versions.");
      pastOrToday(action.offeredOn, today, "Offer date");
      if (action.expiresOn && action.expiresOn < action.offeredOn)
        throw new HttpError(422, "Offer expiry cannot precede its date.");
      const contact = context.data.contacts.find((c) => c.id === action.contactId);
      if (!contact || ![action.side, "Broker"].includes(contact.type))
        throw new HttpError(422, "Select a saved contact for this side of the transaction.");
      if ((detail.transactionKind === "Sale") !== (action.basis === "Purchase price"))
        throw new HttpError(
          422,
          "Offer price basis must match the configured sale or lease transaction.",
        );
      if (
        context.requirement?.transactionKind === "Lease" &&
        (action.currency !== context.requirement.leaseCurrency ||
          action.basis !== context.requirement.leaseBasis)
      )
        throw new HttpError(
          422,
          "Record lease offers in the confirmed lease currency and monthly or hourly basis; clarify a different basis before proceeding.",
        );
      const currentOffers = detail.offers.filter((o) => o.cycle === detail.cycle);
      if (
        currentOffers.some(
          (o) =>
            o.currency !== action.currency ||
            o.basis !== action.basis ||
            o.quantity !== action.quantity,
        )
      )
        throw new HttpError(
          422,
          "Currency, price basis and aircraft quantity must remain consistent within a cycle. Reopen a cycle for revised scope.",
        );
      const parent = detail.offers.find(
        (o) => o.id === action.parentId && o.cycle === detail.cycle,
      );
      if ((action.offerKind === "Counteroffer") !== Boolean(parent))
        throw new HttpError(
          422,
          "A counteroffer needs an offer version from the current transaction cycle; an initial offer must not have a parent.",
        );
      const offerId = randomUUID();
      await db.query(
        "insert into aerion.transaction_offers(id,workspace_id,deal_id,cycle,side,contact_id,contact_name,contact_email,offer_kind,parent_id,amount,currency,basis,quantity,offered_on,expires_on,terms,source_id,note,actor_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)",
        [
          offerId,
          scope.workspaceId,
          id,
          detail.cycle,
          action.side,
          contact.id,
          `${contact.name} · ${contact.company}`,
          contact.email,
          action.offerKind,
          action.parentId,
          action.amount,
          action.currency,
          action.basis,
          action.quantity,
          action.offeredOn,
          action.expiresOn,
          action.terms,
          action.sourceId,
          action.note,
          scope.actorId,
        ],
      );
      for (const prior of currentOffers.filter((o) => o.status === "Accepted"))
        await offerDecision(
          db,
          scope,
          id,
          detail.cycle,
          prior.id,
          "Withdrawn",
          action.sourceId,
          action.offeredOn,
          contact.name,
          `Superseded by offer version ${offerId}. ${action.note}`,
        );
      auditDetail = { ...auditDetail, offerId, sourceId: action.sourceId };
    } else if (action.kind === "offer-decision") {
      if (!["Sourcing", "Offer"].includes(detail.status))
        throw new HttpError(
          422,
          "Offer decisions are locked after the LOI milestone. Reopen a new cycle for changed terms.",
        );
      const offer = detail.offers.find((o) => o.id === action.offerId && o.cycle === detail.cycle);
      if (!offer) throw new HttpError(404, "Offer version not found in this cycle.");
      if (action.decision === "Accepted" && offer.quantity !== 1)
        throw new HttpError(422, singleAircraftScopeMessage);
      if (action.decision === "Accepted") {
        const issue = leaseOfferIssue(context.requirement, offer);
        if (issue) throw new HttpError(422, issue);
      }
      pastOrToday(action.decidedOn, today, "Offer decision date");
      if (action.decidedOn < offer.offeredOn)
        throw new HttpError(422, "An offer decision cannot precede the offer.");
      if (action.decision === "Accepted" && offer.expiresOn && action.decidedOn > offer.expiresOn)
        throw new HttpError(
          422,
          "The recorded acceptance is after offer expiry. Retain a renewed offer version first.",
        );
      if (offer.status === action.decision)
        throw new HttpError(409, "This offer decision is already recorded.");
      if (action.decision === "Accepted")
        for (const prior of detail.offers.filter(
          (o) => o.cycle === detail.cycle && o.status === "Accepted",
        ))
          await offerDecision(
            db,
            scope,
            id,
            detail.cycle,
            prior.id,
            "Withdrawn",
            action.sourceId,
            action.decidedOn,
            action.recordedBy,
            `Superseded by accepted offer ${offer.id}. ${action.note}`,
          );
      await offerDecision(
        db,
        scope,
        id,
        detail.cycle,
        offer.id,
        action.decision,
        action.sourceId,
        action.decidedOn,
        action.recordedBy,
        action.note,
      );
      auditDetail = {
        ...auditDetail,
        offerId: offer.id,
        decision: action.decision,
        recordedBy: action.recordedBy,
        sourceId: action.sourceId,
      };
    } else if (action.kind === "evidence") {
      if (detail.evidence.length >= 500)
        throw new HttpError(422, "This transaction supports up to 500 retained evidence versions.");
      const evidenceId = randomUUID();
      await db.query(
        "insert into aerion.transaction_evidence(id,workspace_id,deal_id,cycle,key,source_id,occurred_on,party,detail,note,actor_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        [
          evidenceId,
          scope.workspaceId,
          id,
          detail.cycle,
          action.key,
          action.sourceId,
          action.occurredOn,
          action.party,
          action.detail,
          action.note,
          scope.actorId,
        ],
      );
      auditDetail = { ...auditDetail, evidenceId, key: action.key, sourceId: action.sourceId };
    } else if (action.kind === "evidence-decision") {
      const record = detail.evidence.find(
        (e) => e.id === action.evidenceId && e.cycle === detail.cycle && e.current,
      );
      if (!record) throw new HttpError(404, "Current evidence version not found in this cycle.");
      if (
        action.occurredOn < record.occurredOn ||
        (record.reviewedOn && action.occurredOn < record.reviewedOn)
      )
        throw new HttpError(
          422,
          "Review and verification dates must follow the retained event and previous review.",
        );
      if (action.state === "Reviewed" && record.state !== "Received")
        throw new HttpError(422, "Only newly received evidence can be reviewed.");
      if (action.state === "Verification recorded" && record.state !== "Reviewed")
        throw new HttpError(
          422,
          "Review the current evidence version before recording named verification.",
        );
      if (
        action.state === "Waiver recorded" &&
        (!(["Letter of intent", "Pre-purchase inspection"] as string[]).includes(record.key) ||
          record.state !== "Reviewed")
      )
        throw new HttpError(
          422,
          "Only reviewed LOI or inspection evidence may record a documented waiver. Other milestones require verification.",
        );
      await db.query(
        "update aerion.transaction_evidence set state=$1,reviewer=$2,review_note=$3,reviewed_on=$4 where workspace_id=$5 and id=$6",
        [
          action.state,
          action.recordedBy,
          action.note,
          action.occurredOn,
          scope.workspaceId,
          record.id,
        ],
      );
      auditDetail = {
        ...auditDetail,
        evidenceId: record.id,
        key: record.key,
        sourceId: record.sourceId,
        from: record.state,
        to: action.state,
        recordedBy: action.recordedBy,
        occurredOn: action.occurredOn,
      };
    } else if (action.kind === "finding") {
      if (detail.findings.length >= 300)
        throw new HttpError(422, "This transaction supports up to 300 findings.");
      const findingId = randomUUID();
      await db.query(
        "insert into aerion.transaction_findings(id,workspace_id,deal_id,cycle,category,severity,title,detail,source_id,due_on,note,actor_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        [
          findingId,
          scope.workspaceId,
          id,
          detail.cycle,
          action.category,
          action.severity,
          action.title,
          action.detail,
          action.sourceId,
          action.dueOn,
          action.note,
          scope.actorId,
        ],
      );
      auditDetail = {
        ...auditDetail,
        findingId,
        severity: action.severity,
        sourceId: action.sourceId,
      };
    } else if (action.kind === "resolve-finding") {
      const finding = detail.findings.find(
        (f) => f.id === action.findingId && f.cycle === detail.cycle,
      );
      if (finding?.status !== "Open")
        throw new HttpError(422, "Select an open finding in this cycle.");
      await db.query(
        "update aerion.transaction_findings set status='Resolved',resolution=$1,resolution_source_id=$2,resolved_by=$3,resolved_on=$4,resolution_note=$5 where workspace_id=$6 and id=$7",
        [
          action.resolution,
          action.sourceId,
          action.recordedBy,
          action.occurredOn,
          action.note,
          scope.workspaceId,
          finding.id,
        ],
      );
      auditDetail = {
        ...auditDetail,
        findingId: finding.id,
        resolution: action.resolution,
        sourceId: action.sourceId,
        recordedBy: action.recordedBy,
      };
    } else if (action.kind === "transition") {
      if (action.status === detail.status || action.status === "Sourcing")
        throw new HttpError(
          422,
          "Choose the next stage, an end outcome, or explicitly reopen a new cycle.",
        );
      const terminal = action.status === "Lost" || action.status === "Cancelled";
      if (!terminal && action.status !== nextTransactionStage(detail.status))
        throw new HttpError(422, "Transaction milestones must advance one stage at a time.");
      const gaps = transactionGaps(detail, action.status);
      if (gaps.length) throw new HttpError(422, gaps.join(" "));
      if ((terminal || action.status === "Completed") && !action.sourceId)
        throw new HttpError(
          422,
          "A retained source is required for completion, loss or cancellation.",
        );
      if (action.status === "Completed") {
        const finalEvidence = detail.evidence.find(
          (e) => e.cycle === detail.cycle && e.current && e.key === "Delivery acceptance",
        );
        if (finalEvidence?.sourceId !== action.sourceId)
          throw new HttpError(
            422,
            "Completion must reference the current verified delivery acceptance source.",
          );
        const events = [
          ...detail.evidence
            .filter((e) => e.cycle === detail.cycle && e.current)
            .map((e) => e.reviewedOn ?? e.occurredOn),
          ...detail.offers
            .filter((o) => o.cycle === detail.cycle && o.status === "Accepted")
            .map((o) => o.decidedOn ?? o.offeredOn),
          ...detail.findings
            .filter((f) => f.cycle === detail.cycle && f.status === "Resolved")
            .map((f) => f.resolvedOn ?? ""),
        ];
        if (events.some((date) => date > action.occurredOn))
          throw new HttpError(
            422,
            "Completion cannot precede the supporting acceptance, verification or resolution dates.",
          );
      }
      await db.query(
        "update aerion.transaction_cases set status=$1,completed_on=$2,completion_source_id=$3 where workspace_id=$4 and deal_id=$5",
        [
          action.status,
          action.status === "Completed" ? action.occurredOn : null,
          action.status === "Completed" ? action.sourceId : null,
          scope.workspaceId,
          id,
        ],
      );
      const stage = (
        ["Sourcing", "Offer"].includes(action.status)
          ? "Sourcing"
          : action.status === "LOI"
            ? "Evaluation"
            : ["Agreement", "Inspection"].includes(action.status)
              ? "Due diligence"
              : "Closing"
      ) as typeof context.deal.stage;
      await mutateWorkspaceInTransaction(
        db,
        scope,
        { type: "deal", item: { ...context.deal, stage } },
        context.workspace.revision,
      );
      auditDetail = {
        ...auditDetail,
        from: detail.status,
        to: action.status,
        occurredOn: action.occurredOn,
        sourceId: action.sourceId,
      };
    } else if (action.kind === "reopen") {
      if (detail.completedOn && action.occurredOn < detail.completedOn)
        throw new HttpError(422, "Reopening cannot precede the recorded completion date.");
      if (
        detail.status === "Sourcing" &&
        !detail.offers.length &&
        !detail.evidence.length &&
        !detail.contextChanged
      )
        throw new HttpError(422, "This new transaction already has an empty sourcing cycle.");
      if (detail.cycle >= 100)
        throw new HttpError(422, "This transaction supports up to 100 retained cycles.");
      await db.query(
        "update aerion.transaction_cases set cycle=cycle+1,status='Sourcing',context_hash=$1,next_action=$2,due_on=null,completed_on=null,completion_source_id=null,transaction_kind=$5 where workspace_id=$3 and deal_id=$4",
        [context.contextHash, action.nextAction, scope.workspaceId, id, context.transactionKind],
      );
      await mutateWorkspaceInTransaction(
        db,
        scope,
        {
          type: "deal",
          item: { ...context.deal, stage: "Sourcing", nextAction: action.nextAction },
        },
        context.workspace.revision,
      );
      auditDetail = {
        ...auditDetail,
        from: detail.status,
        previousCycle: detail.cycle,
        cycle: detail.cycle + 1,
        sourceId: action.sourceId,
        occurredOn: action.occurredOn,
      };
    }
    await db.query(
      "update aerion.transaction_cases set revision=revision+1,updated_at=now() where workspace_id=$1 and deal_id=$2",
      [scope.workspaceId, id],
    );
    await audit(db, scope, `transaction.${action.kind}`, id, auditDetail);
    await db.query(
      "insert into aerion.transaction_requests(workspace_id,deal_id,idempotency_key,payload_hash) values($1,$2,$3,$4)",
      [scope.workspaceId, id, key, payloadHash],
    );
    return { reused: false };
  });
  return { ...result, detail: await readTransaction(scope, id) };
}
