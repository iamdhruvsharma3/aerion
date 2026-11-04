import nextEnv from "@next/env";
import { setTimeout } from "node:timers/promises";
import { pool } from "../src/server/db";
import { processNext } from "../src/server/jobs";
import { processNextAgent, enqueueDueSchedules } from "../src/server/agents/runtime";
import { processNextDelivery } from "../src/server/agents/delivery";
import { randomUUID } from "node:crypto";
import { workerHeartbeat } from "../src/server/operations/health";
nextEnv.loadEnvConfig(process.cwd());
let stopping = false;
const workerId = randomUUID();
let pulsing = false;
async function pulse() {
  if (pulsing) return;
  pulsing = true;
  try {
    await workerHeartbeat(workerId, stopping);
  } catch {
    console.error(
      "Worker heartbeat could not be saved. Check database migrations and connectivity.",
    );
  } finally {
    pulsing = false;
  }
}
await pulse();
const heartbeatTimer = setInterval(pulse, 10000);
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});
console.log(
  "Aerion worker started. Processing requested extraction jobs, agent runs and enabled schedules.",
);
while (!stopping) {
  try {
    // Worker enumeration is privileged. Every job then runs with the restricted runtime role.
    const { rows } = await pool().query(
      `select w.id,w.owner_id from aerion.workspaces w where exists(select 1 from aerion.extractions e where e.workspace_id=w.id and (e.status='queued' or (e.status='running' and e.leased_at<now()-interval '5 minutes'))) or exists(select 1 from aerion.agent_runs r where r.workspace_id=w.id and (r.status='queued' or (r.status='running' and r.leased_at<now()-interval '5 minutes'))) or exists(select 1 from aerion.agent_schedules s where s.workspace_id=w.id and s.enabled and s.next_run_at<=now()) or exists(select 1 from aerion.mail_deliveries d where d.workspace_id=w.id and (d.status='queued' or (d.status='sending' and d.sending_at<now()-interval '2 minutes'))) order by w.created_at limit 20`,
    );
    for (const row of rows) {
      if (stopping) break;
      const scope = { actorId: row.owner_id, workspaceId: row.id };
      await enqueueDueSchedules(scope);
      await processNext(scope);
      await processNextAgent(scope);
      await processNextDelivery(scope);
    }
  } catch (error) {
    console.error(
      "Worker could not process the queue:",
      error instanceof Error ? error.message : "Unknown error",
    );
  }
  if (!stopping) await setTimeout(2000);
}
clearInterval(heartbeatTimer);
await workerHeartbeat(workerId, true).catch(() => {});
await pool().end();
