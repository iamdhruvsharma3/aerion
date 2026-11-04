import { calendarDate } from "../lib/format";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { workspaceSchema, type Workspace } from "../lib/schema";
import { getMatches, evaluateMatch } from "../lib/matching";
import {
  executionActionSchema,
  readinessStatuses,
  type ExecutionAction,
  type ExecutionAttention,
  type ExecutionContext,
  type OutreachDraft,
} from "../lib/execution/schema";
import { audit, transaction, type Scope } from "./db";
import { draftMaterial, resolveConfirmation } from "./drafts";
import { HttpError } from "./http";
import { requirementNeedsRequalification } from "./communication/context";

const today = () => calendarDate();
async function load(db: PoolClient, scope: Scope, id: string, lock = false) {
  const workspace = await db.query(
    `select data from aerion.workspaces where id=$1${lock ? " for update" : ""}`,
    [scope.workspaceId],
  );
  if (!workspace.rows[0]) throw new HttpError(404, "Workspace not found.");
  const data = workspaceSchema.parse(workspace.rows[0].data);
  const requirement = data.requirements.find((r) => r.id === id);
  if (!requirement) throw new HttpError(404, "Requirement not found in this workspace.");
  const result = await db.query(
    `select * from aerion.execution_cases where workspace_id=$1 and requirement_id=$2${lock ? " for update" : ""}`,
    [scope.workspaceId, id],
  );
  return { data, requirement, row: result.rows[0] };
}
async function context(db: PoolClient, scope: Scope, id: string): Promise<ExecutionContext> {
  const { data, requirement, row } = await load(db, scope, id);
  const requalificationRequired = await requirementNeedsRequalification(db, scope, id);
  const supersededBy =
    (
      await db.query(
        'select requirement_id as "requirementId",lead_id as "leadId" from aerion.communication_brief_revisions where workspace_id=$1 and prior_requirement_id=$2 order by created_at desc limit 1',
        [scope.workspaceId, id],
      )
    ).rows[0] ?? null;
  const caseId = row?.id ?? null;
  const confirmation = await resolveConfirmation(db, scope, requirement, row?.confirmation);
  const decisions = await db.query(
    'select aircraft_id as "aircraftId",decision,reason,updated_at as "updatedAt" from aerion.shortlist_decisions where case_id=$1 and workspace_id=$2',
    [caseId, scope.workspaceId],
  );
  const linked = await db.query(
    "select contact_id from aerion.case_contacts where case_id=$1 and workspace_id=$2",
    [caseId, scope.workspaceId],
  );
  const contacts = data.contacts.filter((c) => linked.rows.some((l) => l.contact_id === c.id));
  const rawDrafts = await db.query(
    'select id,aircraft_id as "aircraftId",contact_id as "contactId",audience,subject,body,claims,context_hash as "contextHash",status,review_note as "reviewNote",created_at as "createdAt",reviewed_at as "reviewedAt" from aerion.outreach_drafts where case_id=$1 and workspace_id=$2 order by created_at desc limit 100',
    [caseId, scope.workspaceId],
  );
  const drafts: OutreachDraft[] = [];
  for (const draft of rawDrafts.rows) {
    const aircraft = data.aircraft.find((a) => a.id === draft.aircraftId);
    const contact = contacts.find((c) => c.id === draft.contactId);
    let stale = true;
    if (
      !requalificationRequired &&
      aircraft &&
      contact &&
      confirmation &&
      decisions.rows.some((d) => d.aircraftId === aircraft.id && d.decision === "Shortlisted") &&
      evaluateMatch(aircraft, requirement).state === "eligible"
    ) {
      try {
        stale =
          (
            await draftMaterial(
              db,
              scope,
              aircraft,
              requirement,
              contact,
              confirmation,
              draft.audience,
            )
          ).contextHash !== draft.contextHash;
      } catch (error) {
        if (!(error instanceof HttpError)) throw error;
      }
    }
    drafts.push({ ...draft, stale });
  }
  const actions = await db.query(
    "select id,kind,title,detail,to_char(due_date,'YYYY-MM-DD') as \"dueDate\",status,seed_key as \"seedKey\" from aerion.case_actions where case_id=$1 and workspace_id=$2 order by (status='Open') desc,due_date nulls last,created_at",
    [caseId, scope.workspaceId],
  );
  const readiness = await db.query(
    'select item_key as key,status,source_id as "sourceId",note,verified_by as "verifiedBy",to_char(verified_on,\'YYYY-MM-DD\') as "verifiedOn",updated_at as "updatedAt" from aerion.readiness_items where case_id=$1 and workspace_id=$2',
    [caseId, scope.workspaceId],
  );
  const sources = await db.query(
    'select id,title,kind,created_at as "createdAt" from aerion.sources where workspace_id=$1 order by created_at desc limit 500',
    [scope.workspaceId],
  );
  const activity = await db.query(
    "select id,action,created_at as \"createdAt\",detail from aerion.activity where workspace_id=$1 and detail->>'caseId'=$2 order by created_at desc,id desc limit 50",
    [scope.workspaceId, caseId],
  );
  return {
    supersededBy,
    requalificationRequired,
    revision: row?.revision ?? 0,
    requirement,
    confirmation,
    matches: getMatches(data.aircraft, [requirement]).map((match) =>
      requalificationRequired
        ? {
            ...match,
            state: "excluded" as const,
            score: 0,
            checks: [
              {
                label: "Current buyer brief",
                result: "fail" as const,
                detail:
                  "This requirement was superseded by a reviewed buyer reply. Reconfirm and match the revised brief.",
              },
              ...match.checks,
            ],
          }
        : match,
    ),
    decisions: decisions.rows,
    drafts,
    actions: actions.rows,
    readiness: readiness.rows,
    contacts,
    availableContacts: data.contacts,
    deals: data.deals.filter((d) => d.requirementId === id),
    sources: sources.rows,
    activity: activity.rows,
  };
}
export async function readExecution(scope: Scope, id: string) {
  return transaction(scope.actorId, scope.workspaceId, (db) => context(db, scope, id));
}
export async function mutateExecution(
  scope: Scope,
  id: string,
  rawAction: ExecutionAction,
  revision: number,
) {
  const action = executionActionSchema.parse(rawAction);
  return transaction(scope.actorId, scope.workspaceId, (db) =>
    mutateExecutionInTransaction(db, scope, id, action, revision),
  );
}
export async function mutateExecutionInTransaction(
  db: PoolClient,
  scope: Scope,
  id: string,
  action: ExecutionAction,
  revision: number,
) {
  const { data, requirement, row: existing } = await load(db, scope, id, true);
  if (
    (action.type === "prepare-draft" ||
      action.type === "confirm-brief" ||
      (action.type === "shortlist" && action.decision === "Shortlisted")) &&
    await requirementNeedsRequalification(db, scope, id)
  )
    throw new HttpError(
      422,
      "This buyer brief was superseded by a reviewed reply. Use and confirm the revised requirement for new shortlist and offer decisions; prior records remain historical.",
    );
  if ((existing?.revision ?? 0) !== revision)
    throw new HttpError(
      409,
      "This execution desk changed in another session. Reload it before retrying; your unsaved form is still available.",
    );
  const caseId = existing?.id ?? randomUUID();
  if (!existing)
    await db.query(
      "insert into aerion.execution_cases(id,workspace_id,requirement_id) values($1,$2,$3)",
      [caseId, scope.workspaceId, id],
    );
  const confirmation = await resolveConfirmation(db, scope, requirement, existing?.confirmation);
  let recordId: string = caseId;
  const detail: Record<string, unknown> = { caseId, requirementId: id };
  switch (action.type) {
    case "confirm-brief": {
      if (confirmation)
        throw new HttpError(409, "A founder-recorded confirmation already exists for this brief.");
      if (requirement.intelligence)
        throw new HttpError(
          422,
          "Resolve the original signal confirmation in market intelligence.",
        );
      if (action.confirmation.confirmedOn > today())
        throw new HttpError(422, "Confirmation date cannot be in the future.");
      await db.query("update aerion.execution_cases set confirmation=$1 where id=$2", [
        action.confirmation,
        caseId,
      ]);
      const next: Workspace = {
        ...data,
        requirements: data.requirements.map((r) =>
          r.id === id ? { ...r, status: "Confirmed" } : r,
        ),
      };
      await db.query("update aerion.workspaces set data=$1,revision=revision+1 where id=$2", [
        next,
        scope.workspaceId,
      ]);
      detail.confirmation = action.confirmation;
      break;
    }
    case "link-contact": {
      if (!data.contacts.some((c) => c.id === action.contactId))
        throw new HttpError(404, "Contact not found in this workspace.");
      await db.query(
        "insert into aerion.case_contacts(workspace_id,case_id,contact_id) values($1,$2,$3) on conflict do nothing",
        [scope.workspaceId, caseId, action.contactId],
      );
      detail.contactId = action.contactId;
      break;
    }
    case "shortlist": {
      const aircraft = data.aircraft.find((a) => a.id === action.aircraftId);
      if (!aircraft) throw new HttpError(404, "Aircraft not found in this workspace.");
      if (
        action.decision === "Shortlisted" &&
        (!confirmation || evaluateMatch(aircraft, requirement).state !== "eligible")
      )
        throw new HttpError(
          422,
          "Shortlisting requires a founder-recorded brief confirmation and an eligible match.",
        );
      await db.query(
        "insert into aerion.shortlist_decisions(workspace_id,case_id,aircraft_id,decision,reason,actor_id) values($1,$2,$3,$4,$5,$6) on conflict(case_id,aircraft_id) do update set decision=excluded.decision,reason=excluded.reason,actor_id=excluded.actor_id,updated_at=now()",
        [
          scope.workspaceId,
          caseId,
          action.aircraftId,
          action.decision,
          action.reason,
          scope.actorId,
        ],
      );
      Object.assign(detail, {
        aircraftId: action.aircraftId,
        decision: action.decision,
        reason: action.reason,
      });
      break;
    }
    case "prepare-draft": {
      const aircraft = data.aircraft.find((a) => a.id === action.aircraftId),
        contact = data.contacts.find((c) => c.id === action.contactId);
      if (!aircraft || !contact)
        throw new HttpError(404, "Aircraft or contact not found in this workspace.");
      if (!confirmation || evaluateMatch(aircraft, requirement).state !== "eligible")
        throw new HttpError(422, "A confirmed brief and eligible match are required.");
      const decision = await db.query(
        "select decision from aerion.shortlist_decisions where case_id=$1 and aircraft_id=$2",
        [caseId, aircraft.id],
      );
      const linked = await db.query(
        "select contact_id from aerion.case_contacts where case_id=$1 and contact_id=$2",
        [caseId, contact.id],
      );
      if (decision.rows[0]?.decision !== "Shortlisted" || !linked.rows.length)
        throw new HttpError(
          422,
          "Shortlist the aircraft and link the recipient before preparing a draft.",
        );
      if (![action.audience, "Broker"].includes(contact.type))
        throw new HttpError(
          422,
          `Choose a ${action.audience.toLowerCase()} or broker contact for this draft.`,
        );
      const material = await draftMaterial(
        db,
        scope,
        aircraft,
        requirement,
        contact,
        confirmation,
        action.audience,
      );
      const same = await db.query(
        "select id from aerion.outreach_drafts where case_id=$1 and aircraft_id=$2 and contact_id=$3 and audience=$4 and context_hash=$5",
        [caseId, aircraft.id, contact.id, action.audience, material.contextHash],
      );
      recordId = same.rows[0]?.id ?? randomUUID();
      if (!same.rows.length) {
        const count = await db.query(
          "select count(*)::int as n from aerion.outreach_drafts where case_id=$1",
          [caseId],
        );
        if (count.rows[0].n >= 100)
          throw new HttpError(422, "This requirement supports up to 100 retained drafts.");
        await db.query(
          "insert into aerion.outreach_drafts(id,workspace_id,case_id,aircraft_id,contact_id,audience,subject,body,claims,context_hash) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            recordId,
            scope.workspaceId,
            caseId,
            aircraft.id,
            contact.id,
            action.audience,
            material.subject,
            material.body,
            JSON.stringify(material.claims),
            material.contextHash,
          ],
        );
      }
      Object.assign(detail, {
        draftId: recordId,
        aircraftId: aircraft.id,
        contactId: contact.id,
        audience: action.audience,
        reused: Boolean(same.rows.length),
      });
      break;
    }
    case "review-draft": {
      const desk = await context(db, scope, id),
        draft = desk.drafts.find((d) => d.id === action.draftId);
      if (!draft) throw new HttpError(404, "Draft not found in this requirement.");
      if (draft.status === "Archived")
        throw new HttpError(409, "This draft is archived. Prepare a draft from current inputs.");
      if (action.status === "Reviewed" && (draft.stale || !action.attested))
        throw new HttpError(422, "Review requires current evidence and your explicit attestation.");
      await db.query(
        "update aerion.outreach_drafts set status=$1,review_note=$2,reviewer=$3,reviewed_at=now() where id=$4",
        [action.status, action.note, scope.actorId, draft.id],
      );
      recordId = draft.id;
      Object.assign(detail, { status: action.status, note: action.note });
      break;
    }
    case "add-action": {
      if (action.kind === "Follow-up" && !action.dueDate)
        throw new HttpError(422, "A follow-up needs a due date.");
      const count = await db.query(
        "select count(*)::int as n from aerion.case_actions where case_id=$1",
        [caseId],
      );
      if (count.rows[0].n >= 200)
        throw new HttpError(422, "This requirement supports up to 200 actions.");
      recordId = randomUUID();
      await db.query(
        "insert into aerion.case_actions(id,workspace_id,case_id,kind,title,detail,due_date) values($1,$2,$3,$4,$5,$6,$7)",
        [
          recordId,
          scope.workspaceId,
          caseId,
          action.kind,
          action.title,
          action.detail,
          action.dueDate,
        ],
      );
      Object.assign(detail, { title: action.title, kind: action.kind, dueDate: action.dueDate });
      break;
    }
    case "action-status": {
      const result = await db.query(
        "update aerion.case_actions set status=$1,updated_at=now() where id=$2 and case_id=$3 returning id",
        [action.status, action.actionId, caseId],
      );
      if (!result.rows.length) throw new HttpError(404, "Action not found in this requirement.");
      recordId = action.actionId;
      detail.status = action.status;
      break;
    }
    case "suggest-actions": {
      const desk = await context(db, scope, id);
      const suggestions: { key: string; title: string; detail: string }[] = [];
      if (!confirmation)
        suggestions.push({
          key: "confirm-brief",
          title: "Record buyer brief confirmation",
          detail: "Identify the contact, date and basis before shortlisting.",
        });
      if (!desk.decisions.some((d) => d.decision === "Shortlisted"))
        suggestions.push({
          key: "shortlist",
          title: "Review candidates and record shortlist decisions",
          detail: "Check match constraints and save your reasoning.",
        });
      if (!desk.contacts.length)
        suggestions.push({
          key: "contact",
          title: "Link the buyer or seller contact",
          detail: "Add an existing contact to this requirement.",
        });
      for (const draft of desk.drafts.filter((d) => d.status === "Prepared" && !d.stale))
        suggestions.push({
          key: `review:${draft.id}`,
          title: `Review ${draft.audience.toLowerCase()} outreach draft`,
          detail:
            "Check recipient, retained evidence and wording before approving the current draft for email delivery.",
        });
      for (const d of desk.decisions.filter((d) => d.decision === "Shortlisted"))
        suggestions.push({
          key: `availability:${d.aircraftId}`,
          title: `Reconfirm aircraft availability: ${data.aircraft.find((a) => a.id === d.aircraftId)?.serial ?? "candidate"}`,
          detail: "Obtain a current source and record the result in readiness.",
        });
      for (const deal of desk.deals)
        suggestions.push({
          key: `deal:${deal.id}`,
          title: deal.nextAction,
          detail: `Opportunity: ${deal.title}`,
        });
      const count = await db.query(
        "select count(*)::int as n from aerion.case_actions where case_id=$1",
        [caseId],
      );
      let added = 0;
      for (const s of suggestions) {
        const prior = await db.query(
          "select id from aerion.case_actions where case_id=$1 and seed_key=$2",
          [caseId, s.key],
        );
        if (prior.rows.length) continue;
        if (count.rows[0].n + added >= 200)
          throw new HttpError(422, "Action capacity reached; suggestions were not saved.");
        await db.query(
          "insert into aerion.case_actions(id,workspace_id,case_id,kind,title,detail,due_date,seed_key) values($1,$2,$3,'Follow-up',$4,$5,$6,$7)",
          [randomUUID(), scope.workspaceId, caseId, s.title, s.detail, today(), s.key],
        );
        added++;
      }
      detail.added = added;
      break;
    }
    case "readiness": {
      const source = await db.query(
        "select id from aerion.sources where id=$1 and workspace_id=$2",
        [action.sourceId, scope.workspaceId],
      );
      if (!source.rows.length) throw new HttpError(404, "Source not found in this workspace.");
      const prior = await db.query(
        "select * from aerion.readiness_items where case_id=$1 and item_key=$2",
        [caseId, action.key],
      );
      const old = prior.rows[0];
      const oldRank = old ? readinessStatuses.indexOf(old.status) : 0,
        newRank = readinessStatuses.indexOf(action.status);
      if (newRank > oldRank + 1)
        throw new HttpError(422, "Record receipt, review, then verification in order.");
      if (old && old.source_id !== action.sourceId && newRank > 1)
        throw new HttpError(
          422,
          "A replacement source must be recorded as received before review.",
        );
      if (newRank >= 2 && !action.attested)
        throw new HttpError(422, "Confirm that you reviewed the attached source.");
      if (
        action.status === "Verified" &&
        (!action.verifiedBy ||
          !action.verifiedOn ||
          action.verifiedOn > today() ||
          action.note.length < 20)
      )
        throw new HttpError(
          422,
          "Record the verifier, a date no later than today, and a detailed verification basis.",
        );
      await db.query(
        "insert into aerion.readiness_items(workspace_id,case_id,item_key,status,source_id,note,verified_by,verified_on,reviewer) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(case_id,item_key) do update set status=excluded.status,source_id=excluded.source_id,note=excluded.note,verified_by=excluded.verified_by,verified_on=excluded.verified_on,reviewer=excluded.reviewer,updated_at=now()",
        [
          scope.workspaceId,
          caseId,
          action.key,
          action.status,
          action.sourceId,
          action.note,
          action.status === "Verified" ? action.verifiedBy : null,
          action.status === "Verified" ? action.verifiedOn : null,
          scope.actorId,
        ],
      );
      Object.assign(detail, {
        key: action.key,
        status: action.status,
        sourceId: action.sourceId,
        note: action.note,
        verifiedBy: action.verifiedBy,
        verifiedOn: action.verifiedOn,
      });
      break;
    }
  }
  await db.query("update aerion.execution_cases set revision=revision+1 where id=$1", [caseId]);
  await audit(db, scope, `execution.${action.type}`, recordId, detail);
  return { revision: revision + 1, recordId };
}

export async function readExecutionAttention(scope: Scope): Promise<ExecutionAttention> {
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    const workspace = await db.query("select data from aerion.workspaces where id=$1", [
      scope.workspaceId,
    ]);
    if (!workspace.rows[0]) throw new HttpError(404, "Workspace not found.");
    const data = workspaceSchema.parse(workspace.rows[0].data);
    const result = await db.query(
      `select a.id,a.title,a.kind,to_char(a.due_date,'YYYY-MM-DD') as "dueDate",c.requirement_id as "requirementId",count(*) over()::int as total from aerion.case_actions a join aerion.execution_cases c on c.id=a.case_id and c.workspace_id=a.workspace_id where a.workspace_id=$1 and a.status='Open' and a.due_date<=$2 order by a.due_date,a.created_at,a.id limit 100`,
      [scope.workspaceId, today()],
    );
    return {
      total: result.rows[0]?.total ?? 0,
      items: result.rows.map(({ total: _total, ...item }) => ({
        ...item,
        client:
          data.requirements.find((r) => r.id === item.requirementId)?.client ??
          "Requirement unavailable",
      })),
    };
  });
}

// Reuse the same scoped read during atomic, reviewed proposal and delivery transactions.
export { context as readExecutionInTransaction };
