import nextEnv from "@next/env";
import { readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import pg from "pg";
nextEnv.loadEnvConfig(process.cwd());
if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL in .env.local first.");
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("select pg_advisory_lock(173904601)");
  await client.query(
    "create table if not exists public.aerion_migrations (name text primary key, sha256 text not null, applied_at timestamptz not null default now())",
  );
  for (const name of (await readdir("db/migrations")).filter((n) => n.endsWith(".sql")).sort()) {
    const sql = await readFile(`db/migrations/${name}`, "utf8");
    const hash = createHash("sha256").update(sql).digest("hex");
    const existing = await client.query(
      "select sha256 from public.aerion_migrations where name=$1",
      [name],
    );
    if (existing.rows[0]) {
      if (existing.rows[0].sha256 !== hash) throw new Error(`Applied migration changed: ${name}`);
      continue;
    }
    await client.query("begin");
    try {
      await client.query(sql);
      await client.query("insert into public.aerion_migrations(name,sha256) values($1,$2)", [
        name,
        hash,
      ]);
      await client.query("commit");
      console.log(`Applied ${name}`);
    } catch (error) {
      await client.query("rollback");
      throw error;
    }
  }
} finally {
  await client.end();
}
