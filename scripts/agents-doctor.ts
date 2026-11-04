import nextEnv from "@next/env";
import { createHash } from "node:crypto";
import { readdir, readFile, access } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pool } from "../src/server/db";
import { providerConfiguration, modelClient } from "../src/server/agents/providers";
import { agentProviderIds } from "../src/lib/agents/providers";
import { agentCatalog } from "../src/lib/agents/catalog";
import { mailConfiguration } from "../src/server/agents/mail-config";
import { searchConfiguration } from "../src/server/discovery/search";
nextEnv.loadEnvConfig(process.cwd());
const require = createRequire(join(process.cwd(), "package.json"));
let failed = false;
console.log(
  "Aerion agent setup — configuration checks only; no model calls, source collection or email sending.",
);
console.log(
  `Runtime: Node ${process.versions.node}; system certificate trust ${process.env.NODE_USE_SYSTEM_CA === "1" ? "enabled" : "not requested"}.`,
);
console.log(`Roles: ${agentCatalog.length}; all have scoped tools and a review boundary.`);
console.log(
  `Brave Search: ${searchConfiguration().ready ? "configured; API not probed" : "API key pending; public URL discovery works without it"}`,
);
for (const provider of agentProviderIds) {
  const config = providerConfiguration(provider);
  try {
    if (config.ready && provider !== "rules") modelClient(provider);
  } catch {
    failed = true;
    console.log(`${provider}: invalid endpoint configuration`);
    continue;
  }
  console.log(
    `${provider}: ${config.ready ? "configured" : "credentials/model pending"}${provider !== "rules" && config.ready ? " (this command does not call the model)" : ""}`,
  );
}
const owner =
  process.env.AERION_MAIL_OWNER_ID ||
  (process.env.AERION_LOCAL_AUTH === "true" ? "00000000-0000-4000-8000-000000000001" : "");
const mail = mailConfiguration({ actorId: owner, workspaceId: "" });
console.log(
  `IMAP: ${mail.mailbox.ready ? "configured; protocol not probed" : "credentials/folder pending"}`,
);
console.log(
  `SMTP: ${mail.smtp.ready ? "configured; delivery not probed" : "credentials/sender pending"}`,
);
try {
  await access(require.resolve("@tesseract.js-data/eng/4.0.0/eng.traineddata.gz"));
  require.resolve("tesseract.js");
  require.resolve("@napi-rs/canvas");
  console.log("English OCR: local engine and language data installed");
} catch {
  failed = true;
  console.log("English OCR: missing dependencies; run npm install");
}
if (process.env.AERION_EXTRA_CA_FILE) {
  try {
    await access(process.env.AERION_EXTRA_CA_FILE);
    console.log(
      "Source TLS: additional CA file available; certificate verification remains enabled",
    );
  } catch {
    failed = true;
    console.log("Source TLS: configured CA file is unreadable");
  }
} else console.log("Source TLS: Node trusted CAs; no network probe performed");
try {
  const client = pool();
  const applied = await client.query("select name,sha256 from public.aerion_migrations");
  const files = (await readdir("db/migrations")).filter((file) => file.endsWith(".sql")).sort();
  for (const name of files) {
    const hash = createHash("sha256")
      .update(await readFile(`db/migrations/${name}`))
      .digest("hex");
    if (!applied.rows.some((row) => row.name === name && row.sha256 === hash))
      throw new Error("Pending or changed migrations");
  }
  console.log(`PostgreSQL: connected; ${files.length} migrations match`);
} catch {
  failed = true;
  console.log(
    "PostgreSQL: connection or migration check failed. Check DATABASE_URL and npm run db:migrate.",
  );
} finally {
  if (process.env.DATABASE_URL) await pool().end();
}
console.log(
  "Worker: run npm run dev locally, or supervise npm run worker alongside the production web server. Process liveness is not inferred from configuration.",
);
process.exitCode = failed ? 1 : 0;
