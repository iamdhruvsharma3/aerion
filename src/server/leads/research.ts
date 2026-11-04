import { z } from "zod";
import { retiredReplySourceIds } from "../communication/context";
import { runInputSchema } from "../../lib/agents/schema";
import { agentProviderSchema } from "../../lib/agents/schema";
import { transaction, type Scope } from "../db";
import { HttpError } from "../http";
import { enqueueAgent } from "../agents/repository";
import { enqueueExtraction } from "../jobs";
import { leadEnvelope } from "./drafts";

export const leadResearchSchema = z.object({
  revision: z.number().int().nonnegative(),
  kind: z.enum(["contacts", "brief", "aircraft"]),
  provider: agentProviderSchema,
  allowExternalSources: z.boolean(),
  allowModelData: z.boolean(),
  urls: z.array(z.url().max(2000)).max(3).default([]),
  sourceIds: z.array(z.uuid()).max(20).optional(),
  idempotencyKey: z.uuid(),
});
export async function researchLead(scope: Scope, id: string, raw: unknown) {
  const input = leadResearchSchema.parse(raw);
  const { lead, sources } = await transaction(scope.actorId, scope.workspaceId, async (db) => {
    const context = await leadEnvelope(db, scope, id);
    if (context.row.revision !== input.revision)
      throw new HttpError(409, "This lead changed. Reload before starting research.");
    if (context.row.status === "Dismissed")
      throw new HttpError(422, "Reopen this lead before research.");
    const sources = (
      await db.query(
        "select source_id,purpose from aerion.lead_sources where workspace_id=$1 and lead_id=$2",
        [scope.workspaceId, id],
      )
    ).rows;
    const retired = await retiredReplySourceIds(db, scope, id);
    return { lead: context.lead, sources: sources.filter((source) => !retired.has(source.source_id)) };
  });
  if (input.kind === "aircraft") {
    if (lead.values.side !== "Seller")
      throw new HttpError(422, "Aircraft extraction belongs to seller-side evidence.");
    if (input.provider !== "rules" && !input.allowModelData)
      throw new HttpError(422, "Allow model data use for aircraft extraction.");
    const result = await enqueueExtraction(
      scope,
      lead.sourceId,
      input.provider === "rules" ? "local" : input.provider,
      "aircraft",
    );
    return { extractionId: result.id, sourceId: lead.sourceId };
  }
  if (input.kind === "brief" && lead.values.side !== "Buyer")
    throw new HttpError(422, "Buyer-brief extraction belongs to a buyer lead.");
  const briefSources = sources
    .filter((s) => s.purpose === "Buyer brief")
    .map((s) => s.source_id as string);
  const selectedSources = input.sourceIds ?? briefSources.slice(0, 20);
  if (input.kind === "brief" && selectedSources.some((id) => !briefSources.includes(id)))
    throw new HttpError(422, "Select only buyer briefs attached to this lead.");
  const original = {
    agentId: input.kind === "contacts" ? "crm" : "buyer-requirements",
    provider: input.provider,
    leadId: id,
    aircraftId: null,
    requirementId: null,
    contactId: null,
    connectorIds: [],
    sourceIds: input.kind === "brief" ? selectedSources : [lead.sourceId],
    allowExternalSources: input.allowExternalSources,
    allowModelData: input.allowModelData,
    allowMailbox: false,
    idempotencyKey: input.idempotencyKey,
    objective:
      input.kind === "contacts"
        ? "Research published business contact details for the selected organization. Prefer its official contact/acquisitions pages. Attribute every contact detail to that organization in exact retained quotes. Do not guess email addresses or treat a publisher's contact as the buyer. Propose lead-enrichment only, never send a message."
        : `Read the attached buyer reply/brief. Propose a Draft requirement linked to leadId ${id} only when all required values are explicitly supported. Identify exact missing questions otherwise; do not guess a market, quantity, year, currency or destination.`,
  };
  if (input.kind === "brief" && !original.sourceIds.length)
    throw new HttpError(422, "Attach a retained buyer reply or brief before analysis.");
  if (input.kind === "contacts") {
    if (!lead.values.organization)
      throw new HttpError(422, "A stated organization is needed for contact research.");
    const name = lead.values.organization.replace(/["\r\n]/g, " ").slice(0, 160);
    return enqueueAgent(
      scope,
      runInputSchema.parse({
        ...original,
        discovery: {
          side: lead.values.side,
          purpose: "contacts",
          target: name.slice(0, 120),
          market: "Any",
          region: "",
          method: input.urls.length ? "urls" : "web",
          query: input.urls.length ? "" : `"${name}" aircraft contact acquisitions email`,
          urls: input.urls,
          freshness: "any",
        },
      }),
    );
  }
  return enqueueAgent(scope, runInputSchema.parse(original));
}
