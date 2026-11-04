import nextEnv from "@next/env";
import pg from "pg";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { z } from "zod";
import { HttpError } from "../src/server/http";
import { pool, workspaceFor } from "../src/server/db";
import {
  fixtureArtifactSchema,
  publishAgentFixtureValidations,
  acceptStoredAgentRun,
} from "../src/server/operations/provenance";

nextEnv.loadEnvConfig(process.cwd());
const args = process.argv.slice(2),
  reports: string[] = [],
  runs: string[] = [];
let actorId =
  process.env.AERION_LOCAL_AUTH === "true" ? "00000000-0000-4000-8000-000000000001" : "";
for (let index = 0; index < args.length; index++) {
  const key = args[index],
    value = args[++index];
  if (!value || value.startsWith("--"))
    throw new Error(
      "Use --report <artifact.json>, --run <owned run UUID>, or --actor <target owner UUID>.",
    );
  if (key === "--report") reports.push(resolve(value));
  else if (key === "--run") runs.push(z.uuid().parse(value));
  else if (key === "--actor") actorId = z.uuid().parse(value);
  else throw new Error("Unsupported acceptance publication option.");
}
if (!reports.length && !runs.length)
  throw new Error(
    "Provide one or more --report <artifact.json> or --run <owned run UUID> arguments. This command verifies stored evidence and makes no model calls or external communications.",
  );
if (!process.env.DATABASE_URL) throw new Error("Configure the target DATABASE_URL server-side.");
if (!actorId)
  throw new Error(
    "Choose the authenticated target owner with --actor, or use explicit local development access.",
  );
const sourceUrl = process.env.AERION_TEST_DATABASE_URL;
function isTestUrl(value: string | undefined) {
  if (!value) return false;
  try {
    return new URL(value).pathname.endsWith("_test");
  } catch {
    return false;
  }
}
if (reports.length && !isTestUrl(sourceUrl))
  throw new Error(
    "Set AERION_TEST_DATABASE_URL to the dedicated _test database containing the retained fixture runs.",
  );
const sourcePool = sourceUrl
  ? new pg.Pool({ connectionString: sourceUrl, max: 1, connectionTimeoutMillis: 5000 })
  : null;
try {
  const target = await workspaceFor(actorId);
  for (const path of reports) {
    const bytes = await readFile(path);
    if (bytes.length > 2_000_000)
      throw new Error("Acceptance artifact exceeds the 2 MB input bound.");
    const artifact = fixtureArtifactSchema.parse(JSON.parse(bytes.toString("utf8")));
    const sourceDb = await sourcePool?.connect();
    if (!sourceDb) throw new Error("Dedicated fixture database is unavailable.");
    try {
      const actual = (await sourceDb.query("select current_database() as name")).rows[0].name;
      if (actual !== artifact.database)
        throw new Error("The fixture artifact names a different source database.");
      const artifactHash = createHash("sha256").update(bytes).digest("hex");
      const published = await publishAgentFixtureValidations(
        target,
        sourceDb,
        { actorId: artifact.actorId, workspaceId: artifact.fixture.workspaceId },
        artifact.results,
        artifactHash,
      );
      console.log(JSON.stringify({ artifactHash, published }));
    } finally {
      sourceDb.release();
    }
  }
  for (const runId of runs) console.log(JSON.stringify(await acceptStoredAgentRun(target, runId)));
  console.log(
    "Verified capability records retained. Source documents and private reports were not copied. No model call, message, offer, transaction or payment was executed.",
  );
} catch (error) {
  console.error(
    error instanceof HttpError
      ? error.message
      : "Acceptance publication could not complete. Check the artifact schema and configured database connections; private inputs are not printed.",
  );
  process.exitCode = 1;
} finally {
  await sourcePool?.end();
  await pool().end();
}
