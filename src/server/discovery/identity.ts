import { createHash } from "node:crypto";
import type { LeadValues } from "../../lib/discovery/schema";
import type { ProposalAction } from "../../lib/agents/schema";
import type { PoolClient } from "pg";
import type { Scope } from "../db";

/** Same page and subject deduplicate across snapshots and repeated runs. Analytical wording is not identity. */
export function leadIdentity<T extends Pick<LeadValues, "side" | "organization" | "aircraftModel">>(
  url: string,
  values: T,
) {
  const canonical = new URL(url);
  canonical.hash = "";
  for (const key of [...canonical.searchParams.keys()])
    if (/^(utm_|fbclid$|gclid$)/i.test(key)) canonical.searchParams.delete(key);
  canonical.searchParams.sort();
  const normalize = (text: string | null) => (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return createHash("sha256")
    .update(
      JSON.stringify([
        canonical.href,
        values.side,
        normalize(values.organization),
        normalize(values.aircraftModel),
      ]),
    )
    .digest("hex");
}
export async function existingPendingLead(
  db: PoolClient,
  scope: Scope,
  action: Extract<ProposalAction, { type: "lead" }>,
  runId: string,
) {
  const result = (
    await db.query(
      "select url from aerion.discovery_results where workspace_id=$1 and id=$2 and source_id=$3 and status='retained'",
      [scope.workspaceId, action.resultId, action.sourceId],
    )
  ).rows[0];
  if (!result) return null;
  const key = leadIdentity(result.url, action.values);
  const rows = (
    await db.query(
      "select p.id,p.run_id,r.url,p.action->'values'->>'side' as side,p.action->'values'->>'organization' as organization,p.action->'values'->>'aircraftModel' as model from aerion.agent_proposals p join aerion.discovery_results r on r.id=(p.action->>'resultId')::uuid and r.workspace_id=p.workspace_id where p.workspace_id=$1 and p.run_id<>$2 and p.status='proposed' and p.action->>'type'='lead' and p.action->'values'->>'side'=$3",
      [scope.workspaceId, runId, action.values.side],
    )
  ).rows;
  return (
    rows.find(
      (row) =>
        leadIdentity(row.url, {
          side: row.side,
          organization: row.organization,
          aircraftModel: row.model,
        }) === key,
    ) ?? null
  );
}
export async function existingLeadId(
  db: PoolClient,
  scope: Scope,
  action: Extract<ProposalAction, { type: "lead" }>,
) {
  const result = await db.query(
    "select url from aerion.discovery_results where workspace_id=$1 and id=$2 and source_id=$3 and status='retained'",
    [scope.workspaceId, action.resultId, action.sourceId],
  );
  if (!result.rows[0]) return null;
  const previous = await db.query(
    "select id from aerion.discovery_leads where workspace_id=$1 and dedupe_key=$2",
    [scope.workspaceId, leadIdentity(result.rows[0].url, action.values)],
  );
  return (previous.rows[0]?.id as string | undefined) ?? null;
}
