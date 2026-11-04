import { pool } from "../db";
export async function workerHeartbeat(id: string, stopped = false) {
  await pool().query(
    "insert into aerion.worker_heartbeats(id,seen_at,stopped_at) values($1,now(),case when $2 then now() else null end) on conflict(id) do update set seen_at=now(),stopped_at=case when $2 then now() else null end",
    [id, stopped],
  );
}
