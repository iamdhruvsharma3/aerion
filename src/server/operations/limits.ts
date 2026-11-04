import type { PoolClient } from "pg";
import { defaultOperationSettings, type OperationSettings } from "../../lib/operations/schema";
import { calendarDate } from "../../lib/format";
import type { Scope } from "../db";
import { HttpError } from "../http";

export async function operationSettings(
  db: PoolClient,
  scope: Scope,
): Promise<OperationSettings & { revision: number }> {
  return (
    (
      await db.query(
        'select revision,paused,max_model_jobs as "maxModelJobs",max_agent_tokens as "maxAgentTokens",max_searches as "maxSearches",max_mail as "maxMail" from aerion.operations_settings where workspace_id=$1',
        [scope.workspaceId],
      )
    ).rows[0] ?? { ...defaultOperationSettings, revision: 0 }
  );
}
export async function dailyUsage(db: PoolClient, scope: Scope) {
  const day = calendarDate();
  const row = (
    await db.query(
      `select
    (select count(*) from aerion.agent_runs where workspace_id=$1 and provider<>'rules' and created_at>=($2::date::timestamp at time zone 'Asia/Kolkata')) +
    (select count(*) from aerion.extractions where workspace_id=$1 and provider<>'local' and created_at>=($2::date::timestamp at time zone 'Asia/Kolkata')) as jobs,
    (select coalesce(sum(coalesce((usage->>'inputTokens')::bigint,0)+coalesce((usage->>'outputTokens')::bigint,0)),0) from aerion.agent_runs where workspace_id=$1 and created_at>=($2::date::timestamp at time zone 'Asia/Kolkata')) as tokens,
    (select count(*) from aerion.discovery_searches where workspace_id=$1 and provider='brave' and created_at>=($2::date::timestamp at time zone 'Asia/Kolkata')) as searches,
    (select count(*) from aerion.mail_deliveries where workspace_id=$1 and created_at>=($2::date::timestamp at time zone 'Asia/Kolkata')) as mail`,
      [scope.workspaceId, day],
    )
  ).rows[0];
  return {
    day,
    modelJobs: Number(row.jobs),
    agentTokens: Number(row.tokens),
    searches: Number(row.searches),
    mail: Number(row.mail),
  };
}
/** Caller holds the workspace row lock. Reused idempotent jobs must be returned before this guard. */
export async function enforceOperation(
  db: PoolClient,
  scope: Scope,
  kind: "agent" | "model-job" | "search" | "mail",
) {
  const settings = await operationSettings(db, scope);
  if (settings.paused)
    throw new HttpError(
      423,
      "New agent work and email submissions are paused in Operations. Resume there to continue.",
    );
  if (kind === "agent") return;
  const usage = await dailyUsage(db, scope);
  const exceeded =
    kind === "model-job"
      ? usage.modelJobs >= settings.maxModelJobs || usage.agentTokens >= settings.maxAgentTokens
      : kind === "search"
        ? usage.searches >= settings.maxSearches
        : usage.mail >= settings.maxMail;
  if (exceeded)
    throw new HttpError(
      429,
      `The workspace's daily ${kind === "model-job" ? "AI job or observed agent-token" : kind === "search" ? "web search" : "email queue"} limit was reached. Review usage and limits in Operations. Existing submitted work is not automatically retried.`,
    );
}
