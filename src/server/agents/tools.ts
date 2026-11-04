import { z } from "zod";
import { zodResponsesFunction } from "openai/helpers/zod";
import type { AgentRun, AgentProposal, SourceConnector, Citation } from "../../lib/agents/schema";
import { proposalSchema, leadActionSchema, requirementActionSchema } from "../../lib/agents/schema";
import { enrichmentActionSchema } from "../../lib/leads/schema";
import { agentById } from "../../lib/agents/catalog";
import { sourcingKindSchema, workspaceSchema } from "../../lib/schema";
import { calendarDate } from "../../lib/format";
import type { SourceRecord } from "../../lib/intelligence/schema";
import { transaction, type Scope } from "../db";
import { HttpError } from "../http";
import { readExecution } from "../execution";
import { readCommercialContext } from "./commercial-context";
import { createSource, readReview } from "../repository";
import { enqueueExtraction } from "../jobs";
import { actionAllowed } from "./repository";
import { collectMailbox } from "./mailbox";
import { connectorText, fetchPublicSource } from "./collector";
import { discoverSources, inspectDiscoverySource } from "../discovery/service";
import { existingLeadId, existingPendingLead } from "../discovery/identity";
import { validateLeadAction } from "../leads/guards";
import {
  fingerprint,
  proposalContext,
  validateCitations,
  validateProposedFacts,
  validateInteractionParty,
  leadCitationHints,
  validateDuplicateAction,
} from "./evidence";
const noArgs = z.object({}).strict();
// Saved legacy briefs may omit their kind. New model calls must choose explicitly,
// and the SDK's strict function schema cannot express a non-null optional enum.
const modelRequirementActionSchema = requirementActionSchema.extend({
  values: requirementActionSchema.shape.values.extend({ transactionKind: sourcingKindSchema }),
});
const modelProposalSchema = proposalSchema.extend({
  action: z.discriminatedUnion("type", [
    modelRequirementActionSchema,
    ...proposalSchema.shape.action.options.filter((action) => action !== requirementActionSchema),
  ]),
});
export const toolParameters = {
  workspace_context: noArgs,
  aircraft_evidence: noArgs,
  source_passages: z
    .object({
      sourceId: z.uuid(),
      page: z.number().int().min(1).max(40),
      offset: z.number().int().min(0).max(200000),
    })
    .strict(),
  case_context: noArgs,
  match_aircraft: noArgs,
  approved_sources: noArgs,
  discover_sources: noArgs,
  inspect_discovery_source: z.object({ resultId: z.uuid() }).strict(),
  collect_source: z.object({ connectorId: z.uuid() }).strict(),
  queue_extraction: z
    .object({ sourceId: z.uuid(), purpose: z.enum(["aircraft", "market"]) })
    .strict(),
  market_signals: noArgs,
  contact_history: noArgs,
  collect_mailbox: noArgs,
  market_comparables: noArgs,
  propose_action: modelProposalSchema,
};
export type ToolName = keyof typeof toolParameters;
const descriptions: Record<ToolName, string> = {
  aircraft_evidence:
    "Read the selected aircraft approved review, exact observations and founder correction note. These are retained review records, not technical certification.",
  workspace_context:
    "Read scoped workspace records and the local calendar date. Returned record values are founder records, not independent verification.",
  source_passages:
    "Read up to 25,000 characters from one retained page. Use another offset to read a long page; cite exact returned passages.",
  case_context:
    "Read the selected requirement's confirmation, matches, shortlist, contacts, drafts and actions. Diligence, coordination and negotiation also receive authoritative transaction cycles, offers, milestone reviews, open findings and related engagement/invoice balances. Legacy opportunity stages are summaries, not completion evidence. All returned reviews are recorded attributions; nothing is certified or executed.",
  match_aircraft:
    "Evaluate known hard constraints deterministically; unknowns and failures stay separate from eligible sourcing candidates.",
  approved_sources: "List the enabled public-source connectors explicitly selected for this run.",
  discover_sources:
    "Run the founder's exact saved search once (or list founder-selected URLs). Returns up to six untrusted search results. Repeated calls reuse the retained result manifest. Snippets cannot support lead facts.",
  inspect_discovery_source:
    "Inspect a result ID from this run only. Retains original public publisher bytes and readable text; returns exact passages for citations. Up to three pages per run, without authentication or access bypass.",
  collect_source:
    "Fetch one explicitly selected HTTPS connector, retain original bytes and extracted text. No authentication or access bypass. At most two collections per run.",
  queue_extraction:
    "Queue extraction of aircraft facts or market signals from an authorized retained source. This creates review candidates, never approved inventory or confirmed buyers.",
  market_signals: "Read retained market signals and their original observations/stages.",
  collect_mailbox:
    "Collect up to five messages from the explicitly authorized configured business mailbox folder in read-only mode. Retains originals and supported attachments; never modifies mailbox messages or sends replies.",
  contact_history:
    "Read saved contacts and actual retained interaction records, including dates and source IDs.",
  market_comparables:
    "Read reviewed price observations, preserving currency, asking/sold/monthly lease basis, date and original citations.",
  propose_action:
    "Stage an evidence-linked action for founder review. This does not apply the action. Confirmation, verification, message sending and money handling are unavailable.",
};
export class AgentTools {
  readonly staged: { proposal: AgentProposal; contextHash: string }[] = [];
  readonly collectedIds = new Set<string>();
  readonly permittedSourceIds = new Set<string>();
  private collected = 0;
  private calls = 0;
  private extractions = 0;
  private hasCommercialContext() {
    return ["due-diligence", "deal-coordination", "negotiation"].includes(this.run.agentId);
  }
  constructor(
    readonly scope: Scope,
    readonly run: AgentRun,
    readonly signal: AbortSignal,
    readonly trace: (tool: string, input: unknown, output: unknown) => Promise<void>,
    readonly check: () => Promise<void>,
  ) {}
  private availableTools() {
    const granted = agentById(this.run.agentId).tools;
    return this.run.input.discovery
      ? granted.filter((name) =>
          [
            "workspace_context",
            "discover_sources",
            "inspect_discovery_source",
            "source_passages",
            "propose_action",
          ].includes(name),
        )
      : this.run.input.leadId
        ? granted.filter((name) =>
            ["workspace_context", "source_passages", "propose_action"].includes(name),
          )
        : granted;
  }
  definitions() {
    return this.availableTools().map((name) =>
      zodResponsesFunction({
        name,
        description: descriptions[name as ToolName],
        parameters:
          name === "propose_action" && this.run.input.discovery
            ? proposalSchema.extend({
                action:
                  this.run.input.discovery.purpose === "contacts"
                    ? enrichmentActionSchema
                    : leadActionSchema,
              })
            : name === "propose_action" &&
                this.run.input.leadId &&
                this.run.agentId === "buyer-requirements"
              ? proposalSchema.extend({ action: modelRequirementActionSchema })
              : toolParameters[name as ToolName],
      }),
    );
  }

  async data() {
    return transaction(this.scope.actorId, this.scope.workspaceId, async (db) => {
      const result = await db.query("select data from aerion.workspaces where id=$1", [
        this.scope.workspaceId,
      ]);
      if (!result.rows[0]) throw new HttpError(404, "Workspace not found.");
      return workspaceSchema.parse(result.rows[0].data);
    });
  }
  async sources(): Promise<SourceRecord[]> {
    const data = await this.data(),
      ids = new Set([
        ...this.run.input.sourceIds,
        ...this.collectedIds,
        ...this.permittedSourceIds,
      ]);
    const aircraft = data.aircraft.find((a) => a.id === this.run.input.aircraftId);
    if (aircraft?.evidence) ids.add(aircraft.evidence.sourceId);
    const requirement = data.requirements.find((r) => r.id === this.run.input.requirementId);
    if (requirement?.intelligence) ids.add(requirement.intelligence.sourceId);
    if (requirement) {
      const desk = await readExecution(this.scope, requirement.id);
      for (const item of desk.readiness) ids.add(item.sourceId);
      for (const match of desk.matches.slice(0, 20))
        if (match.aircraft.evidence) ids.add(match.aircraft.evidence.sourceId);
      if (this.hasCommercialContext()) {
        const commercial = await readCommercialContext(
          this.scope,
          requirement.id,
          this.run.input.aircraftId,
        );
        for (const id of commercial.sourceIds) ids.add(id);
      }
    }
    return transaction(
      this.scope.actorId,
      this.scope.workspaceId,
      async (db) =>
        (
          await db.query(
            'select id,title,kind,pages,source_url as "sourceUrl",created_at as "createdAt" from aerion.sources where workspace_id=$1 and id=any($2::uuid[]) order by created_at',
            [this.scope.workspaceId, [...ids]],
          )
        ).rows,
    );
  }
  async connectors(): Promise<SourceConnector[]> {
    return transaction(
      this.scope.actorId,
      this.scope.workspaceId,
      async (db) =>
        (
          await db.query(
            'select id,name,url,format,purpose,enabled,last_collected_at as "lastCollectedAt" from aerion.source_connectors where workspace_id=$1 and id=any($2::uuid[]) and enabled',
            [this.scope.workspaceId, this.run.input.connectorIds],
          )
        ).rows,
    );
  }
  async invoke(name: string, raw: unknown): Promise<unknown> {
    await this.check();
    this.signal.throwIfAborted();
    if (!this.availableTools().includes(name))
      throw new HttpError(403, "This tool is not granted to the selected agent.");
    if (++this.calls > 30) throw new HttpError(422, "The run reached its 30-tool-call limit.");
    const parsed = toolParameters[name as ToolName].parse(raw);
    let output: unknown;
    try {
      output = await this.execute(name as ToolName, parsed);
    } catch (error) {
      const message =
        error instanceof HttpError
          ? error.message
          : error instanceof z.ZodError
            ? "Tool arguments failed validation."
            : error instanceof Error
              ? error.message.slice(0, 300)
              : "Tool failed.";
      await this.trace(name, parsed, { error: message });
      throw error;
    }
    await this.trace(name, parsed, output);
    return output;
  }
  private async execute(name: ToolName, args: unknown): Promise<unknown> {
    const { scope, run } = this;
    switch (name) {
      case "discover_sources":
        return discoverSources(scope, run, this.signal);
      case "inspect_discovery_source": {
        const { resultId } = toolParameters.inspect_discovery_source.parse(args);
        const result = await inspectDiscoverySource(scope, run, resultId, this.signal);
        this.permittedSourceIds.add(result.sourceId);
        return result;
      }
      case "workspace_context": {
        if (run.input.leadId) {
          const lead = await transaction(
            scope.actorId,
            scope.workspaceId,
            async (db) =>
              (
                await db.query(
                  "select l.id,l.values,c.status,c.requirement_id from aerion.discovery_leads l join aerion.lead_cases c on c.lead_id=l.id and c.workspace_id=l.workspace_id where l.workspace_id=$1 and l.id=$2",
                  [scope.workspaceId, run.input.leadId],
                )
              ).rows[0],
          );
          return {
            today: calendarDate(),
            lead,
            discovery: run.input.discovery,
            sources: (await this.sources()).map(({ id, title }) => ({ id, title })),
            evidence: (await this.sources()).slice(0, 5).flatMap((source) =>
              source.pages.slice(0, 1).map((page) => ({
                sourceId: source.id,
                page: page.page,
                quote: page.text.slice(0, 1200),
              })),
            ),
          };
        }
        if (run.input.discovery)
          return {
            today: calendarDate(),
            discovery: run.input.discovery,
            sources: (await this.sources()).map(({ id, title }) => ({ id, title })),
          };
        const data = await this.data();
        return {
          today: calendarDate(),
          requirement: run.input.requirementId
            ? data.requirements.find((r) => r.id === run.input.requirementId)
            : null,
          aircraft: run.input.aircraftId
            ? data.aircraft.find((a) => a.id === run.input.aircraftId)
            : null,
          contact: run.input.contactId
            ? data.contacts.find((c) => c.id === run.input.contactId)
            : null,
          inventory: data.aircraft.slice(0, 30).map(compactAircraft),
          requirements: data.requirements
            .slice(0, 30)
            .map(({ description: _description, ...r }) => r),
          contacts: data.contacts.slice(0, 30).map(({ notes: _notes, ...c }) => c),
          counts: {
            aircraft: data.aircraft.length,
            requirements: data.requirements.length,
            contacts: data.contacts.length,
            deals: data.deals.length,
          },
          sources: (await this.sources()).map((s) => ({
            id: s.id,
            title: s.title,
            pages: s.pages.length,
          })),
          evidence: (await this.sources()).slice(0, 5).flatMap((source) =>
            source.pages.slice(0, 1).map((page) => ({
              sourceId: source.id,
              page: page.page,
              quote: page.text.slice(0, 1200),
            })),
          ),
          note: "Arrays are bounded; select a specific record for a focused run. These are founder records and reported source observations.",
        };
      }
      case "aircraft_evidence": {
        const data = await this.data(),
          aircraft = data.aircraft.find((a) => a.id === run.input.aircraftId);
        if (!aircraft?.evidence)
          return { missing: "Select an aircraft with an approved original-source review." };
        const review = await readReview(scope, aircraft.evidence.reviewId);
        return {
          aircraftId: aircraft.id,
          sourceId: review.sourceId,
          reviewId: review.id,
          facts: review.facts,
          reviewNote: review.note,
          status: review.status,
        };
      }
      case "source_passages": {
        const input = toolParameters.source_passages.parse(args),
          source = (await this.sources()).find((s) => s.id === input.sourceId);
        if (!source)
          throw new HttpError(404, "This source was not selected or linked to this run's context.");
        const page = source.pages.find((p) => p.page === input.page);
        if (!page) throw new HttpError(404, "Source page not found.");
        return {
          sourceId: source.id,
          title: source.title,
          page: page.page,
          offset: input.offset,
          text: page.text.slice(input.offset, input.offset + 25000),
          more: page.text.length > input.offset + 25000,
          totalCharacters: page.text.length,
        };
      }
      case "case_context": {
        if (!run.input.requirementId)
          return { missing: "Select a requirement to inspect its execution desk." };
        const desk = await readExecution(scope, run.input.requirementId);
        const commercial = this.hasCommercialContext()
          ? await readCommercialContext(scope, run.input.requirementId, run.input.aircraftId)
          : null;
        for (const id of commercial?.sourceIds ?? []) this.permittedSourceIds.add(id);
        return {
          ...desk,
          ...(commercial ? { commercial } : {}),
          matches: desk.matches
            .slice(0, 30)
            .map(({ requirement: _requirement, aircraft, ...m }) => ({
              ...m,
              aircraft: compactAircraft(aircraft),
            })),
          availableContacts: desk.availableContacts
            .slice(0, 30)
            .map(({ notes: _notes, ...c }) => c),
          contacts: desk.contacts.slice(0, 30).map(({ notes: _notes, ...c }) => c),
          actions: desk.actions.slice(0, 40).map((a) => ({ ...a, detail: a.detail.slice(0, 500) })),
          drafts: desk.drafts.map((d) => ({
            id: d.id,
            aircraftId: d.aircraftId,
            contactId: d.contactId,
            audience: d.audience,
            status: d.status,
            subject: d.subject,
            stale: d.stale,
          })),
          sources: undefined,
          activity: [],
          note: "Match list shows up to 30 candidates. Commercial context has explicit coverage limits and is restricted to this requirement and selected aircraft. Its transaction status is authoritative; legacy deal.stage and the earlier readiness checklist do not replace current transaction milestones. Recorded completion, earned fees, issued invoices and allocated receipts are separate events. Full records remain available in the execution, transaction and revenue workspaces.",
        };
      }
      case "match_aircraft": {
        const data = await this.data(),
          r = data.requirements.find((item) => item.id === run.input.requirementId);
        if (!r) return { missing: "Select a saved requirement before matching." };
        const desk = await readExecution(scope, r.id);
        const matches = desk.matches;
        return {
          requirement: r,
          requalificationRequired: desk.requalificationRequired ?? false,
          supersededBy: desk.supersededBy ?? null,
          matches: matches.slice(0, 40).map(({ requirement: _requirement, aircraft, ...m }) => ({
            ...m,
            aircraft: compactAircraft(aircraft),
          })),
          total: matches.length,
          counts: {
            eligible: matches.filter((m) => m.state === "eligible").length,
            unknown: matches.filter((m) => m.state === "needs-review").length,
            excluded: matches.filter((m) => m.state === "excluded").length,
          },
        };
      }
      case "approved_sources":
        return {
          connectors: await this.connectors(),
          collectionAllowed: run.input.allowExternalSources,
        };
      case "collect_source": {
        if (!run.input.allowExternalSources)
          throw new HttpError(403, "External collection was not enabled for this run.");
        const input = toolParameters.collect_source.parse(args),
          connector = (await this.connectors()).find((c) => c.id === input.connectorId);
        if (!connector) throw new HttpError(404, "Connector not selected or enabled.");
        if (++this.collected > 2)
          throw new HttpError(
            422,
            "This run reached its two-source collection limit. Use another run for remaining connectors.",
          );
        const response = await fetchPublicSource(connector.url, 3, undefined, this.signal),
          text = connectorText(response.original, connector.format, response.contentType);
        this.signal.throwIfAborted();
        await this.check();
        let sourceId: string,
          duplicate = false;
        try {
          sourceId = (
            await createSource(scope, {
              title: connector.name,
              kind: "text",
              sourceUrl: response.url,
              filename: `${connector.format}-${connector.id}.txt`,
              contentType: response.contentType,
              original: response.original,
              pages: [{ page: 1, text }],
            })
          ).id;
        } catch (error) {
          if (!(error instanceof HttpError && error.status === 409)) throw error;
          const result = await transaction(scope.actorId, scope.workspaceId, (db) =>
            db.query("select id from aerion.sources where workspace_id=$1 and sha256=$2", [
              scope.workspaceId,
              fingerprintBytes(response.original),
            ]),
          );
          if (!result.rows[0]) throw error;
          sourceId = result.rows[0].id;
          duplicate = true;
        }
        this.collectedIds.add(sourceId);
        await transaction(scope.actorId, scope.workspaceId, (db) =>
          db.query(
            "update aerion.source_connectors set last_collected_at=now() where id=$1 and workspace_id=$2",
            [connector.id, scope.workspaceId],
          ),
        );
        return {
          sourceId,
          duplicate,
          title: connector.name,
          purpose: connector.purpose,
          retained: true,
          characters: text.length,
        };
      }
      case "queue_extraction": {
        const input = toolParameters.queue_extraction.parse(args);
        if (!(await this.sources()).some((s) => s.id === input.sourceId))
          throw new HttpError(404, "Source not authorized for this run.");
        if (++this.extractions > 4)
          throw new HttpError(
            422,
            "Up to four extraction requests are allowed per agent run. Extraction jobs have their own provider usage.",
          );
        try {
          return {
            queued: true,
            ...(await enqueueExtraction(
              scope,
              input.sourceId,
              run.provider === "rules" ? "local" : run.provider,
              input.purpose,
              run.model ?? undefined,
            )),
          };
        } catch (error) {
          if (error instanceof HttpError && error.status === 409)
            return { queued: false, alreadyExists: true, detail: error.message };
          throw error;
        }
      }
      case "market_signals": {
        const result = await transaction(
          scope.actorId,
          scope.workspaceId,
          async (db) =>
            (
              await db.query(
                'select id,source_id as "sourceId",stage,confidence,facts,coalesce(final_values,proposed) as values,confirmation,requirement_id as "requirementId" from aerion.signals where workspace_id=$1 order by created_at desc limit 80',
                [scope.workspaceId],
              )
            ).rows,
        );
        for (const item of result) this.permittedSourceIds.add(item.sourceId);
        return { signals: result };
      }
      case "collect_mailbox": {
        if (!run.input.allowMailbox)
          throw new HttpError(403, "Mailbox collection was not explicitly enabled for this run.");
        const result = await collectMailbox(scope, this.signal);
        for (const message of result.messages) {
          this.permittedSourceIds.add(message.sourceId);
          for (const id of message.attachmentIds) this.permittedSourceIds.add(id);
        }
        return result;
      }
      case "contact_history": {
        const data = await this.data();
        const result = await transaction(scope.actorId, scope.workspaceId, async (db) => ({
          contacts: run.input.contactId
            ? data.contacts.filter((c) => c.id === run.input.contactId)
            : data.contacts.slice(0, 80),
          interactions: (
            await db.query(
              'select id,contact_id as "contactId",requirement_id as "requirementId",source_id as "sourceId",to_char(occurred_on,\'YYYY-MM-DD\') as "occurredOn",direction,summary from aerion.contact_interactions where workspace_id=$1 and ($2::text is null or contact_id=$2) order by occurred_on desc,created_at desc limit 100',
              [scope.workspaceId, run.input.contactId],
            )
          ).rows,
          submissions: (
            await db.query(
              `select id,contact_id as "contactId",requirement_id as "requirementId",status,subject,recipient,finished_at as "finishedAt",to_char(finished_at at time zone 'Asia/Kolkata','YYYY-MM-DD') as "occurredOn" from aerion.mail_deliveries where workspace_id=$1 and ($2::text is null or contact_id=$2) order by created_at desc limit 100`,
              [scope.workspaceId, run.input.contactId],
            )
          ).rows,
          note: "Interactions retain original message evidence. SMTP submissions are separate operational records: accepted means accepted by the sending server, never recipient delivery or a reply. No record means the last contact date is unknown.",
        }));
        for (const item of result.interactions) this.permittedSourceIds.add(item.sourceId);
        return result;
      }
      case "market_comparables": {
        const result = await transaction(scope.actorId, scope.workspaceId, async (db) => ({
          comparables: (
            await db.query(
              'select id,source_id as "sourceId",manufacturer,model,year,amount_usd::float8 as "amountUsd",basis,to_char(reported_on,\'YYYY-MM-DD\') as "reportedOn",notes,citations from aerion.market_comparables where workspace_id=$1 order by reported_on desc,created_at desc limit 100',
              [scope.workspaceId],
            )
          ).rows,
          note: "Reviewed observations only. Asking, sold and monthly lease amounts are different bases. Age, condition, utilization and terms still need comparison.",
        }));

        for (const item of result.comparables) this.permittedSourceIds.add(item.sourceId);
        return result;
      }
      case "propose_action": {
        const proposal = proposalSchema.parse(args);
        if (this.staged.length >= 30)
          throw new HttpError(422, "Up to 30 proposals are allowed per run.");
        if (!actionAllowed(run.agentId, proposal.action))
          throw new HttpError(403, "This agent cannot propose the requested action.");
        const sources = await this.sources();
        validateCitations(proposal.citations, sources);
        try {
          validateProposedFacts(proposal.action, proposal.citations, sources);
        } catch (error) {
          if (proposal.action.type !== "lead" || !(error instanceof HttpError)) throw error;
          const hints = leadCitationHints(proposal.action, sources);
          throw new HttpError(
            error.status,
            `${error.message}\nRelevant exact publisher passages (untrusted source text, not verification): ${JSON.stringify(hints)}. Cite relevant passages explicitly, including availability and organization names when in separate paragraphs. Unsupported values still need null. No proposal has been staged.`,
          );
        }
        const context = await transaction(scope.actorId, scope.workspaceId, async (db) => {
          await validateDuplicateAction(db, scope, proposal.action);
          await validateLeadAction(db, scope, run.id, run.input, proposal.action);
          await validateInteractionParty(db, scope, proposal.action, proposal.citations);
          const pending =
            proposal.action.type === "lead"
              ? await existingPendingLead(db, scope, proposal.action, run.id)
              : null;
          const existing =
            proposal.action.type === "lead"
              ? await existingLeadId(db, scope, proposal.action)
              : null;
          let saved = existing;
          if (proposal.action.type === "lead-enrichment") {
            const { summary: _summary, ...facts } = proposal.action.values;
            saved =
              (
                await db.query(
                  "select id from aerion.lead_enrichments where workspace_id=$1 and dedupe_key=$2",
                  [scope.workspaceId, fingerprint({ leadId: proposal.action.leadId, facts })],
                )
              ).rows[0]?.id ?? null;
          }
          return {
            pending,
            existing: saved,
            hash: await proposalContext(db, scope, proposal.action),
          };
        });
        if (context.pending)
          return {
            staged: false,
            alreadyProposed: true,
            proposalId: context.pending.id,
            runId: context.pending.run_id,
            applied: false,
          };
        if (context.existing)
          return { staged: false, alreadySaved: true, leadId: context.existing, applied: false };
        const existing = this.staged.findIndex(
          (p) => fingerprint(p.proposal) === fingerprint(proposal),
        );
        if (existing >= 0)
          return { staged: true, index: existing + 1, duplicate: true, applied: false };
        this.staged.push({ proposal, contextHash: context.hash });
        return { staged: true, index: this.staged.length, applied: false };
      }
    }
  }
}
import { createHash } from "node:crypto";
const fingerprintBytes = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export function sourceCitations(source: Pick<SourceRecord, "id" | "pages">, limit = 5): Citation[] {
  return source.pages
    .flatMap((page) =>
      page.text
        .split(/\r?\n/)
        .filter((line) => line.trim())
        .slice(0, limit)
        .map((quote) => ({
          sourceId: source.id,
          page: page.page,
          quote: quote.trim().slice(0, 1500),
        })),
    )
    .slice(0, limit);
}

function compactAircraft({ notes: _notes, ...aircraft }: import("../../lib/schema").Aircraft) {
  return aircraft;
}
