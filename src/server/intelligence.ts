import { randomUUID } from "node:crypto";
import { z } from "zod";
import { applyAction } from "../lib/workspace";
import { requirementSchema, workspaceSchema } from "../lib/schema";
import {
  signalDecisionSchema,
  signalStages,
  type Intelligence,
  type SignalRecord,
} from "../lib/intelligence/market-schema";
import { audit, transaction, type Scope } from "./db";
import { HttpError } from "./http";

export const intelligenceQuerySchema = z.object({
  q: z.string().trim().max(200).default(""),
  stage: z.enum(["All", ...signalStages]).default("All"),
  market: z.enum(["All", "Commercial", "Business"]).default("All"),
  intent: z.enum(["All", "Demand", "Supply", "Fleet activity"]).default("All"),
  organization: z.string().max(300).default(""),
  family: z.string().max(300).default(""),
  geography: z.string().max(300).default(""),
  days: z.coerce
    .number()
    .int()
    .refine((n) => [0, 30, 90, 365].includes(n))
    .default(0),
  page: z.coerce.number().int().min(1).max(10000).default(1),
});
const columns = `g.id,g.source_id as "sourceId",g.extraction_id as "extractionId",g.facts,g.proposed,
 coalesce(g.final_values,g.proposed) as values,g.warnings,g.confidence,g.stage,g.revision,g.note,g.reviewer,
 g.reviewed_at as "reviewedAt",g.created_at as "createdAt",g.requirement_id as "requirementId",g.confirmation,
 s.title as "sourceTitle",s.created_at as "capturedAt",s.source_url as "sourceUrl"`;
export async function readIntelligence(
  scope: Scope,
  input: z.input<typeof intelligenceQuerySchema> = {},
): Promise<Intelligence> {
  const q = intelligenceQuerySchema.parse(input);
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    const values = [
      scope.workspaceId,
      q.q,
      q.stage,
      q.market,
      q.intent,
      q.organization,
      q.family,
      q.geography,
      q.days,
    ];
    const v = "coalesce(g.final_values,g.proposed)";
    const where = `g.workspace_id=$1
      and ($2='' or position(lower($2) in lower(${v}::text))>0)
      and ($3='All' or g.stage=$3) and ($4='All' or ${v}->>'market'=$4)
      and ($5='All' or ${v}->>'intent'=$5) and ($6='' or ${v}->>'organization'=$6)
      and ($7='' or ${v}->>'aircraftFamily'=$7) and ($8='' or ${v}->>'geography'=$8)
      and ($9::int=0 or (${v}->>'eventDate')::date between current_date - $9::int and current_date)`;
    const total = (
      await db.query(`select count(*)::int as n from aerion.signals g where ${where}`, values)
    ).rows[0].n as number;
    const pages = Math.max(1, Math.ceil(total / 40));
    const page = Math.min(q.page, pages);
    const signals = await db.query(
      `select ${columns} from aerion.signals g join aerion.sources s on s.id=g.source_id and s.workspace_id=g.workspace_id where ${where} order by g.created_at desc,g.id limit 40 offset $10`,
      [...values, (page - 1) * 40],
    );
    const grouped = await db.query(
      "select stage,count(*)::int as n from aerion.signals where workspace_id=$1 group by stage",
      [scope.workspaceId],
    );
    const counts = Object.fromEntries(
      signalStages.map((stage) => [stage, grouped.rows.find((r) => r.stage === stage)?.n ?? 0]),
    ) as Intelligence["counts"];
    const sources = await db.query(
      `select s.id,s.title,s.kind,s.source_url as "sourceUrl",s.filename,s.sha256,s.created_at as "createdAt",'[]'::jsonb as pages,
      coalesce(e.status,'ready') as status,e.error,e.provider,coalesce(e.attempts,0) as attempts from aerion.sources s
      left join lateral (select status,error,provider,attempts from aerion.extractions where source_id=s.id and workspace_id=s.workspace_id and purpose='market' order by created_at desc limit 1) e on true
      where s.workspace_id=$1 order by s.created_at desc limit 500`,
      [scope.workspaceId],
    );
    const facets: Intelligence["facets"] = { organizations: [], families: [], geographies: [] };
    for (const [key, field] of [
      ["organizations", "organization"],
      ["families", "aircraftFamily"],
      ["geographies", "geography"],
    ] as const) {
      const result = await db.query(
        `select distinct coalesce(final_values,proposed)->>$2 as value from aerion.signals where workspace_id=$1 and coalesce(final_values,proposed)->>$2 is not null order by value limit 200`,
        [scope.workspaceId, field],
      );
      facets[key] = result.rows.map((r) => r.value);
    }
    return { signals: signals.rows, total, page, pages, counts, sources: sources.rows, facets };
  });
}
export async function readSignal(scope: Scope, id: string): Promise<SignalRecord> {
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    const { rows } = await db.query(
      `select ${columns} from aerion.signals g join aerion.sources s on s.id=g.source_id and s.workspace_id=g.workspace_id where g.id=$1 and g.workspace_id=$2`,
      [id, scope.workspaceId],
    );
    if (!rows[0]) throw new HttpError(404, "Signal not found in this workspace.");
    return rows[0];
  });
}
export async function decideSignal(
  scope: Scope,
  id: string,
  raw: z.input<typeof signalDecisionSchema>,
) {
  const input = signalDecisionSchema.parse(raw);
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    // Keep the same workspace-before-review lock order as inventory approval.
    const workspace = await db.query("select data from aerion.workspaces where id=$1 for update", [
      scope.workspaceId,
    ]);
    const result = await db.query(
      "select * from aerion.signals where id=$1 and workspace_id=$2 for update",
      [id, scope.workspaceId],
    );
    const row = result.rows[0];
    if (!row || !workspace.rows[0]) throw new HttpError(404, "Signal not found in this workspace.");
    if (row.revision !== input.revision)
      throw new HttpError(
        409,
        "This signal changed in another session. Reopen it before deciding.",
      );
    const nextStage = {
      lead: "Lead",
      potential: "Potential requirement",
      confirm: "Confirmed requirement",
      dismiss: "Dismissed",
    } as const;
    const previous = {
      lead: "Signal",
      potential: "Lead",
      confirm: "Potential requirement",
    } as const;
    if (
      ["Confirmed requirement", "Dismissed"].includes(row.stage) ||
      (input.action !== "dismiss" && row.stage !== previous[input.action])
    )
      throw new HttpError(
        409,
        "Review each stage in order. Completed decisions cannot be changed.",
      );
    if (input.action !== "dismiss") {
      if (!input.attested)
        throw new HttpError(422, "Confirm that you checked the source and reviewed the signal.");
      if (!input.values.organization || !input.values.aircraftFamily || !input.values.intent)
        throw new HttpError(
          422,
          "Supply an organization, aircraft family and signal type before qualifying a lead.",
        );
      if (input.action !== "lead" && input.values.intent !== "Demand")
        throw new HttpError(
          422,
          "Only a reviewed demand signal can become a buyer requirement. Fleet activity and supply remain leads.",
        );
    }
    let requirementId: string | null = null;
    if (input.action === "confirm") {
      if (!input.confirmation || !input.requirement)
        throw new HttpError(
          422,
          "Record the buyer confirmation and complete requirement before confirming.",
        );
      if (input.confirmation.confirmedOn > new Date().toISOString().slice(0, 10))
        throw new HttpError(422, "Buyer confirmation cannot be dated in the future.");
      const r = input.requirement;
      const v = input.values;
      if (
        r.client !== v.organization ||
        r.aircraftModel !== v.aircraftFamily ||
        r.category !== v.market ||
        r.quantity !== v.quantity
      )
        throw new HttpError(
          422,
          "The requirement must match the reviewed organization, aircraft family, market and quantity.",
        );
      requirementId = randomUUID();
      const requirement = requirementSchema.parse({
        ...r,
        id: requirementId,
        status: "Confirmed",
        intelligence: { sourceId: row.source_id, extractionId: row.extraction_id, signalId: id },
      });
      const next = applyAction(workspaceSchema.parse(workspace.rows[0].data), {
        type: "requirement",
        item: requirement,
      });
      await db.query("update aerion.workspaces set data=$1,revision=revision+1 where id=$2", [
        next,
        scope.workspaceId,
      ]);
      await audit(db, scope, "requirement.confirmed", requirementId, {
        signalId: id,
        confirmation: input.confirmation,
      });
    }
    await db.query(
      `update aerion.signals set stage=$1,final_values=$2,revision=revision+1,note=$3,reviewer=$4,reviewed_at=now(),confirmation=$5,requirement_id=$6 where id=$7 and workspace_id=$8`,
      [
        nextStage[input.action],
        input.values,
        input.note,
        scope.actorId,
        input.action === "confirm" ? input.confirmation : null,
        requirementId,
        id,
        scope.workspaceId,
      ],
    );
    await audit(db, scope, `signal.${input.action}`, id, {
      from: row.stage,
      to: nextStage[input.action],
      values: input.values,
      note: input.note,
      sourceId: row.source_id,
    });
    return { requirementId };
  });
}
