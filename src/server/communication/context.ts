import { transaction, type Scope } from "../db";
import type { PoolClient } from "pg";
import { HttpError } from "../http";
/** An immutable analysis record, not prompt text, grants the explicit revised-brief path. */
export async function isRevisedReplyAnalysis(scope: Scope, runId: string) {
  return transaction(
    scope.actorId,
    scope.workspaceId,
    async (db) =>
      (
        await db.query(
          "select run_id from aerion.communication_analyses where workspace_id=$1 and run_id=$2 and kind='Revised brief'",
          [scope.workspaceId, runId],
        )
      ).rows.length > 0,
  );
}
async function correctionsReady(db: PoolClient) {
  if (
    !(await db.query("select to_regclass('aerion.communication_assignment_corrections') as name"))
      .rows[0].name
  )
    throw new HttpError(
      503,
      "Apply the communication correction migration and restart the web server and worker before continuing.",
    );
}
/** Current commercial actions require a newly reviewed brief after supersession or corrected source assignment. */
export async function requirementNeedsRequalification(
  db: PoolClient,
  scope: Scope,
  requirementId: string,
) {
  await correctionsReady(db);
  return (
    (
      await db.query(
        "select 1 from aerion.communication_brief_revisions where workspace_id=$1 and prior_requirement_id=$2 union all select 1 from aerion.communication_assignment_corrections where workspace_id=$1 and prior_requirement_id=$2 limit 1",
        [scope.workspaceId, requirementId],
      )
    ).rows.length > 0
  );
}
/** Retained historical links remain readable, but cannot silently become inputs for a different lead. */
export async function retiredReplySourceIds(
  db: PoolClient,
  scope: Scope,
  leadId: string,
): Promise<Set<string>> {
  await correctionsReady(db);
  const retired = (
    await db.query(
      "select c.source_ids from aerion.communication_assignment_corrections c join aerion.communication_messages m on m.id=c.message_id and m.workspace_id=c.workspace_id where c.workspace_id=$1 and c.prior_lead_id=$2 and m.lead_id<>$2",
      [scope.workspaceId, leadId],
    )
  ).rows;
  const current = (
    await db.query(
      "select source_id from aerion.communication_messages where workspace_id=$1 and lead_id=$2 union select l.child_id as source_id from aerion.source_links l join aerion.communication_messages m on m.source_id=l.parent_id and m.workspace_id=l.workspace_id where l.workspace_id=$1 and m.lead_id=$2 and l.relation='attachment'",
      [scope.workspaceId, leadId],
    )
  ).rows;
  const active = new Set(current.map((row) => row.source_id as string));
  return new Set(
    retired.flatMap((row) => (row.source_ids as string[]).filter((id) => !active.has(id))),
  );
}
export async function replyAssignmentVersion(
  db: PoolClient,
  scope: Scope,
  leadId: string,
): Promise<string | null> {
  await correctionsReady(db);
  return (
    (
      await db.query(
        "select id from aerion.communication_assignment_corrections where workspace_id=$1 and (prior_lead_id=$2 or lead_id=$2) order by created_at desc,id desc limit 1",
        [scope.workspaceId, leadId],
      )
    ).rows[0]?.id ?? null
  );
}
