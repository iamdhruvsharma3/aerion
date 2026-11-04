import { modelProviderIds } from "../lib/agents/providers";
import { providerConfiguration } from "./agents/providers";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PoolClient } from "pg";
import { aircraftSchema, workspaceSchema, type Workspace } from "../lib/schema";
import { applyAction, type WorkspaceAction } from "../lib/workspace";
import {
  fieldNames,
  pageSchema,
  type Pipeline,
  type ReviewRecord,
  type SourcePage,
  type SourceRecord,
} from "../lib/intelligence/schema";
import { audit, transaction, type Scope } from "./db";
import { HttpError } from "./http";
import { documentStore } from "./storage";
import { requirementNeedsRequalification } from "./communication/context";

export async function readWorkspace(scope: Scope) {
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    const { rows } = await db.query("select data,revision from aerion.workspaces where id=$1", [
      scope.workspaceId,
    ]);
    if (!rows[0]) throw new HttpError(404, "Workspace not found.");
    return { data: workspaceSchema.parse(rows[0].data), revision: rows[0].revision as number };
  });
}
export async function mutateWorkspace(scope: Scope, action: WorkspaceAction, revision: number) {
  return transaction(scope.actorId, scope.workspaceId, (db) =>
    mutateWorkspaceInTransaction(db, scope, action, revision),
  );
}
export async function mutateWorkspaceInTransaction(
  db: PoolClient,
  scope: Scope,
  action: WorkspaceAction,
  revision: number,
) {
  const { rows } = await db.query(
    "select data,revision from aerion.workspaces where id=$1 for update",
    [scope.workspaceId],
  );
  if (!rows[0]) throw new HttpError(404, "Workspace not found.");
  if (
    action.type === "deal" &&
    !rows[0].data.deals.some((deal: { id: string }) => deal.id === action.item.id) &&
    (await requirementNeedsRequalification(db, scope, action.item.requirementId))
  )
    throw new HttpError(
      422,
      "This buyer brief was superseded by a reviewed reply. Use the revised requirement for a new opportunity; prior deals remain historical.",
    );
  if (rows[0].revision !== revision)
    throw new HttpError(
      409,
      "This workspace changed in another session. Your view has been refreshed; please retry the change.",
    );
  let data: Workspace;
  try {
    data = applyAction(workspaceSchema.parse(rows[0].data), action);
  } catch (error) {
    throw new HttpError(422, error instanceof Error ? error.message : "Invalid workspace change.");
  }
  // Source-backed aircraft can only enter inventory through the review transaction.
  if (action.type === "aircraft")
    throw new HttpError(422, "Use the review queue for source-backed aircraft.");
  if (action.type === "requirement" && action.item.intelligence)
    throw new HttpError(422, "Promote source-backed requirements through intelligence review.");
  if (
    action.type === "migrate" &&
    (action.workspace.aircraft.some((item) => item.evidence) ||
      action.workspace.requirements.some((item) => item.intelligence) ||
      action.workspace.deals.some((item) => item.requirementEvidence))
  )
    throw new HttpError(422, "A browser backup cannot import server review references.");
  await db.query("update aerion.workspaces set data=$1,revision=revision+1 where id=$2", [
    data,
    scope.workspaceId,
  ]);
  await audit(db, scope, `workspace.${action.type}`, null);
  return { data, revision: revision + 1 };
}

export async function createSource(
  scope: Scope,
  input: {
    title: string;
    kind: SourceRecord["kind"];
    sourceUrl: string | null;
    filename: string;
    contentType: string;
    original: Buffer;
    pages: SourcePage[];
  },
) {
  const id = randomUUID();
  const hash = createHash("sha256").update(input.original).digest("hex");
  z.array(pageSchema).min(1).max(40).parse(input.pages);
  if (input.pages.reduce((n, p) => n + p.text.length, 0) > 200_000)
    throw new HttpError(413, "Document text exceeds 200,000 characters. Split the document.");
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    await db.query("select id from aerion.workspaces where id=$1 for update", [scope.workspaceId]);
    const duplicate = await db.query(
      "select id from aerion.sources where workspace_id=$1 and sha256=$2",
      [scope.workspaceId, hash],
    );
    if (duplicate.rows.length)
      throw new HttpError(409, "This exact document is already in your source library.");
    const count = await db.query(
      "select count(*)::int as n from aerion.sources where workspace_id=$1",
      [scope.workspaceId],
    );
    if (count.rows[0].n >= 500)
      throw new HttpError(422, "This workspace supports up to 500 source documents.");
    await documentStore.retain(db, { ...input, id, workspaceId: scope.workspaceId, sha256: hash });
    await audit(db, scope, "source.created", id, { sha256: hash, kind: input.kind });
    return { id };
  });
}

const sourceColumns = `s.id,s.title,s.kind,s.source_url as "sourceUrl",s.filename,s.sha256,s.created_at as "createdAt",s.pages,
  coalesce(e.status,'ready') as status,e.error,e.provider,coalesce(e.attempts,0) as attempts`;
const reviewColumns = `id,source_id as "sourceId",extraction_id as "extractionId",status,facts,coalesce(final_values,proposed) as values,warnings,reviewed_at as "reviewedAt",reviewer,aircraft_id as "aircraftId",note`;
const latestExtraction = `left join lateral (select status,error,provider,attempts from aerion.extractions where source_id=s.id and workspace_id=s.workspace_id and purpose='aircraft' order by created_at desc limit 1) e on true`;
export async function readPipeline(scope: Scope): Promise<Pipeline> {
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    const sources = await db.query(
      `select ${sourceColumns.replace("s.pages,", "'[]'::jsonb as pages,")} from aerion.sources s ${latestExtraction} where s.workspace_id=$1 order by s.created_at desc limit 500`,
      [scope.workspaceId],
    );
    const reviews = await db.query(
      `select ${reviewColumns} from aerion.reviews where workspace_id=$1 order by (status='pending') desc,created_at desc,id desc limit 500`,
      [scope.workspaceId],
    );
    const stats = await db.query(
      `select count(*)::int as "totalReviews", count(*) filter (where status='pending')::int as "pendingReviews", count(*) filter (where status='approved')::int as "approvedReviews" from aerion.reviews where workspace_id=$1`,
      [scope.workspaceId],
    );
    const modelProviders = modelProviderIds.map((id) => {
      const config = providerConfiguration(id);
      return { id, ready: config.ready, model: config.model };
    });
    return {
      ...stats.rows[0],
      sources: sources.rows,
      reviews: reviews.rows,
      modelReady: modelProviders.some((provider) => provider.ready),
      modelProviders,
    };
  });
}
export async function readReview(scope: Scope, id: string): Promise<ReviewRecord> {
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    const { rows } = await db.query(
      `select ${reviewColumns} from aerion.reviews where id=$1 and workspace_id=$2`,
      [id, scope.workspaceId],
    );
    if (!rows[0]) throw new HttpError(404, "Review not found in this workspace.");
    return rows[0];
  });
}
export async function readSource(scope: Scope, id: string, original = false) {
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    const { rows } = await db.query(
      `select ${sourceColumns} from aerion.sources s ${latestExtraction} where s.id=$1 and s.workspace_id=$2`,
      [id, scope.workspaceId],
    );
    if (!rows[0]) throw new HttpError(404, "Source not found in this workspace.");
    const document = original ? await documentStore.read(db, scope.workspaceId, id) : {};
    return { ...rows[0], ...document } as SourceRecord & { original: Buffer; contentType: string };
  });
}

export const reviewDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  values: z
    .partialRecord(z.enum(fieldNames), z.union([z.string().max(300), z.number(), z.null()]))
    .optional(),
  note: z.string().trim().max(2000),
  attested: z.boolean(),
});
export async function decideReview(
  scope: Scope,
  id: string,
  input: z.infer<typeof reviewDecisionSchema>,
) {
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    // All operations that change inventory lock the workspace before a review row.
    const workspace = await db.query(
      "select data,revision from aerion.workspaces where id=$1 for update",
      [scope.workspaceId],
    );
    const review = await db.query(
      "select * from aerion.reviews where id=$1 and workspace_id=$2 for update",
      [id, scope.workspaceId],
    );
    const row = review.rows[0];
    if (!row) throw new HttpError(404, "Review not found.");
    if (row.status !== "pending")
      throw new HttpError(409, "This candidate has already been reviewed.");
    let aircraftId: string | null = null;
    let finalValues: unknown = null;
    if (input.decision === "approve") {
      if (!input.attested)
        throw new HttpError(422, "Confirm that you reviewed the source before approving.");
      const source = await db.query(
        "select title,created_at from aerion.sources where id=$1 and workspace_id=$2",
        [row.source_id, scope.workspaceId],
      );
      const values = input.values ?? row.proposed;
      const edits = fieldNames.filter(
        (field) => (values[field] ?? null) !== (row.proposed[field] ?? null),
      );
      if (
        (edits.length ||
          row.warnings.some((warning: string) => warning.includes("conflicting values"))) &&
        !input.note
      )
        throw new HttpError(
          422,
          "Add a review note explaining corrections, newly supplied values, or how you resolved conflicting observations.",
        );
      const result = aircraftSchema.safeParse({
        ...values,
        id: randomUUID(),
        registration: values.registration || "Not supplied",
        engine: values.engine || "Not supplied",
        hours: values.hours ?? null,
        cycles: values.cycles ?? null,
        price: values.price ?? null,
        offering: values.offering || (values.price != null ? "Sale" : "Not supplied"),
        leaseRate: values.leaseRate ?? null,
        leaseCurrency: values.leaseCurrency || null,
        leaseBasis: values.leaseBasis || null,
        availableDate: values.availableDate || null,
        location: values.location || "Not supplied",
        country: values.country || "Not supplied",
        availability: "Reported",
        source: source.rows[0].title,
        sourceDate: new Date(source.rows[0].created_at).toISOString().slice(0, 10),
        notes: input.note,
        evidence: { sourceId: row.source_id, extractionId: row.extraction_id, reviewId: id },
      });
      if (!result.success)
        throw new HttpError(
          422,
          `Approval needs valid values: ${result.error.issues.map((i) => i.path.join(".")).join(", ")}. Keep this candidate pending until these facts are available.`,
        );
      const data = workspaceSchema.parse(workspace.rows[0].data);
      let next: Workspace;
      try {
        next = applyAction(data, { type: "aircraft", items: [result.data] });
      } catch (error) {
        throw new HttpError(409, error instanceof Error ? error.message : "Duplicate aircraft.");
      }
      aircraftId = result.data.id;
      finalValues = values;
      await db.query("update aerion.workspaces set data=$1,revision=revision+1 where id=$2", [
        next,
        scope.workspaceId,
      ]);
      await audit(db, scope, "aircraft.approved", aircraftId, {
        reviewId: id,
        sourceId: row.source_id,
        extractionId: row.extraction_id,
        editedFields: edits,
      });
    }
    await db.query(
      "update aerion.reviews set status=$1,reviewed_at=now(),reviewer=$2,aircraft_id=$3,final_values=$4,note=$5 where id=$6 and workspace_id=$7",
      [
        input.decision === "approve" ? "approved" : "rejected",
        scope.actorId,
        aircraftId,
        finalValues,
        input.note,
        id,
        scope.workspaceId,
      ],
    );
    await audit(db, scope, `review.${input.decision}`, id, { note: input.note });
    return { aircraftId };
  });
}
export type { ReviewRecord };
