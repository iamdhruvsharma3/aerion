import nextEnv from "@next/env";
import { randomUUID, createHash } from "node:crypto";
import { mkdir, open, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
nextEnv.loadEnvConfig(process.cwd());
const execute = promisify(execFile),
  args = process.argv.slice(2);
if (!process.env.DATABASE_URL) throw new Error("Configure DATABASE_URL first.");
const url = new URL(process.env.DATABASE_URL),
  verify = args.includes("--verify-local"),
  host = url.searchParams.get("host") || url.hostname;
if (
  verify &&
  host &&
  !host.startsWith("/") &&
  !["localhost", "127.0.0.1", "[::1]", "::1"].includes(host)
)
  throw new Error(
    "Automatic restore verification is restricted to a local PostgreSQL cluster. Create a deliberate remote restore procedure separately.",
  );
const outputIndex = args.indexOf("--output");
const path = resolve(
  outputIndex >= 0
    ? args[outputIndex + 1]
    : `.aerion/backups/aerion-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.dump`,
);
await mkdir(dirname(path), { recursive: true, mode: 0o700 });
const reserved = await open(path, "wx", 0o600);
await reserved.close();
const sslMode = url.searchParams.get("sslmode");
const connectionEnv = {
  ...process.env,
  PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
  ...(host ? { PGHOST: host } : {}),
  ...(url.port ? { PGPORT: url.port } : {}),
  ...(url.username ? { PGUSER: decodeURIComponent(url.username) } : {}),
  ...(url.password ? { PGPASSWORD: decodeURIComponent(url.password) } : {}),
  ...(sslMode ? { PGSSLMODE: sslMode } : {}),
};
const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
await admin.connect();
const temporary = `aerion_restore_${Date.now()}_${randomUUID().slice(0, 6)}_test`;
let temporaryCreated = false,
  snapshotOpen = false;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
try {
  await admin.query("begin isolation level repeatable read read only");
  snapshotOpen = true;
  const snapshot = (await admin.query("select pg_export_snapshot() as id")).rows[0].id;
  const expectedForcedRls = (
    await admin.query(
      "select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='aerion' and c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity",
    )
  ).rows[0].n;
  const tables: { schemaname: string; tablename: string }[] = (
    await admin.query(
      "select schemaname,tablename from pg_tables where schemaname='aerion' or (schemaname='public' and tablename='aerion_migrations') order by schemaname,tablename",
    )
  ).rows;
  const expected: Record<string, number> = {};
  for (const table of tables)
    expected[`${table.schemaname}.${table.tablename}`] = Number(
      (
        await admin.query(
          `select count(*) as n from ${quote(table.schemaname)}.${quote(table.tablename)}`,
        )
      ).rows[0].n,
    );
  await execute("pg_dump", ["--format=custom", "--snapshot", snapshot, "--file", path], {
    env: connectionEnv,
    timeout: 120000,
    maxBuffer: 1000000,
  });
  await admin.query("commit");
  snapshotOpen = false;
  await execute("pg_restore", ["--list", path], {
    env: connectionEnv,
    timeout: 30000,
    maxBuffer: 5000000,
  });
  let verification: Record<string, unknown> = { archiveReadable: true, restoreTested: false };
  if (verify) {
    await execute("createdb", ["--maintenance-db=postgres", temporary], {
      env: connectionEnv,
      timeout: 30000,
      maxBuffer: 1000000,
    });
    temporaryCreated = true;
    await execute(
      "pg_restore",
      ["--exit-on-error", "--no-owner", "--no-acl", "--dbname", temporary, path],
      { env: connectionEnv, timeout: 120000, maxBuffer: 2000000 },
    );
    const restoredUrl = new URL(url);
    restoredUrl.pathname = `/${temporary}`;
    const restored = new pg.Client({ connectionString: restoredUrl.href });
    await restored.connect();
    try {
      for (const table of tables) {
        const actual = Number(
          (
            await restored.query(
              `select count(*) as n from ${quote(table.schemaname)}.${quote(table.tablename)}`,
            )
          ).rows[0].n,
        );
        if (actual !== expected[`${table.schemaname}.${table.tablename}`])
          throw new Error(`Restored row count differs for ${table.schemaname}.${table.tablename}.`);
      }
      const forced = (
        await restored.query(
          "select count(*)::int as n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='aerion' and c.relkind='r' and c.relrowsecurity and c.relforcerowsecurity",
        )
      ).rows[0].n;
      if (forced !== expectedForcedRls)
        throw new Error("Restored row-security table count differs from the source snapshot.");
      verification = {
        archiveReadable: true,
        restoreTested: true,
        tables: tables.length,
        rows: Object.values(expected).reduce((a, b) => a + b, 0),
        forcedRlsTables: forced,
        rowCountsMatched: true,
      };
    } finally {
      await restored.end();
    }
  }
  const bytes = await stat(path),
    hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const sha256 = hash.digest("hex");
  await admin.query(
    "insert into aerion.backup_events(id,archive_path,byte_size,sha256,verified_at,verification) values($1,$2,$3,$4,case when $5 then now() else null end,$6)",
    [randomUUID(), path, bytes.size, sha256, verify, JSON.stringify(verification)],
  );
  console.log(
    JSON.stringify({ archive: path, bytes: bytes.size, sha256, ...verification }, null, 2),
  );
} catch (error) {
  if (snapshotOpen) await admin.query("rollback").catch(() => {});
  // Child errors may contain connection details. Keep them out of command output.
  throw new Error(
    error instanceof Error &&
      (error.message.startsWith("Restored row") || error.message.startsWith("Automatic restore"))
      ? error.message
      : "Backup or restore verification failed. Check local PostgreSQL tools, database access and free disk space. The private archive is preserved for inspection.",
  );
} finally {
  await admin.end();
  if (temporaryCreated)
    await execute("dropdb", ["--maintenance-db=postgres", temporary], {
      env: connectionEnv,
      timeout: 30000,
      maxBuffer: 1000000,
    }).catch(() => {
      console.error(`Temporary verification database ${temporary} needs manual cleanup.`);
    });
}
