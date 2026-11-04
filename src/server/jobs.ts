import type { ModelProvider } from "../lib/agents/schema";
import { createHash, randomUUID } from "node:crypto";
import { audit, transaction, type Scope } from "./db";
import { HttpError } from "./http";
import { extractLocally } from "../lib/intelligence/extract";
import { validateEvidence } from "../lib/intelligence/schema";
import { extractWithModel, extractMarketWithModel } from "./model";
import { providerConfiguration } from "./agents/providers";
import { extractMarketLocally, validateMarketEvidence } from "../lib/intelligence/market-extract";
import type { ExtractionOutput } from "../lib/intelligence/schema";
import type { MarketOutput } from "../lib/intelligence/market-schema";
import { enforceOperation, operationSettings } from "./operations/limits";

export async function enqueueExtraction(
  scope: Scope,
  sourceId: string,
  provider: "local" | ModelProvider,
  purpose: "aircraft" | "market" = "aircraft",
  selectedModel?: string,
) {
  if (provider !== "local" && !providerConfiguration(provider).ready)
    throw new HttpError(503, providerConfiguration(provider).detail);
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    await db.query("select id from aerion.workspaces where id=$1 for update", [scope.workspaceId]);
    const source = await db.query("select id from aerion.sources where id=$1 and workspace_id=$2", [
      sourceId,
      scope.workspaceId,
    ]);
    if (!source.rows.length) throw new HttpError(404, "Source not found.");
    const existing = await db.query(
      "select status from aerion.extractions where source_id=$1 and workspace_id=$2 and purpose=$3 and status <> 'failed'",
      [sourceId, scope.workspaceId, purpose],
    );
    if (existing.rows.length)
      throw new HttpError(
        409,
        "This source already has an extraction. Review its candidates or wait for the active job.",
      );
    const id = randomUUID();
    if (provider !== "local") await enforceOperation(db, scope, "model-job");
    await db.query(
      "insert into aerion.extractions(id,workspace_id,source_id,provider,model,purpose,prompt_version) values($1,$2,$3,$4,$5,$6,$7)",
      [
        id,
        scope.workspaceId,
        sourceId,
        provider,
        provider === "local" ? null : (selectedModel ?? providerConfiguration(provider).model),
        purpose,
        purpose === "market"
          ? provider === "local"
            ? "market-local-v1"
            : "market-model-v1"
          : "aircraft-v1",
      ],
    );
    await audit(db, scope, "extraction.queued", id, { sourceId, provider, purpose });
    return { id };
  });
}

/** Lease before external work; commit results only if this worker still owns the lease. */
export async function processNext(scope: Scope): Promise<boolean> {
  const token = randomUUID();
  const job = await transaction(scope.actorId, scope.workspaceId, async (db) => {
    const paused = (await operationSettings(db, scope)).paused;
    const { rows } = await db.query(
      `select e.*,s.pages,s.kind from aerion.extractions e join aerion.sources s on s.id=e.source_id and s.workspace_id=e.workspace_id
      where e.workspace_id=$1 and (not $2 or e.provider='local') and (e.status='queued' or (e.status='running' and e.leased_at < now()-interval '5 minutes')) order by e.created_at for update of e skip locked limit 1`,
      [scope.workspaceId, paused],
    );
    if (!rows[0]) return null;
    if (rows[0].attempts >= 3) {
      await db.query(
        "update aerion.extractions set status='failed',error='Processing was interrupted three times. Retry the source manually.',finished_at=now() where id=$1 and workspace_id=$2",
        [rows[0].id, scope.workspaceId],
      );
      return null;
    }
    await db.query(
      "update aerion.extractions set status='running',attempts=attempts+1,leased_at=now(),lease_token=$1,error=null where id=$2 and workspace_id=$3",
      [token, rows[0].id, scope.workspaceId],
    );
    return rows[0];
  });
  if (!job) return false;
  try {
    const market = job.purpose === "market";
    const output = market
      ? job.provider === "local"
        ? extractMarketLocally(job.pages, job.kind)
        : await extractMarketWithModel(job.pages, job.model, job.provider)
      : job.provider === "local"
        ? extractLocally(job.pages, job.kind)
        : await extractWithModel(job.pages, job.model, job.provider);
    const candidates = market
      ? validateMarketEvidence(output as MarketOutput, job.pages)
      : validateEvidence(output as ExtractionOutput, job.pages, job.kind);
    if (!candidates.length || candidates.every((c) => !c.facts.length))
      throw new Error(
        market
          ? "No supported market observations were extracted."
          : "No supported aircraft facts were extracted. Check the document or use labelled fields.",
      );
    await transaction(scope.actorId, scope.workspaceId, async (db) => {
      const lease = await db.query(
        "select id from aerion.extractions where id=$1 and workspace_id=$2 and status='running' and lease_token=$3 for update",
        [job.id, scope.workspaceId, token],
      );
      if (!lease.rows.length) return;
      for (const candidate of candidates) {
        if (market) {
          if (!candidate.facts.length || !("confidence" in candidate)) continue;
          const fingerprint = createHash("sha256")
            .update(JSON.stringify(candidate.facts))
            .digest("hex");
          await db.query(
            "insert into aerion.signals(id,workspace_id,source_id,extraction_id,fingerprint,facts,proposed,warnings,confidence) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(workspace_id,source_id,fingerprint) do nothing",
            [
              randomUUID(),
              scope.workspaceId,
              job.source_id,
              job.id,
              fingerprint,
              JSON.stringify(candidate.facts),
              candidate.values,
              JSON.stringify(candidate.warnings),
              candidate.confidence,
            ],
          );
          continue;
        }
        if (!candidate.facts.length) continue;
        await db.query(
          "insert into aerion.reviews(id,workspace_id,source_id,extraction_id,facts,proposed,warnings) values($1,$2,$3,$4,$5,$6,$7)",
          [
            randomUUID(),
            scope.workspaceId,
            job.source_id,
            job.id,
            JSON.stringify(candidate.facts),
            candidate.values,
            JSON.stringify(candidate.warnings),
          ],
        );
      }
      await db.query(
        "update aerion.extractions set status='completed',output=$1,finished_at=now(),lease_token=null where id=$2 and workspace_id=$3",
        [output, job.id, scope.workspaceId],
      );
      await audit(db, scope, "extraction.completed", job.id, {
        candidates: candidates.length,
        provider: job.provider,
        purpose: job.purpose,
      });
    });
  } catch (error) {
    const message =
      job.provider === "local" && error instanceof Error
        ? error.message.slice(0, 500)
        : "Model extraction failed or timed out. Check provider configuration and quota, then retry. No aircraft were published.";
    await transaction(scope.actorId, scope.workspaceId, async (db) => {
      await db.query(
        "update aerion.extractions set status='failed',error=$1,finished_at=now(),lease_token=null where id=$2 and workspace_id=$3 and lease_token=$4",
        [message, job.id, scope.workspaceId, token],
      );
      await audit(db, scope, "extraction.failed", job.id, { message });
    });
  }
  return true;
}
