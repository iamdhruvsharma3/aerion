import { randomUUID } from "node:crypto";
import type { AgentRun, AgentReport } from "../../lib/agents/schema";
import { reportSchema, runInputSchema } from "../../lib/agents/schema";
import { audit, transaction, type Scope } from "../db";
import { HttpError } from "../http";
import { AgentTools } from "./tools";
import { runRules } from "./rules";
import { runModel, type ModelUsage } from "./model";
import { retainProposal, enqueueAgentInTransaction } from "./repository";
import { proposalContext, validateReport } from "./evidence";
import { operationSettings } from "../operations/limits";

export async function processNextAgent(scope: Scope): Promise<boolean> {
  const token = randomUUID();
  const run = await transaction(scope.actorId, scope.workspaceId, async (db) => {
    if ((await operationSettings(db, scope)).paused) return null;
    const result = await db.query(
      `select *,agent_id as "agentId",created_at as "createdAt",finished_at as "finishedAt" from aerion.agent_runs where workspace_id=$1 and (status='queued' or (status='running' and leased_at<now()-interval '5 minutes')) order by created_at,id for update skip locked limit 1`,
      [scope.workspaceId],
    );
    const row = result.rows[0];
    if (!row) return null;
    if (row.attempts >= 3) {
      await db.query(
        "update aerion.agent_runs set status='failed',error='The worker was interrupted three times. Inspect the run and retry explicitly.',finished_at=now(),lease_token=null,revision=revision+1 where id=$1",
        [row.id],
      );
      await audit(db, scope, "agent.failed", row.id, { reason: "interrupted-attempt-limit" });
      return null;
    }
    await db.query(
      "update aerion.agent_runs set status='running',attempts=attempts+1,lease_token=$1,leased_at=now(),revision=revision+1,error=null where id=$2",
      [token, row.id],
    );
    await audit(db, scope, "agent.started", row.id, {
      agentId: row.agent_id,
      attempt: row.attempts + 1,
    });
    return {
      ...row,
      attempts: row.attempts + 1,
      input: runInputSchema.parse(row.input),
    } as AgentRun;
  });
  if (!run) return false;
  const controller = new AbortController(),
    timer = setTimeout(
      () => controller.abort(new Error("The run exceeded its three-minute execution budget.")),
      180000,
    );
  const check = async () => {
    controller.signal.throwIfAborted();
    const result = await transaction(scope.actorId, scope.workspaceId, (db) =>
      db.query(
        "select id from aerion.agent_runs where id=$1 and workspace_id=$2 and status='running' and lease_token=$3",
        [run.id, scope.workspaceId, token],
      ),
    );
    if (!result.rows.length) throw new Error("This run was cancelled or its worker lease changed.");
  };
  const trace = async (tool: string, input: unknown, output: unknown) => {
    await transaction(scope.actorId, scope.workspaceId, async (db) => {
      const lease = await db.query(
        "select id from aerion.agent_runs where id=$1 and workspace_id=$2 and status='running' and lease_token=$3 for update",
        [run.id, scope.workspaceId, token],
      );
      if (!lease.rows.length) return;
      const retained = JSON.stringify(output);
      const bounded =
        retained.length > 150000 ? { truncated: true, preview: retained.slice(0, 150000) } : output;
      await db.query(
        "insert into aerion.agent_steps(id,workspace_id,run_id,tool,input,output) values($1,$2,$3,$4,$5,$6)",
        [
          randomUUID(),
          scope.workspaceId,
          run.id,
          tool,
          JSON.stringify(input),
          JSON.stringify(bounded),
        ],
      );
    });
  };
  const tools = new AgentTools(scope, run, controller.signal, trace, check);
  const usage: ModelUsage | null =
    run.provider === "rules" ? null : { inputTokens: 0, outputTokens: 0, requests: 0 };
  try {
    let report: AgentReport;
    if (run.provider === "rules") report = await runRules(tools);
    else {
      const result = await runModel(tools, usage ?? undefined);
      report = result.report;
    }
    report = validateReport(reportSchema.parse(report), await tools.sources());
    await transaction(scope.actorId, scope.workspaceId, async (db) => {
      // Same lock order as all workspace and case mutations.
      await db.query("select id from aerion.workspaces where id=$1 for update", [
        scope.workspaceId,
      ]);
      const lease = await db.query(
        "select id from aerion.agent_runs where id=$1 and workspace_id=$2 and status='running' and lease_token=$3 for update",
        [run.id, scope.workspaceId, token],
      );
      if (!lease.rows.length) return;
      for (const item of tools.staged) {
        if ((await proposalContext(db, scope, item.proposal.action)) !== item.contextHash)
          throw new HttpError(
            409,
            "Referenced records changed while the agent was running. Review the trace and rerun against current context.",
          );
        await retainProposal(db, scope, run.id, run.agentId, item.proposal);
      }
      const status = tools.staged.length
        ? "review"
        : report.findings.every((f) => f.severity === "missing")
          ? "needs-input"
          : "completed";
      await db.query(
        "update aerion.agent_runs set status=$1,report=$2,usage=$3,finished_at=now(),lease_token=null,revision=revision+1 where id=$4",
        [status, report, usage, run.id],
      );
      await audit(db, scope, "agent.finished", run.id, {
        agentId: run.agentId,
        status,
        proposals: tools.staged.length,
        provider: run.provider,
        usage,
      });
    });
  } catch (error) {
    const message =
      error instanceof HttpError
        ? error.message
        : run.provider === "rules" && error instanceof Error
          ? error.message.slice(0, 500)
          : controller.signal.aborted
            ? "The run exceeded its execution budget. Inspect the trace and retry with a smaller task."
            : "Model execution failed or returned an unsupported result. Check the configured model, connection and quota; inspect the retained trace before retrying.";
    await transaction(scope.actorId, scope.workspaceId, async (db) => {
      const result = await db.query(
        "update aerion.agent_runs set status='failed',error=$1,usage=$5,finished_at=now(),lease_token=null,revision=revision+1 where id=$2 and workspace_id=$3 and status='running' and lease_token=$4 returning id",
        [message, run.id, scope.workspaceId, token, usage],
      );
      if (result.rows.length)
        await audit(db, scope, "agent.failed", run.id, { agentId: run.agentId, message });
    });
  } finally {
    clearTimeout(timer);
  }
  return true;
}
export async function enqueueDueSchedules(scope: Scope) {
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    await db.query("select id from aerion.workspaces where id=$1 for update", [scope.workspaceId]);
    const due = await db.query(
      "select * from aerion.agent_schedules where workspace_id=$1 and enabled and next_run_at<=now() order by next_run_at for update skip locked limit 12",
      [scope.workspaceId],
    );
    let queued = 0;
    for (const schedule of due.rows) {
      await db.query("savepoint scheduled_agent");
      try {
        await enqueueAgentInTransaction(
          db,
          scope,
          runInputSchema.parse({
            ...schedule.input,
            agentId: schedule.agent_id,
            provider: schedule.provider,
            idempotencyKey: randomUUID(),
          }),
        );
        queued++;
        await db.query("release savepoint scheduled_agent");
      } catch (error) {
        await db.query("rollback to savepoint scheduled_agent");
        await audit(db, scope, "agent.schedule-skipped", null, {
          agentId: schedule.agent_id,
          message:
            error instanceof HttpError
              ? error.message
              : "The scheduled request could not be queued.",
        });
      }
      await db.query(
        "update aerion.agent_schedules set next_run_at=now()+make_interval(hours=>interval_hours),updated_at=now() where workspace_id=$1 and agent_id=$2",
        [scope.workspaceId, schedule.agent_id],
      );
    }
    return queued;
  });
}
