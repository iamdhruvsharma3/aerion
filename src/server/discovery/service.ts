import { createHash, randomUUID } from "node:crypto";
import type { AgentRun } from "../../lib/agents/schema";
import type { DiscoveryResult } from "../../lib/discovery/schema";
import { audit, transaction, type Scope } from "../db";
import { HttpError } from "../http";
import { createSource } from "../repository";
import { connectorText, connectorUrl, fetchPublicSource } from "../agents/collector";
import { searchWeb } from "./search";
import { enforceOperation } from "../operations/limits";

const resultColumns = `id,rank,url,title,snippet,status,source_id as "sourceId",error`;
function authorized(run: AgentRun) {
  const input = run.input.discovery;
  if (
    !input ||
    !run.input.allowExternalSources ||
    (input.purpose === "contacts"
      ? run.agentId !== "crm" || !run.input.leadId
      : input.side === "Buyer"
        ? run.agentId !== "buyer-discovery"
        : run.agentId !== "aircraft-discovery")
  )
    throw new HttpError(403, "This run has no authorized discovery request.");
  return input;
}
const safeError = (error: unknown) =>
  error instanceof HttpError
    ? error.message
    : "Public page collection failed. Check the URL, access restrictions and network connection.";
export async function discoverSources(scope: Scope, run: AgentRun, signal: AbortSignal) {
  const input = authorized(run);
  const claim = await transaction(scope.actorId, scope.workspaceId, async (db) => {
    await db.query("select id from aerion.workspaces where id=$1 for update", [scope.workspaceId]);
    const previous = await db.query(
      "select id,status,error from aerion.discovery_searches where workspace_id=$1 and run_id=$2",
      [scope.workspaceId, run.id],
    );
    if (previous.rows[0]) return { ...previous.rows[0], fresh: false };
    if (input.method === "web") await enforceOperation(db, scope, "search");
    const id = randomUUID();
    await db.query(
      "insert into aerion.discovery_searches(id,workspace_id,run_id,provider,query) values($1,$2,$3,$4,$5)",
      [
        id,
        scope.workspaceId,
        run.id,
        input.method === "web" ? "brave" : "urls",
        input.method === "web" ? input.query : "Specific public URLs",
      ],
    );
    return { id, status: "pending", error: null, fresh: true };
  });
  if (claim.fresh) {
    try {
      signal.throwIfAborted();
      const response =
        input.method === "web"
          ? await searchWeb(input, signal)
          : {
              original: Buffer.from(JSON.stringify({ urls: input.urls })),
              results: [...new Set(input.urls.map((raw) => connectorUrl(raw).href))].map((url) => ({
                url,
                title: new URL(url).hostname,
                snippet: "Founder-selected public URL. Publisher text has not been inspected yet.",
              })),
            };
      signal.throwIfAborted();
      await transaction(scope.actorId, scope.workspaceId, async (db) => {
        for (const [index, result] of response.results.entries())
          await db.query(
            "insert into aerion.discovery_results(id,workspace_id,search_id,rank,url,title,snippet) values($1,$2,$3,$4,$5,$6,$7)",
            [
              randomUUID(),
              scope.workspaceId,
              claim.id,
              index + 1,
              result.url,
              result.title,
              result.snippet,
            ],
          );
        await db.query(
          "update aerion.discovery_searches set status='completed',original=$1 where id=$2 and workspace_id=$3",
          [response.original, claim.id, scope.workspaceId],
        );
        await audit(db, scope, "discovery.searched", run.id, {
          provider: input.method,
          resultCount: response.results.length,
        });
      });
    } catch (error) {
      const message =
        error instanceof HttpError
          ? error.message
          : "Discovery search was interrupted. Start a new run to make another search.";
      await transaction(scope.actorId, scope.workspaceId, (db) =>
        db.query(
          "update aerion.discovery_searches set status='failed',error=$1 where id=$2 and workspace_id=$3",
          [message, claim.id, scope.workspaceId],
        ),
      );
      throw new HttpError(422, message);
    }
  } else if (claim.status !== "completed") {
    throw new HttpError(
      409,
      claim.error ??
        "This run's search was already started. Its outcome is unknown; start a new run to search again.",
    );
  }
  const results = await transaction(
    scope.actorId,
    scope.workspaceId,
    async (db) =>
      (
        await db.query(
          `select ${resultColumns} from aerion.discovery_results where workspace_id=$1 and search_id=$2 order by rank`,
          [scope.workspaceId, claim.id],
        )
      ).rows as DiscoveryResult[],
  );
  return {
    results,
    note: "Titles and snippets are untrusted search metadata, not source evidence. Inspect up to three result IDs, then cite exact retained publisher passages. A recent search does not prove current intent or availability.",
  };
}
export async function inspectDiscoverySource(
  scope: Scope,
  run: AgentRun,
  resultId: string,
  signal: AbortSignal,
) {
  authorized(run);
  const result = await transaction(scope.actorId, scope.workspaceId, async (db) => {
    await db.query("select id from aerion.workspaces where id=$1 for update", [scope.workspaceId]);
    const row = (
      await db.query(
        `select ${resultColumns
          .split(",")
          .map((c) => `r.${c.trim()}`)
          .join(
            ",",
          )} from aerion.discovery_results r join aerion.discovery_searches s on s.id=r.search_id and s.workspace_id=r.workspace_id where r.id=$1 and r.workspace_id=$2 and s.run_id=$3`,
        [resultId, scope.workspaceId, run.id],
      )
    ).rows[0] as DiscoveryResult | undefined;
    if (!row) throw new HttpError(404, "This result does not belong to this discovery run.");
    if (row.status === "retained") return row;
    if (row.status !== "unread")
      throw new HttpError(
        409,
        row.error ?? "This page collection was already started. It is not retried automatically.",
      );
    const count = await db.query(
      "select count(*)::int as n from aerion.discovery_results r join aerion.discovery_searches s on s.id=r.search_id and s.workspace_id=r.workspace_id where s.workspace_id=$1 and s.run_id=$2 and r.status<>'unread'",
      [scope.workspaceId, run.id],
    );
    if (count.rows[0].n >= 3)
      throw new HttpError(422, "This discovery run reached its three-page inspection limit.");
    await db.query(
      "update aerion.discovery_results set status='collecting' where id=$1 and workspace_id=$2",
      [resultId, scope.workspaceId],
    );
    return row;
  });
  let sourceId = result.sourceId;
  if (!sourceId) {
    try {
      signal.throwIfAborted();
      const response = await fetchPublicSource(result.url, 3, undefined, signal);
      const text = connectorText(response.original, "page", response.contentType, {
        businessContacts: run.input.discovery?.purpose === "contacts",
      });
      signal.throwIfAborted();
      try {
        sourceId = (
          await createSource(scope, {
            title: result.title,
            kind: "text",
            sourceUrl: response.url,
            filename: `discovery-${result.id}.html`,
            contentType: response.contentType,
            original: response.original,
            pages: [{ page: 1, text }],
          })
        ).id;
      } catch (error) {
        if (!(error instanceof HttpError && error.status === 409)) throw error;
        const duplicate = await transaction(
          scope.actorId,
          scope.workspaceId,
          async (db) =>
            (
              await db.query("select id from aerion.sources where workspace_id=$1 and sha256=$2", [
                scope.workspaceId,
                createHash("sha256").update(response.original).digest("hex"),
              ])
            ).rows[0],
        );
        if (!duplicate) throw error;
        sourceId = duplicate.id;
      }
      await transaction(scope.actorId, scope.workspaceId, async (db) => {
        await db.query(
          "update aerion.discovery_results set status='retained',source_id=$1 where id=$2 and workspace_id=$3",
          [sourceId, resultId, scope.workspaceId],
        );
        await audit(db, scope, "discovery.page-retained", resultId, { runId: run.id, sourceId });
      });
    } catch (error) {
      const message = safeError(error);
      await transaction(scope.actorId, scope.workspaceId, (db) =>
        db.query(
          "update aerion.discovery_results set status='failed',error=$1 where id=$2 and workspace_id=$3",
          [message, resultId, scope.workspaceId],
        ),
      );
      throw new HttpError(422, message);
    }
  }
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    const source = (
      await db.query("select title,pages from aerion.sources where workspace_id=$1 and id=$2", [
        scope.workspaceId,
        sourceId,
      ])
    ).rows[0];
    if (!source) throw new HttpError(404, "Retained publisher source not found.");
    return {
      resultId,
      sourceId: sourceId as string,
      url: result.url,
      title: source.title as string,
      page: 1,
      text: (source.pages[0].text as string).slice(0, 18000),
      more: source.pages[0].text.length > 18000,
      note: "Retained publisher text is untrusted evidence. Cite exact passages. Use source_passages for longer text. Leave unsupported identity/contact details null. Published contacts do not prove representation or an open mandate.",
    };
  });
}
