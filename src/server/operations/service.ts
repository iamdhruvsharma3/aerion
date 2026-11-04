import { agentCatalog } from "../../lib/agents/catalog";
import { operationUpdateSchema, type Operations } from "../../lib/operations/schema";
import { transaction, audit, type Scope } from "../db";
import { HttpError } from "../http";
import { mailConfiguration } from "../agents/mail-config";
import { providerConfiguration } from "../agents/providers";
import { dailyUsage, operationSettings } from "./limits";

export async function readOperations(scope: Scope): Promise<Operations> {
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    const settings = await operationSettings(db, scope),
      usage = await dailyUsage(db, scope);
    const heartbeat = (
      await db.query(
        "select max(seen_at) as last_seen,count(*) filter(where stopped_at is null and seen_at>now()-interval '45 seconds')::int as active from aerion.worker_heartbeats",
      )
    ).rows[0];
    const row = (
      await db.query(
        `select
      (select count(*)::int from aerion.agent_runs where workspace_id=$1 and status='queued') as queued_agents,
      (select count(*)::int from aerion.agent_runs where workspace_id=$1 and status='running') as running_agents,
      (select count(*)::int from aerion.agent_runs where workspace_id=$1 and status='failed' and created_at>now()-interval '7 days') as failed_agents,
      (select count(*)::int from aerion.extractions where workspace_id=$1 and status='queued') as queued_extractions,
      (select count(*)::int from aerion.extractions where workspace_id=$1 and status='failed' and created_at>now()-interval '7 days') as failed_extractions,
      (select count(*)::int from aerion.mail_deliveries where workspace_id=$1 and status='unknown') as uncertain_mail,
      (select count(*)::int from aerion.lead_cases where workspace_id=$1 and status<>'Dismissed' and next_action='') as no_action`,
        [scope.workspaceId],
      )
    ).rows[0];
    const workspace = (
      await db.query("select data from aerion.workspaces where id=$1", [scope.workspaceId])
    ).rows[0].data;
    const stale = {
      aircraft: workspace.aircraft.filter(
        (a: { availability: string; sourceDate: string }) =>
          a.availability === "Stale" ||
          new Date(`${a.sourceDate}T00:00:00Z`).getTime() < Date.now() - 30 * 86400000,
      ).length,
      leadsWithoutAction: row.no_action,
    };
    const lastBackup = (
      await db.query(
        'select created_at as "createdAt",verified_at as "verifiedAt",byte_size as bytes,sha256,verification from aerion.backup_events order by created_at desc limit 1',
      )
    ).rows[0];
    const records = (
      await db.query(
        "select agent_id,status,origin,model,checked_at,source_run_id,report_hash,result from (select *,row_number() over(partition by agent_id order by checked_at desc,id desc) as n from aerion.agent_validations where workspace_id=$1) v where n<=20 order by checked_at desc,source_run_id desc",
        [scope.workspaceId],
      )
    ).rows;
    const live = (
      await db.query(
        "select distinct on(agent_id) id,agent_id,model,finished_at,report from aerion.agent_runs where workspace_id=$1 and provider<>'rules' and status in ('review','completed') and report is not null and error is null and finished_at is not null and coalesce((usage->>'requests')::int,0)>0 order by agent_id,finished_at desc",
        [scope.workspaceId],
      )
    ).rows;
    const mail = mailConfiguration(scope),
      configuration = {
        local: process.env.AERION_LOCAL_AUTH === "true",
        nvidia: providerConfiguration("nvidia").ready,
        brave: Boolean(process.env.BRAVE_SEARCH_API_KEY?.trim()),
        smtp: mail.smtp.ready,
        imap: mail.mailbox.ready,
      };
    const alerts: Operations["alerts"] = [];
    if (!heartbeat.active)
      alerts.push({
        key: "worker",
        title: "Worker heartbeat unavailable",
        detail:
          "No worker heartbeat within 45 seconds. Start npm run dev or npm run worker; queued work stays saved.",
        href: "/agents",
        severity: "attention",
      });
    if (settings.paused)
      alerts.push({
        key: "paused",
        title: "New automated work is paused",
        detail: "Resume below when ready. A model request already running may finish.",
        href: "/operations",
        severity: "attention",
      });
    if (row.uncertain_mail)
      alerts.push({
        key: "mail",
        title: `${row.uncertain_mail} email outcome(s) need reconciliation`,
        detail:
          "Check the mail server before recording acceptance or retrying. Unknown submissions are never resent automatically.",
        href: "/communication",
        severity: "attention",
      });
    if (row.failed_agents || row.failed_extractions)
      alerts.push({
        key: "failed",
        title: "Recent jobs need review",
        detail: `${row.failed_agents} failed agent runs and ${row.failed_extractions} failed extractions in the last 7 days. Historical failures remain visible after a successful retry.`,
        href: "/agents",
        severity: "attention",
      });
    if (!lastBackup?.verifiedAt)
      alerts.push({
        key: "backup",
        title: "No restore-tested database backup recorded",
        detail:
          "Run npm run db:backup -- --verify-local to create a private archive and verify it in a temporary local database.",
        href: "/operations",
        severity: "setup",
      });
    if (!configuration.smtp)
      alerts.push({
        key: "smtp",
        title: "Business email sending awaits configuration",
        detail:
          "Draft review and download work locally. Configure your business sender later; no test message is sent by this page.",
        href: "/communication",
        severity: "setup",
      });
    if (stale.aircraft)
      alerts.push({
        key: "stale",
        title: `${stale.aircraft} aircraft record(s) need availability review`,
        detail:
          "Marked stale or sourced over 30 days ago. Age is a reminder to reconfirm, not a finding that an aircraft is unavailable.",
        href: "/aircraft",
        severity: "attention",
      });
    return {
      checkedAt: new Date().toISOString(),
      settings,
      revision: settings.revision,
      usage,
      configuration,
      worker: {
        ready: Boolean(heartbeat.active),
        lastSeen: heartbeat.last_seen,
        active: heartbeat.active,
      },
      jobs: {
        queuedAgents: row.queued_agents,
        runningAgents: row.running_agents,
        failedAgents: row.failed_agents,
        queuedExtractions: row.queued_extractions,
        failedExtractions: row.failed_extractions,
        uncertainMail: row.uncertain_mail,
      },
      backup: lastBackup ? { ...lastBackup, bytes: Number(lastBackup.bytes) } : null,
      stale,
      alerts,
      validations: agentCatalog.map((agent) => {
        const history = records.filter((r) => r.agent_id === agent.id),
          verified = (r: (typeof records)[number]) =>
            r.result?.version === 1 &&
            r.result?.profileVersion === "aerion-live-capability-v1" &&
            r.result?.reportHash === r.report_hash &&
            ["same-workspace", "published-fixture"].includes(r.result?.provenance?.kind),
          record = history.find(verified),
          observed = live.find((r) => r.agent_id === agent.id);
        return {
          agentId: agent.id,
          name: agent.name,
          status: record?.status ?? (observed ? "observed" : "pending"),
          origin: record?.origin ?? (observed ? "operational-run" : null),
          model: record?.model ?? observed?.model ?? null,
          checkedAt: record?.checked_at ?? observed?.finished_at ?? null,
          sourceRunId: record?.source_run_id ?? observed?.id ?? null,
          summary: record?.result?.summary ?? observed?.report?.summary ?? null,
          acceptanceProfile: record?.result?.profileVersion ?? null,
          proofKind: record?.result?.provenance?.kind ?? null,
          reportHash: record?.report_hash ?? null,
          counts: record?.result?.counts ?? null,
          observed: observed
            ? { sourceRunId: observed.id, model: observed.model, finishedAt: observed.finished_at }
            : null,
          history: history.map((r) => ({
            status: r.status,
            verified: verified(r),
            origin: r.origin,
            checkedAt: r.checked_at,
            sourceRunId: r.source_run_id,
            reportHash: r.report_hash,
          })),
        };
      }),
    };
  });
}
export async function updateOperations(scope: Scope, raw: unknown) {
  const input = operationUpdateSchema.parse(raw);
  await transaction(scope.actorId, scope.workspaceId, async (db) => {
    await db.query("select id from aerion.workspaces where id=$1 for update", [scope.workspaceId]);
    const old = await operationSettings(db, scope);
    if (old.revision !== input.revision)
      throw new HttpError(
        409,
        "Operations settings changed. Refresh and review the current limits.",
      );
    const s = input.settings;
    await db.query(
      "insert into aerion.operations_settings(workspace_id,revision,paused,max_model_jobs,max_agent_tokens,max_searches,max_mail,note) values($1,1,$2,$3,$4,$5,$6,$7) on conflict(workspace_id) do update set revision=aerion.operations_settings.revision+1,paused=excluded.paused,max_model_jobs=excluded.max_model_jobs,max_agent_tokens=excluded.max_agent_tokens,max_searches=excluded.max_searches,max_mail=excluded.max_mail,note=excluded.note,updated_at=now()",
      [
        scope.workspaceId,
        s.paused,
        s.maxModelJobs,
        s.maxAgentTokens,
        s.maxSearches,
        s.maxMail,
        input.note,
      ],
    );
    await audit(db, scope, "operations.updated", null, { before: old, after: s, note: input.note });
  });
  return readOperations(scope);
}
export {
  recordAgentValidation,
  acceptStoredAgentRun,
  publishAgentFixtureValidations,
} from "./provenance";
