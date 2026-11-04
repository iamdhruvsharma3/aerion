import { randomUUID, createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
  communicationActionSchema,
  suppressionDecisionSchema,
  type CommunicationMessage,
  type CommunicationDetail,
  type CommunicationInboxData,
} from "../../lib/communication/schema";
import { agentProviderIds } from "../../lib/agents/providers";
import { runInputSchema } from "../../lib/agents/schema";
import { audit, transaction, type Scope } from "../db";
import { HttpError } from "../http";
import { createSource } from "../repository";
import { parseEmail } from "../agents/email-parser";
import { mailConfiguration } from "../agents/mail-config";
import { providerConfiguration } from "../agents/providers";
import { enqueueAgentInTransaction } from "../agents/repository";
import { fingerprint } from "../agents/evidence";
import { leadEnvelope, leadDraftMaterial } from "../leads/drafts";
import { documentPages } from "../documents";

const columns = `m.id,m.source_id as "sourceId",m.message_id as "messageId",m.sender,m.recipients,m.subject,m.in_reply_to as "inReplyTo",m.reference_ids as "references",m.direction,m.classification,m.suggested_lead_ids as "suggestedLeadIds",m.matched_delivery_ids as "matchedDeliveryIds",m.routing_basis as "routingBasis",m.state,m.lead_id as "leadId",m.revision,m.review_note as "reviewNote",m.created_at as "createdAt",m.updated_at as "updatedAt"`;
const leadColumns = `l.id,l.values->>'organization' as organization,l.values->>'aircraftModel' as "aircraftModel",l.values->>'side' as side,c.status`;
const address = (value: string) => value.trim().toLowerCase();
type ParsedEmail = Awaited<ReturnType<typeof parseEmail>>;

/** Routing suggestions only. A matching header never establishes the sender's authority or identity. */
export function correlateReply(
  parsed: Pick<ParsedEmail, "inReplyTo" | "references" | "from" | "recipients" | "classification">,
  deliveries: {
    id: string;
    messageId: string;
    sender: string;
    recipient: string;
    leadId: string | null;
  }[],
) {
  const ids = new Set([...parsed.inReplyTo, ...parsed.references]);
  const exact = deliveries.filter((delivery) => ids.has(delivery.messageId));
  const matching =
    parsed.classification === "Message"
      ? exact.filter(
          (delivery) =>
            address(parsed.from) === address(delivery.recipient) &&
            parsed.recipients.some((to) => address(to) === address(delivery.sender)),
        )
      : [];
  const leadIds = [
    ...new Set(matching.flatMap((delivery) => (delivery.leadId ? [delivery.leadId] : []))),
  ];
  return {
    matchedDeliveryIds: [...new Set(exact.map((delivery) => delivery.id))],
    suggestedLeadIds: leadIds,
    state:
      leadIds.length === 1
        ? ("Suggested" as const)
        : leadIds.length > 1
          ? ("Ambiguous" as const)
          : ("Unassigned" as const),
    routingBasis: leadIds.length
      ? "Exact reply/reference header and sender/recipient addresses match accepted outbound mail. Review the original before linking; headers are not authentication."
      : exact.length
        ? "A reply header matches outbound mail, but the address relationship or message type does not establish a unique lead. Assign after reviewing the original."
        : "No unique accepted outbound thread matched. Review and assign a saved lead manually.",
  };
}

export async function registerRetainedEmail(scope: Scope, sourceId: string, parsed: ParsedEmail) {
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    await db.query("select id from aerion.workspaces where id=$1 for update", [scope.workspaceId]);
    const source = (
      await db.query("select id,content_type from aerion.sources where workspace_id=$1 and id=$2", [
        scope.workspaceId,
        sourceId,
      ])
    ).rows[0];
    if (!source) throw new HttpError(404, "Retained email not found in this workspace.");
    if (source.content_type !== "message/rfc822")
      throw new HttpError(422, "Communication intake requires a retained RFC822 email.");
    const prior = (
      await db.query(
        "select id from aerion.communication_messages where workspace_id=$1 and source_id=$2",
        [scope.workspaceId, sourceId],
      )
    ).rows[0];
    if (prior) return { id: prior.id as string, reused: true };
    const ids = [...new Set([...parsed.inReplyTo, ...parsed.references])];
    const deliveries = ids.length
      ? (
          await db.query(
            `select d.id,d.message_id as "messageId",d.sender,d.recipient,coalesce(ld.lead_id,c.lead_id) as "leadId" from aerion.mail_deliveries d left join aerion.lead_drafts ld on ld.id=d.lead_draft_id and ld.workspace_id=d.workspace_id left join aerion.lead_cases c on c.requirement_id=d.requirement_id and c.workspace_id=d.workspace_id where d.workspace_id=$1 and d.status='accepted' and d.message_id=any($2::text[])`,
            [scope.workspaceId, ids],
          )
        ).rows
      : [];
    const correlation = correlateReply(parsed, deliveries),
      id = randomUUID();
    await db.query(
      "insert into aerion.communication_messages(id,workspace_id,source_id,message_id,sender,recipients,subject,in_reply_to,reference_ids,direction,classification,suggested_lead_ids,matched_delivery_ids,routing_basis,state) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
      [
        id,
        scope.workspaceId,
        sourceId,
        parsed.messageId,
        parsed.from,
        JSON.stringify(parsed.recipients),
        parsed.subject,
        JSON.stringify(parsed.inReplyTo),
        JSON.stringify(parsed.references),
        parsed.direction ?? "Unknown",
        parsed.classification,
        JSON.stringify(correlation.suggestedLeadIds),
        JSON.stringify(correlation.matchedDeliveryIds),
        correlation.routingBasis,
        correlation.state,
      ],
    );
    await audit(db, scope, "communication.retained", id, { sourceId, state: correlation.state });
    return { id, reused: false };
  });
}

async function sourceWithDuplicate(scope: Scope, input: Parameters<typeof createSource>[1]) {
  try {
    return await createSource(scope, input);
  } catch (error) {
    if (!(error instanceof HttpError && error.status === 409)) throw error;
    const sha256 = createHash("sha256").update(input.original).digest("hex");
    const prior = await transaction(
      scope.actorId,
      scope.workspaceId,
      async (db) =>
        (
          await db.query("select id from aerion.sources where workspace_id=$1 and sha256=$2", [
            scope.workspaceId,
            sha256,
          ])
        ).rows[0],
    );
    if (!prior) throw error;
    return { id: prior.id as string };
  }
}
export async function retainEmailUpload(
  scope: Scope,
  original: Buffer,
  filename: string,
  options?: { title?: string; sourceUrl?: string | null },
) {
  const parsed = await parseEmail(original),
    issues: string[] = [];
  const source = await sourceWithDuplicate(scope, {
    title: options?.title ?? parsed.subject,
    kind: "text",
    sourceUrl: options?.sourceUrl ?? null,
    filename: filename.slice(0, 200),
    contentType: "message/rfc822",
    original,
    pages: [{ page: 1, text: parsed.text }],
  });
  for (const attachment of parsed.email.attachments.slice(0, 4)) {
    const name = (attachment.filename ?? "").replace(/[\\/]/g, "_").slice(0, 180);
    if (!/\.(pdf|csv|txt)$/i.test(name)) {
      issues.push(`${name || attachment.mimeType} remains in the original email.`);
      continue;
    }
    const bytes =
      typeof attachment.content === "string"
        ? Buffer.from(attachment.content, attachment.encoding === "base64" ? "base64" : "utf8")
        : attachment.content instanceof Uint8Array
          ? Buffer.from(attachment.content)
          : Buffer.from(attachment.content);
    if (bytes.length > 2_000_000) {
      issues.push(`${name} exceeds the 2 MB attachment limit.`);
      continue;
    }
    try {
      const kind = /\.pdf$/i.test(name) ? "pdf" : /\.csv$/i.test(name) ? "csv" : "text";
      const child = await sourceWithDuplicate(scope, {
        title: `${parsed.subject} · ${name}`.slice(0, 300),
        kind,
        sourceUrl: null,
        filename: name,
        contentType: attachment.mimeType,
        original: bytes,
        pages: await documentPages(bytes, kind),
      });
      await transaction(scope.actorId, scope.workspaceId, (db) =>
        db.query(
          "insert into aerion.source_links(workspace_id,parent_id,child_id,relation) values($1,$2,$3,'attachment') on conflict do nothing",
          [scope.workspaceId, source.id, child.id],
        ),
      );
    } catch (error) {
      issues.push(
        error instanceof HttpError
          ? `${name}: ${error.message}`
          : `${name} needs a separate readable document import.`,
      );
    }
  }
  const message = await registerRetainedEmail(scope, source.id, parsed);
  return { ...message, sourceId: source.id, issues };
}

export async function readCommunicationInbox(scope: Scope): Promise<CommunicationInboxData> {
  const data = await transaction(scope.actorId, scope.workspaceId, async (db) => {
    const messages = (
      await db.query(
        `select ${columns} from aerion.communication_messages m where m.workspace_id=$1 order by m.created_at desc,m.id limit 200`,
        [scope.workspaceId],
      )
    ).rows;
    const grouped = (
      await db.query(
        "select state,count(*)::int as n from aerion.communication_messages where workspace_id=$1 group by state",
        [scope.workspaceId],
      )
    ).rows;
    return {
      messages,
      leads: (
        await db.query(
          `select ${leadColumns} from aerion.discovery_leads l join aerion.lead_cases c on c.lead_id=l.id and c.workspace_id=l.workspace_id where l.workspace_id=$1 and c.status<>'Dismissed' order by l.created_at desc limit 500`,
          [scope.workspaceId],
        )
      ).rows,
      counts: Object.fromEntries(
        ["Unassigned", "Suggested", "Ambiguous", "Linked", "Dismissed"].map((state) => [
          state,
          grouped.find((row) => row.state === state)?.n ?? 0,
        ]),
      ),
      suppressions: (
        await db.query(
          'select email,reason,source_id as "sourceId",active,revision,review_note as "reviewNote",updated_at as "updatedAt" from aerion.communication_suppressions where workspace_id=$1 order by updated_at desc limit 500',
          [scope.workspaceId],
        )
      ).rows,
    };
  });
  return {
    ...data,
    counts: data.counts as CommunicationInboxData["counts"],
    providers: agentProviderIds.map((id) => ({ id, ...providerConfiguration(id) })),
    mailbox: mailConfiguration(scope).mailbox,
  };
}
async function lockedMessage(db: PoolClient, scope: Scope, id: string, revision?: number) {
  const row = (
    await db.query(
      `select ${columns} from aerion.communication_messages m where m.workspace_id=$1 and m.id=$2 for update`,
      [scope.workspaceId, id],
    )
  ).rows[0] as CommunicationMessage | undefined;
  if (!row) throw new HttpError(404, "Message not found in this workspace.");
  if (revision !== undefined && row.revision !== revision)
    throw new HttpError(409, "This message changed. Refresh before deciding.");
  return row;
}
async function retainedSources(db: PoolClient, scope: Scope, sourceId: string) {
  return (
    await db.query(
      "select id,title,filename,content_type as \"contentType\",pages from aerion.sources where workspace_id=$1 and (id=$2 or id in(select child_id from aerion.source_links where workspace_id=$1 and parent_id=$2 and relation='attachment')) order by created_at,id limit 20",
      [scope.workspaceId, sourceId],
    )
  ).rows;
}
export async function readCommunicationMessage(
  scope: Scope,
  id: string,
): Promise<CommunicationDetail> {
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    const message = await lockedMessage(db, scope, id),
      sources = await retainedSources(db, scope, message.sourceId);
    const original = sources.find((source) => source.id === message.sourceId);
    const lead = message.leadId ? await leadEnvelope(db, scope, message.leadId) : null;
    const analysisRuns = (
      await db.query(
        `select r.id,r.agent_id as "agentId",r.status,r.created_at as "createdAt",a.kind,a.lead_id as "leadId",a.prior_requirement_id as "priorRequirementId",coalesce((select jsonb_agg(jsonb_build_object('id',p.id,'title',p.title,'status',p.status,'appliedRef',p.applied_ref,'type',p.action->>'type')) from aerion.agent_proposals p where p.workspace_id=r.workspace_id and p.run_id=r.id),'[]'::jsonb) as proposals from aerion.communication_analyses a join aerion.agent_runs r on r.id=a.run_id and r.workspace_id=a.workspace_id where a.workspace_id=$1 and a.message_id=$2 order by a.created_at desc limit 30`,
        [scope.workspaceId, id],
      )
    ).rows;
    return {
      ...message,
      text: original?.pages.map((p: { text: string }) => p.text).join("\n\n") ?? "",
      title: original?.title ?? message.subject,
      attachments: sources
        .filter((source) => source.id !== message.sourceId)
        .map(({ id, title, filename, contentType }) => ({ id, title, filename, contentType })),
      lead: lead
        ? {
            id: lead.lead.id,
            organization: lead.lead.values.organization,
            aircraftModel: lead.lead.values.aircraftModel,
            side: lead.lead.values.side,
            status: lead.row.status,
          }
        : null,
      leadRevision: lead?.row.revision ?? null,
      currentRequirementId: lead?.requirement?.id ?? null,
      analysisRuns,
      revisions: (
        await db.query(
          'select id,prior_requirement_id as "priorRequirementId",requirement_id as "requirementId",review_note as "reviewNote",created_at as "createdAt" from aerion.communication_brief_revisions where workspace_id=$1 and message_id=$2 order by created_at desc',
          [scope.workspaceId, id],
        )
      ).rows,
      assignmentCorrections: (
        await db.query(
          `select c.id,c.prior_lead_id as "priorLeadId",c.lead_id as "leadId",c.prior_requirement_id as "priorRequirementId",p.values->>'organization' as "priorOrganization",l.values->>'organization' as organization,c.review_note as "reviewNote",c.created_at as "createdAt" from aerion.communication_assignment_corrections c join aerion.discovery_leads p on p.id=c.prior_lead_id and p.workspace_id=c.workspace_id join aerion.discovery_leads l on l.id=c.lead_id and l.workspace_id=c.workspace_id where c.workspace_id=$1 and c.message_id=$2 order by c.created_at desc,c.id desc limit 50`,
          [scope.workspaceId, id],
        )
      ).rows,
    };
  });
}

export async function actOnCommunication(scope: Scope, id: string, raw: unknown) {
  const input = communicationActionSchema.parse(raw);
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    await db.query("select id from aerion.workspaces where id=$1 for update", [scope.workspaceId]);
    const message = await lockedMessage(db, scope, id, input.revision);
    let result: Record<string, unknown> = {};
    if (input.kind === "link" || input.kind === "correct-link") {
      if (input.kind === "link" && message.state === "Linked")
        throw new HttpError(
          409,
          "This reply is already linked. Use the reviewed correction action to change its current assignment.",
        );
      if (input.kind === "correct-link" && (message.state !== "Linked" || !message.leadId))
        throw new HttpError(422, "Only a linked reply has an assignment to correct.");
      if (input.kind === "correct-link" && message.leadId === input.leadId)
        throw new HttpError(422, "Choose a different saved lead for an assignment correction.");
      if (message.state === "Dismissed")
        throw new HttpError(422, "Reopen this message before linking it.");
      const lead = await leadEnvelope(db, scope, input.leadId, true);
      if (lead.row.status === "Dismissed")
        throw new HttpError(422, "Reopen the selected lead before linking a reply.");
      const sources = await retainedSources(db, scope, message.sourceId);
      if (input.kind === "correct-link" && message.leadId) {
        const prior = await leadEnvelope(db, scope, message.leadId, true);
        const correctionId = randomUUID();
        await db.query(
          "insert into aerion.communication_assignment_corrections(id,workspace_id,message_id,prior_lead_id,lead_id,prior_requirement_id,source_ids,reviewer,review_note) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            correctionId,
            scope.workspaceId,
            id,
            message.leadId,
            input.leadId,
            prior.requirement?.id ?? null,
            JSON.stringify(sources.map((source) => source.id)),
            scope.actorId,
            input.note,
          ],
        );
        const affected = (
          await db.query(
            "update aerion.agent_runs set status='cancelled',revision=revision+1,lease_token=null,finished_at=now(),error='The reply assignment was corrected. Analyze the reply from its current lead.' where workspace_id=$1 and id in(select run_id from aerion.communication_analyses where workspace_id=$1 and message_id=$2 and lead_id=$3) and status in ('queued','running','review') returning id",
            [scope.workspaceId, id, message.leadId],
          )
        ).rows;
        await db.query(
          "update aerion.agent_proposals set status='obsolete',resolution_note=$1,reviewer=$2,resolved_at=now() where workspace_id=$3 and run_id in(select run_id from aerion.communication_analyses where workspace_id=$3 and message_id=$4 and lead_id=$5) and status='proposed'",
          [
            "The reply was assigned to a different lead after review. Analyze its current assignment.",
            scope.actorId,
            scope.workspaceId,
            id,
            message.leadId,
          ],
        );
        await db.query(
          "update aerion.lead_cases set next_action=$1,revision=revision+1,updated_at=now() where workspace_id=$2 and lead_id=$3",
          [
            `Review corrected reply assignment; prior briefs and opportunities need fresh evidence. ${prior.row.next_action ?? ""}`.slice(
              0,
              500,
            ),
            scope.workspaceId,
            message.leadId,
          ],
        );
        await audit(db, scope, "communication.assignment-corrected", id, {
          correctionId,
          priorLeadId: message.leadId,
          leadId: input.leadId,
          priorRequirementId: prior.requirement?.id ?? null,
          sourceIds: sources.map((source) => source.id),
          cancelledRunIds: affected.map((row) => row.id),
          priorNextAction: prior.row.next_action,
          note: input.note,
        });
      }
      for (const source of sources)
        await db.query(
          "insert into aerion.lead_sources(workspace_id,lead_id,source_id,purpose) values($1,$2,$3,$4) on conflict do nothing",
          [
            scope.workspaceId,
            input.leadId,
            source.id,
            lead.lead.values.side === "Buyer" && message.classification === "Message"
              ? "Buyer brief"
              : "Other",
          ],
        );
      await db.query(
        "update aerion.lead_cases set revision=revision+1,updated_at=now() where workspace_id=$1 and lead_id=$2",
        [scope.workspaceId, input.leadId],
      );
      await db.query(
        "update aerion.communication_messages set state='Linked',lead_id=$1,reviewer=$2,review_note=$3,revision=revision+1,updated_at=now() where workspace_id=$4 and id=$5",
        [input.leadId, scope.actorId, input.note, scope.workspaceId, id],
      );
      result = { leadId: input.leadId };
    } else if (input.kind === "dismiss" || input.kind === "reopen") {
      if (message.state === "Linked")
        throw new HttpError(422, "A linked reply remains part of its reviewed lead history.");
      if (input.kind === "reopen" && message.state !== "Dismissed")
        throw new HttpError(422, "Only dismissed messages can be reopened.");
      const state =
        input.kind === "dismiss"
          ? "Dismissed"
          : message.suggestedLeadIds.length === 1
            ? "Suggested"
            : message.suggestedLeadIds.length > 1
              ? "Ambiguous"
              : "Unassigned";
      await db.query(
        "update aerion.communication_messages set state=$1,revision=revision+1,reviewer=$2,review_note=$3,updated_at=now() where workspace_id=$4 and id=$5",
        [state, scope.actorId, input.note, scope.workspaceId, id],
      );
    } else if (input.kind === "suppress") {
      const email = address(input.email);
      const parties = new Set([message.sender, ...message.recipients].map(address));
      if (!parties.has(email))
        throw new HttpError(
          422,
          "Choose an address stated in this retained message. A delivery failure recipient may need a separate retained source.",
        );
      await db.query(
        "insert into aerion.communication_suppressions(workspace_id,email,source_id,reason,reviewer,review_note) values($1,$2,$3,$4,$5,$6) on conflict(workspace_id,email) do update set active=true,revision=aerion.communication_suppressions.revision+1,reviewer=excluded.reviewer,review_note=excluded.review_note,updated_at=now()",
        [scope.workspaceId, email, message.sourceId, input.reason, scope.actorId, input.note],
      );
      result = { email };
    } else {
      if (message.state !== "Linked" || !message.leadId)
        throw new HttpError(422, "Review and link this reply before analysis or drafting.");
      if (message.classification !== "Message")
        throw new HttpError(
          422,
          "Automated responses and delivery reports cannot establish a buyer brief. Review the original and record any contact restriction.",
        );
      const lead = await leadEnvelope(db, scope, message.leadId, true);
      if (lead.row.status === "Dismissed")
        throw new HttpError(422, "Reopen this lead before processing a reply.");
      const sources = await retainedSources(db, scope, message.sourceId);
      if (input.kind === "analyze") {
        const buyer = lead.lead.values.side === "Buyer",
          kind = buyer ? (lead.requirement ? "Revised brief" : "Initial brief") : "Communication";
        const queued = await enqueueAgentInTransaction(
          db,
          scope,
          runInputSchema.parse({
            agentId: buyer ? "buyer-requirements" : "communication",
            provider: input.provider,
            aircraftId: null,
            requirementId: null,
            contactId: null,
            sourceIds: sources.map((source) => source.id),
            connectorIds: [],
            allowExternalSources: false,
            allowModelData: input.allowModelData,
            allowMailbox: false,
            idempotencyKey: input.idempotencyKey,
            ...(buyer && !lead.requirement ? { leadId: message.leadId } : {}),
            objective: buyer
              ? `Analyze only the retained reply and its selected attachments for lead ${message.leadId}. ${lead.requirement ? "This is a possible revised brief: propose a separate Draft requirement. It must be complete and fully supported by this reply; do not copy missing values from older records. The founder will separately decide whether to replace the current brief." : "Propose a source-backed Draft buyer requirement bound to the selected lead only when required constraints are explicit."} Identify missing or conflicting constraints as clarification questions. Header addresses are not sender authentication or mandate confirmation.`
              : "Inspect only the selected retained reply and attachments. Identify explicit changed availability, document requests and clarification questions. Do not infer sender authority or overwrite approved facts.",
          }),
        );
        await db.query(
          "insert into aerion.communication_analyses(workspace_id,message_id,run_id,lead_id,prior_requirement_id,kind) values($1,$2,$3,$4,$5,$6) on conflict do nothing",
          [scope.workspaceId, id, queued.id, message.leadId, lead.requirement?.id ?? null, kind],
        );
        result = { runId: queued.id, reused: queued.reused };
      } else if (input.kind === "clarify") {
        const material = leadDraftMaterial(lead);
        const subject = `Clarification requested · ${lead.lead.values.aircraftModel ?? "aircraft sourcing"}`;
        const body = `Hello ${lead.contact?.name},\n\nThank you for your message regarding ${lead.lead.values.aircraftModel ?? "aircraft sourcing"}. To prepare a current, complete sourcing brief, could you please confirm the following together in one reply?\n\n${lead.lead.values.side === "Buyer" ? "- Buyer / represented organization and your role\n- Aircraft family and transaction type (purchase or lease)\n- Quantity and minimum acceptable build year\n- Engine, configuration and other firm constraints\n- Budget amount, currency and whether it applies per aircraft\n- Delivery deadline and destination\n- Whether this is a current requirement and the submission process" : "- Current aircraft availability and the authority under which it is offered\n- Manufacturer, model, serial/registration and build year\n- Engine/configuration, hours/cycles and current specification\n- Maintenance records and known limitations\n- Asking terms, currency, location and available date"}\n\nPlease identify any detail that remains undecided or supersedes earlier correspondence.\n\nRegards,\nAerion`;
        const key = fingerprint({ hash: material.contextHash, subject, body });
        const existing = (
          await db.query(
            "select id from aerion.lead_drafts where workspace_id=$1 and lead_id=$2 and draft_key=$3",
            [scope.workspaceId, message.leadId, key],
          )
        ).rows[0];
        const draftId = existing?.id ?? randomUUID();
        if (!existing) {
          if (
            (
              await db.query(
                "select count(*)::int as n from aerion.lead_drafts where workspace_id=$1 and lead_id=$2",
                [scope.workspaceId, message.leadId],
              )
            ).rows[0].n >= 100
          )
            throw new HttpError(422, "This lead supports up to 100 retained draft versions.");
          await db.query(
            "insert into aerion.lead_drafts(id,workspace_id,lead_id,contact_id,recipient,subject,body,context_hash,draft_key) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [
              draftId,
              scope.workspaceId,
              message.leadId,
              lead.contact?.id,
              material.recipient,
              subject,
              body,
              material.contextHash,
              key,
            ],
          );
        }
        await db.query(
          "update aerion.lead_cases set revision=revision+1,updated_at=now() where workspace_id=$1 and lead_id=$2",
          [scope.workspaceId, message.leadId],
        );
        result = { draftId, leadId: message.leadId };
      } else if (input.kind === "use-revision") {
        if (lead.row.revision !== input.leadRevision)
          throw new HttpError(409, "The lead changed. Refresh before using a revised brief.");
        const analysis = (
          await db.query(
            "select * from aerion.communication_analyses where workspace_id=$1 and message_id=$2 and run_id=$3 and lead_id=$4 and kind='Revised brief'",
            [scope.workspaceId, id, input.runId, message.leadId],
          )
        ).rows[0];
        if (!analysis || !lead.requirement || analysis.prior_requirement_id !== lead.requirement.id)
          throw new HttpError(
            409,
            "This analysis no longer describes the current buyer brief. Analyze the reply against current context.",
          );
        const proposal = (
          await db.query(
            "select p.action,p.applied_ref,p.citations,r.input from aerion.agent_proposals p join aerion.agent_runs r on r.id=p.run_id and r.workspace_id=p.workspace_id where p.workspace_id=$1 and p.run_id=$2 and p.id=$3 and p.status='accepted' and r.agent_id='buyer-requirements'",
            [scope.workspaceId, input.runId, input.proposalId],
          )
        ).rows[0];
        const next = lead.data.requirements.find(
          (requirement) => requirement.id === proposal?.applied_ref,
        );
        if (
          proposal?.action.type !== "requirement" ||
          proposal.action.leadId ||
          !next ||
          next.status !== "Draft" ||
          !proposal.citations.length ||
          proposal.citations.some(
            (citation: { sourceId: string }) =>
              !proposal.input.sourceIds.includes(citation.sourceId),
          )
        )
          throw new HttpError(
            422,
            "Accept this reply's source-backed Draft requirement proposal before using it as a revision.",
          );
        if (lead.data.deals.some((deal) => deal.requirementId === next.id))
          throw new HttpError(
            422,
            "A revised brief already connected to an opportunity cannot replace this requirement.",
          );
        if (
          (
            await db.query(
              "select lead_id from aerion.lead_cases where workspace_id=$1 and requirement_id=$2 and lead_id<>$3",
              [scope.workspaceId, next.id, message.leadId],
            )
          ).rows.length
        )
          throw new HttpError(422, "This Draft brief is already connected to another lead.");
        const confirmation = (
          await db.query(
            "select confirmation from aerion.execution_cases where workspace_id=$1 and requirement_id=$2",
            [scope.workspaceId, next.id],
          )
        ).rows[0];
        if (confirmation?.confirmation)
          throw new HttpError(
            422,
            "The replacement brief must require a fresh founder confirmation.",
          );
        await db.query(
          "insert into aerion.communication_brief_revisions(id,workspace_id,message_id,run_id,lead_id,prior_requirement_id,requirement_id,reviewer,review_note) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            randomUUID(),
            scope.workspaceId,
            id,
            input.runId,
            message.leadId,
            lead.requirement.id,
            next.id,
            scope.actorId,
            input.note,
          ],
        );
        await db.query(
          "update aerion.lead_cases set requirement_id=$1,status='Qualifying',revision=revision+1,updated_at=now() where workspace_id=$2 and lead_id=$3",
          [next.id, scope.workspaceId, message.leadId],
        );
        result = {
          leadId: message.leadId,
          requirementId: next.id,
          priorRequirementId: lead.requirement.id,
        };
      }
    }
    await audit(db, scope, `communication.${input.kind}`, id, {
      ...result,
      note: "note" in input ? input.note : undefined,
    });
    return result;
  });
}

export async function decideSuppression(scope: Scope, raw: unknown) {
  const input = suppressionDecisionSchema.parse(raw),
    email = address(input.email);
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    await db.query("select id from aerion.workspaces where id=$1 for update", [scope.workspaceId]);
    const row = (
      await db.query(
        "select revision from aerion.communication_suppressions where workspace_id=$1 and email=$2 for update",
        [scope.workspaceId, email],
      )
    ).rows[0];
    if (!row) throw new HttpError(404, "Contact restriction not found.");
    if (row.revision !== input.revision)
      throw new HttpError(409, "The restriction changed. Refresh before deciding.");
    await db.query(
      "update aerion.communication_suppressions set active=$1,revision=revision+1,reviewer=$2,review_note=$3,updated_at=now() where workspace_id=$4 and email=$5",
      [input.active, scope.actorId, input.note, scope.workspaceId, email],
    );
    await audit(db, scope, "communication.suppression-reviewed", null, {
      email,
      active: input.active,
      note: input.note,
    });
    return { email, active: input.active };
  });
}
