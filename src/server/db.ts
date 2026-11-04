import pg, { type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { emptyWorkspace } from "../lib/workspace";

const globalDb = globalThis as unknown as { aerionPool?: pg.Pool };
export function pool() {
  if (!process.env.DATABASE_URL)
    throw new Error("Database is not configured. Set DATABASE_URL and run npm run db:migrate.");
  if (!globalDb.aerionPool)
    globalDb.aerionPool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 30000,
    });
  return globalDb.aerionPool;
}
export type Scope = { actorId: string; workspaceId: string };
export async function transaction<T>(
  actorId: string,
  workspaceId: string | null,
  run: (db: PoolClient) => Promise<T>,
): Promise<T> {
  const db = await pool().connect();
  try {
    await db.query("begin");
    await db.query("set local role aerion_runtime");
    await db.query(
      "select set_config('aerion.actor_id',$1,true),set_config('aerion.workspace_id',$2,true)",
      [actorId, workspaceId ?? ""],
    );
    const result = await run(db);
    await db.query("commit");
    return result;
  } catch (error) {
    await db.query("rollback");
    throw error;
  } finally {
    db.release();
  }
}
export async function workspaceFor(actorId: string): Promise<Scope> {
  return transaction(actorId, null, async (db) => {
    await db.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [actorId]);
    const result = await db.query("select id from aerion.workspaces where owner_id=$1", [actorId]);
    if (result.rows[0]) return { actorId, workspaceId: result.rows[0].id };
    const id = randomUUID();
    await db.query("insert into aerion.workspaces(id,owner_id,data) values($1,$2,$3)", [
      id,
      actorId,
      emptyWorkspace,
    ]);
    return { actorId, workspaceId: id };
  });
}
export async function audit(
  db: PoolClient,
  scope: Scope,
  action: string,
  recordId: string | null,
  detail: unknown = {},
) {
  await db.query(
    "insert into aerion.activity(id,workspace_id,actor_id,action,record_id,detail) values($1,$2,$3,$4,$5,$6)",
    [randomUUID(), scope.workspaceId, scope.actorId, action, recordId, detail],
  );
}
