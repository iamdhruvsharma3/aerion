import type { PoolClient } from "pg";
import type { DiscoveryLead } from "../../lib/discovery/schema";
import type { LeadDraft } from "../../lib/leads/schema";
import { workspaceSchema } from "../../lib/schema";
import type { Scope } from "../db";
import { HttpError } from "../http";
import { fingerprint } from "../agents/evidence";
import { replyAssignmentVersion } from "../communication/context";

export async function leadEnvelope(db: PoolClient, scope: Scope, id: string, lock = false) {
  const row = (
    await db.query(
      `select l.id,l.run_id as "runId",l.source_id as "sourceId",l.url,l.values,l.citations,l.created_at as "createdAt",c.revision,c.status,c.contact_id,c.requirement_id,c.next_action,to_char(c.due_on,'YYYY-MM-DD') as due_on from aerion.discovery_leads l join aerion.lead_cases c on c.lead_id=l.id and c.workspace_id=l.workspace_id where l.workspace_id=$1 and l.id=$2 ${lock ? "for update of c" : ""}`,
      [scope.workspaceId, id],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, "Saved lead not found in this workspace.");
  const data = workspaceSchema.parse(
    (await db.query("select data from aerion.workspaces where id=$1", [scope.workspaceId])).rows[0]
      ?.data,
  );
  const lead: DiscoveryLead = {
    id: row.id,
    runId: row.runId,
    sourceId: row.sourceId,
    url: row.url,
    values: row.values,
    citations: row.citations,
    createdAt: row.createdAt,
  };
  return {
    row,
    lead,
    data,
    replyAssignmentVersion: await replyAssignmentVersion(db, scope, id),
    contact: data.contacts.find((c) => c.id === row.contact_id) ?? null,
    requirement: data.requirements.find((r) => r.id === row.requirement_id) ?? null,
  };
}
export function leadDraftMaterial(context: Awaited<ReturnType<typeof leadEnvelope>>) {
  const { lead, contact, requirement, row } = context;
  if (!contact)
    throw new HttpError(422, "Connect a reviewed business contact before preparing outreach.");
  if (row.status === "Dismissed")
    throw new HttpError(422, "Reopen this lead before preparing outreach.");
  if (![lead.values.side, "Broker"].includes(contact.type))
    throw new HttpError(
      422,
      "Choose a contact on the lead's buyer/seller side, or a broker contact.",
    );
  const subject =
    `Aircraft ${lead.values.side === "Buyer" ? "requirements" : "availability"} enquiry${lead.values.aircraftModel ? ` · ${lead.values.aircraftModel}` : ""}`.replace(
      /[\r\n]+/g,
      " ",
    );
  const questions =
    lead.values.side === "Buyer"
      ? `Could you confirm whether your team has a current acquisition or lease requirement${lead.values.aircraftModel ? ` for ${lead.values.aircraftModel}` : ""}? If so, please share the aircraft family, quantity, minimum build year, engine or configuration constraints, budget and currency, timing, and destination. Please also clarify whom you represent and how suitable aircraft should be submitted.`
      : `Could you confirm whether the aircraft referenced is still available? Please share the current specification, serial/registration, build year, engine configuration, reported hours/cycles, maintenance records, location, asking terms and currency, and the authority under which it is offered.`;
  return {
    recipient: contact.email,
    subject,
    body: `Hello ${contact.name},\n\nI am checking a public aircraft sourcing signal that may relate to your team.\nPublic reference: ${lead.url}\n\n${questions}\n\nPlease correct any outdated information in the public reference.\n\nRegards,\nAerion`,
    contextHash: fingerprint({
      leadId: lead.id,
      values: lead.values,
      url: lead.url,
      contact,
      status: row.status,
      requirement: requirement ? { id: requirement.id, status: requirement.status } : null,
      template: "lead-qualification-v1",
      ...(context.replyAssignmentVersion ? { replyAssignmentVersion: context.replyAssignmentVersion } : {}),
    }),
  };
}
export const leadDraftColumns =
  'id,lead_id as "leadId",contact_id as "contactId",recipient,subject,body,context_hash as "contextHash",status,review_note as "reviewNote",created_at as "createdAt",reviewed_at as "reviewedAt"';
export async function readLeadDraftInTransaction(
  db: PoolClient,
  scope: Scope,
  id: string,
): Promise<LeadDraft> {
  const draft = (
    await db.query(
      `select ${leadDraftColumns} from aerion.lead_drafts where workspace_id=$1 and id=$2`,
      [scope.workspaceId, id],
    )
  ).rows[0];
  if (!draft) throw new HttpError(404, "Lead draft not found.");
  const context = await leadEnvelope(db, scope, draft.leadId);
  let stale = true;
  try {
    stale = leadDraftMaterial(context).contextHash !== draft.contextHash;
  } catch {
    /* A removed contact or dismissed lead invalidates the saved context. */
  }
  return { ...draft, stale };
}
