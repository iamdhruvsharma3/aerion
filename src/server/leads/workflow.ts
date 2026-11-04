import { randomUUID } from "node:crypto";
import { leadCaseActionSchema, type LeadCase } from "../../lib/leads/schema";
import { transaction, audit, type Scope } from "../db";
import { HttpError } from "../http";
import { mutateWorkspaceInTransaction } from "../repository";
import { readExecutionInTransaction, mutateExecutionInTransaction } from "../execution";
import { fingerprint } from "../agents/evidence";
import { leadEnvelope, leadDraftMaterial, leadDraftColumns } from "./drafts";
import { retiredReplySourceIds } from "../communication/context";

export async function readLeadCase(scope: Scope, id: string): Promise<LeadCase> {
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    const context = await leadEnvelope(db, scope, id),
      { lead, row, contact, requirement } = context;
    const desk = requirement ? await readExecutionInTransaction(db, scope, requirement.id) : null;
    const sources = (
      await db.query(
        'select s.id,s.title,l.purpose,s.source_url as "sourceUrl",s.created_at as "createdAt" from aerion.lead_sources l join aerion.sources s on s.id=l.source_id and s.workspace_id=l.workspace_id where l.workspace_id=$1 and l.lead_id=$2 order by l.created_at desc',
        [scope.workspaceId, id],
      )
    ).rows;
    const retired = await retiredReplySourceIds(db, scope, id);
    const availableSources = (
      await db.query(
        "select id,title from aerion.sources where workspace_id=$1 order by created_at desc limit 500",
        [scope.workspaceId],
      )
    ).rows;
    const enrichments = (
      await db.query(
        'select id,source_id as "sourceId",values,citations,created_at as "createdAt" from aerion.lead_enrichments where workspace_id=$1 and lead_id=$2 order by created_at desc limit 40',
        [scope.workspaceId, id],
      )
    ).rows;
    const drafts = (
      await db.query(
        `select ${leadDraftColumns} from aerion.lead_drafts where workspace_id=$1 and lead_id=$2 order by created_at desc limit 40`,
        [scope.workspaceId, id],
      )
    ).rows;
    let hash: string | null = null;
    try {
      hash = leadDraftMaterial(context).contextHash;
    } catch {
      /* Readiness below explains the missing input. */
    }
    const runs = (
      await db.query(
        'select id,agent_id as "agentId",provider,model,status,input,attempts,revision,report,error,usage,created_at as "createdAt",finished_at as "finishedAt" from aerion.agent_runs where workspace_id=$1 and input->>\'leadId\'=$2 order by created_at desc limit 30',
        [scope.workspaceId, id],
      )
    ).rows;
    const activity = (
      await db.query(
        'select id,action,detail,created_at as "createdAt" from aerion.activity where workspace_id=$1 and record_id=$2 order by created_at desc limit 50',
        [scope.workspaceId, id],
      )
    ).rows;
    return {
      lead,
      revision: row.revision,
      status: row.status,
      nextAction: row.next_action,
      dueOn: row.due_on,
      contact,
      requirement,
      desk,
      sources: sources.map((source) => ({ ...source, retired: retired.has(source.id) })),
      availableSources,
      enrichments,
      drafts: drafts.map((draft) => ({ ...draft, stale: draft.contextHash !== hash })),
      runs,
      activity,
      readiness: [
        {
          key: "contact",
          title: "Business contact",
          ready: Boolean(contact),
          detail: contact
            ? contact.email
            : "Research published business details or connect an existing contact.",
        },
        {
          key: "brief",
          title: "Buyer brief",
          ready: Boolean(requirement),
          detail: requirement
            ? `${requirement.client} · ${requirement.status}`
            : "Attach the buyer's reply and extract its stated requirements, or record a draft brief.",
        },
        {
          key: "confirmation",
          title: "Current requirement",
          ready: Boolean(desk?.confirmation),
          detail: desk?.confirmation
            ? `Founder confirmation · ${desk.confirmation.confirmedOn}`
            : "Record who confirmed the need, when, and the basis.",
        },
        {
          key: "match",
          title: "Eligible aircraft",
          ready: Boolean(desk?.matches.some((m) => m.state === "eligible")),
          detail: desk
            ? `${desk.matches.filter((m) => m.state === "eligible").length} eligible · ${desk.matches.filter((m) => m.state === "needs-review").length} need more evidence`
            : "Approved inventory is evaluated against a saved requirement.",
        },
        {
          key: "opportunity",
          title: "Opportunity & offer",
          ready: Boolean(desk?.deals.length),
          detail: desk?.deals.length
            ? `${desk.deals.length} opportunity record(s)`
            : "A confirmed brief, eligible match and connected recipient unlock the handoff.",
        },
      ],
    };
  });
}
export async function mutateLeadCase(scope: Scope, id: string, revision: number, raw: unknown) {
  const action = leadCaseActionSchema.parse(raw);
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    const workspace = (
      await db.query("select revision from aerion.workspaces where id=$1 for update", [
        scope.workspaceId,
      ])
    ).rows[0];
    const context = await leadEnvelope(db, scope, id, true),
      { row, lead, contact, requirement, data } = context;
    if (row.revision !== revision)
      throw new HttpError(409, "This lead changed. Reload its workspace before retrying.");
    if (row.status === "Dismissed" && action.kind !== "update")
      throw new HttpError(422, "Reopen this lead before working on it.");
    let recordId: string = id;
    if (action.kind === "update") {
      await db.query(
        "update aerion.lead_cases set status=$1,next_action=$2,due_on=$3 where workspace_id=$4 and lead_id=$5",
        [action.status, action.nextAction, action.dueOn, scope.workspaceId, id],
      );
    } else if (action.kind === "create-contact" || action.kind === "link-contact") {
      if (action.kind === "create-contact") {
        if (data.contacts.some((c) => c.email.toLowerCase() === action.values.email.toLowerCase()))
          throw new HttpError(
            409,
            "This email is already in Contacts. Connect the existing contact instead.",
          );
        recordId = randomUUID();
        await mutateWorkspaceInTransaction(
          db,
          scope,
          { type: "contact", item: { ...action.values, id: recordId } },
          workspace.revision,
        );
      } else {
        if (!data.contacts.some((c) => c.id === action.contactId))
          throw new HttpError(404, "Contact not found.");
        recordId = action.contactId;
      }
      await db.query(
        "update aerion.lead_cases set contact_id=$1 where workspace_id=$2 and lead_id=$3",
        [recordId, scope.workspaceId, id],
      );
    } else if (action.kind === "create-requirement" || action.kind === "link-requirement") {
      if (lead.values.side !== "Buyer")
        throw new HttpError(422, "Buyer requirements belong to buyer-side leads.");
      if (row.requirement_id)
        throw new HttpError(
          409,
          "This lead already has a buyer brief. Continue in its execution desk.",
        );
      if (action.kind === "create-requirement") {
        recordId = randomUUID();
        await mutateWorkspaceInTransaction(
          db,
          scope,
          { type: "requirement", item: { ...action.values, id: recordId, status: "Draft" } },
          workspace.revision,
        );
      } else {
        if (!data.requirements.some((r) => r.id === action.requirementId))
          throw new HttpError(404, "Requirement not found.");
        recordId = action.requirementId;
      }
      await db.query(
        "update aerion.lead_cases set requirement_id=$1,status='Qualifying' where workspace_id=$2 and lead_id=$3",
        [recordId, scope.workspaceId, id],
      );
    } else if (action.kind === "confirm") {
      if (!requirement || lead.values.side !== "Buyer")
        throw new HttpError(422, "Save a buyer brief before confirming its current requirement.");
      const desk = await readExecutionInTransaction(db, scope, requirement.id);
      await mutateExecutionInTransaction(
        db,
        scope,
        requirement.id,
        { type: "confirm-brief", confirmation: action.confirmation, attested: true },
        desk.revision,
      );
      await db.query(
        "update aerion.lead_cases set status='Qualifying' where workspace_id=$1 and lead_id=$2",
        [scope.workspaceId, id],
      );
    } else if (action.kind === "attach-source") {
      const source = await db.query(
        "select id from aerion.sources where workspace_id=$1 and id=$2",
        [scope.workspaceId, action.sourceId],
      );
      if (!source.rows.length) throw new HttpError(404, "Source not found in this workspace.");
      await db.query(
        "insert into aerion.lead_sources(workspace_id,lead_id,source_id,purpose) values($1,$2,$3,$4) on conflict do nothing",
        [scope.workspaceId, id, action.sourceId, action.purpose],
      );
      recordId = action.sourceId;
    } else if (action.kind === "prepare-draft") {
      if (Boolean(action.subject) !== Boolean(action.body))
        throw new HttpError(422, "Provide both subject and message when saving an edited version.");
      const material = leadDraftMaterial(context),
        subject = (action.subject ?? material.subject).replace(/[\r\n]+/g, " "),
        body = action.body ?? material.body;
      const key = fingerprint({ hash: material.contextHash, subject, body });
      const prior = (
        await db.query(
          "select id from aerion.lead_drafts where workspace_id=$1 and lead_id=$2 and draft_key=$3",
          [scope.workspaceId, id, key],
        )
      ).rows[0];
      recordId = prior?.id ?? randomUUID();
      if (!prior) {
        const count = (
          await db.query(
            "select count(*)::int as n from aerion.lead_drafts where workspace_id=$1 and lead_id=$2",
            [scope.workspaceId, id],
          )
        ).rows[0].n;
        if (count >= 100)
          throw new HttpError(422, "This lead supports up to 100 retained draft versions.");
        await db.query(
          "insert into aerion.lead_drafts(id,workspace_id,lead_id,contact_id,recipient,subject,body,context_hash,draft_key) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",
          [
            recordId,
            scope.workspaceId,
            id,
            contact?.id,
            material.recipient,
            subject,
            body,
            material.contextHash,
            key,
          ],
        );
      }
    } else if (action.kind === "review-draft") {
      const draft = (
        await db.query(
          "select * from aerion.lead_drafts where workspace_id=$1 and lead_id=$2 and id=$3",
          [scope.workspaceId, id, action.draftId],
        )
      ).rows[0];
      if (!draft) throw new HttpError(404, "Draft not found in this lead.");
      if (draft.status === "Archived")
        throw new HttpError(409, "This draft is archived. Prepare a new version.");
      if (
        action.status === "Reviewed" &&
        leadDraftMaterial(context).contextHash !== draft.context_hash
      )
        throw new HttpError(
          422,
          "The contact or qualification context changed. Prepare a current draft before review.",
        );
      await db.query(
        "update aerion.lead_drafts set status=$1,review_note=$2,reviewer=$3,reviewed_at=now() where id=$4 and workspace_id=$5",
        [action.status, action.note, scope.actorId, action.draftId, scope.workspaceId],
      );
      recordId = action.draftId;
    } else if (action.kind === "opportunity") {
      if (!requirement || !contact || lead.values.side !== "Buyer")
        throw new HttpError(
          422,
          "Connect a buyer brief and business contact before creating an opportunity.",
        );
      const desk = await readExecutionInTransaction(db, scope, requirement.id);
      if (!desk.confirmation)
        throw new HttpError(
          422,
          "Confirm the current buyer requirement before creating an opportunity.",
        );
      if (!desk.matches.some((m) => m.aircraft.id === action.aircraftId && m.state === "eligible"))
        throw new HttpError(422, "Only an eligible aircraft match can be handed off.");
      if (!["Buyer", "Broker"].includes(contact.type))
        throw new HttpError(422, "Choose a buyer or broker contact for a buyer opportunity.");
      let revision = desk.revision;
      await mutateExecutionInTransaction(
        db,
        scope,
        requirement.id,
        { type: "link-contact", contactId: contact.id },
        revision++,
      );
      await mutateExecutionInTransaction(
        db,
        scope,
        requirement.id,
        {
          type: "shortlist",
          aircraftId: action.aircraftId,
          decision: "Shortlisted",
          reason: action.note,
        },
        revision++,
      );
      await mutateExecutionInTransaction(
        db,
        scope,
        requirement.id,
        {
          type: "prepare-draft",
          aircraftId: action.aircraftId,
          contactId: contact.id,
          audience: "Buyer",
        },
        revision,
      );
      const existing = data.deals.find(
        (d) => d.requirementId === requirement.id && d.aircraftId === action.aircraftId,
      );
      recordId = existing?.id ?? randomUUID();
      if (!existing)
        await mutateWorkspaceInTransaction(
          db,
          scope,
          {
            type: "deal",
            item: {
              id: recordId,
              title: `${requirement.client} · ${requirement.aircraftModel}`,
              requirementId: requirement.id,
              aircraftId: action.aircraftId,
              stage: "Sourcing",
              nextAction: action.note,
              dueDate: action.dueOn,
            },
          },
          workspace.revision,
        );
    }
    await db.query(
      "update aerion.lead_cases set revision=revision+1,updated_at=now() where workspace_id=$1 and lead_id=$2",
      [scope.workspaceId, id],
    );
    await audit(db, scope, `lead.${action.kind}`, id, {
      recordId,
      note: "note" in action ? action.note : undefined,
      ...(action.kind === "update"
        ? { status: action.status, nextAction: action.nextAction, dueOn: action.dueOn }
        : {}),
    });
    return { recordId };
  });
}
