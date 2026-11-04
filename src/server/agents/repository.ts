import { agentProviderIds } from "../../lib/agents/providers";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { agentById, agentPromptVersion, type AgentId } from "../../lib/agents/catalog";
import {
  connectorSchema,
  runInputSchema,
  scheduleSchema,
  proposalSchema,
  type RunInput,
  type AgentCenter,
  type AgentRun,
  type AgentRunDetail,
  type AgentProposal,
  type ProposalAction,
  type Citation,
} from "../../lib/agents/schema";
import { workspaceSchema } from "../../lib/schema";
import { calendarDate } from "../../lib/format";
import { audit, transaction, type Scope } from "../db";
import { HttpError } from "../http";
import { mutateExecutionInTransaction } from "../execution";
import { mutateWorkspaceInTransaction } from "../repository";
import { connectorUrl } from "./collector";
import {
  fingerprint,
  proposalContext,
  validateCitations,
  validateProposedFacts,
  validateInteractionParty,
  validateDuplicateAction,
} from "./evidence";
import { providerConfiguration } from "./providers";
import { mailConfiguration, requireMail } from "./mail-config";
import { searchConfiguration } from "../discovery/search";
import { enforceOperation } from "../operations/limits";
import { retiredReplySourceIds } from "../communication/context";
import { leadIdentity, existingLeadId, existingPendingLead } from "../discovery/identity";
import { validateLeadAction } from "../leads/guards";
const runColumns = `id,agent_id as "agentId",provider,model,status,input,attempts,revision,report,error,usage,created_at as "createdAt",finished_at as "finishedAt"`;
export async function validateInput(db: PoolClient, scope: Scope, input: RunInput) {
  const result = await db.query("select data from aerion.workspaces where id=$1", [
    scope.workspaceId,
  ]);
  if (!result.rows[0]) throw new HttpError(404, "Workspace not found.");
  const data = workspaceSchema.parse(result.rows[0].data);
  if (input.requirementId && !data.requirements.some((r) => r.id === input.requirementId))
    throw new HttpError(404, "Requirement not found.");
  if (input.aircraftId && !data.aircraft.some((a) => a.id === input.aircraftId))
    throw new HttpError(404, "Aircraft not found.");
  if (input.contactId && !data.contacts.some((c) => c.id === input.contactId))
    throw new HttpError(404, "Contact not found.");
  const sources = await db.query(
    "select id,pages from aerion.sources where workspace_id=$1 and id=any($2::uuid[])",
    [scope.workspaceId, input.sourceIds],
  );
  if (sources.rows.length !== new Set(input.sourceIds).size)
    throw new HttpError(404, "A selected source is not in this workspace.");
  const connectors = await db.query(
    "select id from aerion.source_connectors where workspace_id=$1 and id=any($2::uuid[])",
    [scope.workspaceId, input.connectorIds],
  );
  if (connectors.rows.length !== new Set(input.connectorIds).size)
    throw new HttpError(404, "A selected connector is not in this workspace.");
  if (input.allowMailbox) {
    if (input.agentId !== "communication")
      throw new HttpError(422, "Mailbox collection belongs to the communication agent.");
    requireMail(scope, "mailbox");
  }
  if (input.leadId) {
    const lead = (
      await db.query(
        "select l.values,c.status from aerion.discovery_leads l join aerion.lead_cases c on c.lead_id=l.id and c.workspace_id=l.workspace_id where l.workspace_id=$1 and l.id=$2",
        [scope.workspaceId, input.leadId],
      )
    ).rows[0];
    if (!lead || lead.status === "Dismissed")
      throw new HttpError(404, "Selected lead is unavailable in this workspace.");
    const retired = await retiredReplySourceIds(db, scope, input.leadId);
    if (input.sourceIds.some((id) => retired.has(id)))
      throw new HttpError(
        422,
        "A selected reply was corrected to another lead. Review the current lead assignment before analysis.",
      );
    if (
      input.agentId !== "buyer-requirements" &&
      !(input.agentId === "crm" && input.discovery?.purpose === "contacts")
    )
      throw new HttpError(422, "Lead context belongs to contact research or buyer-brief analysis.");
    if (input.agentId === "buyer-requirements" && lead.values.side !== "Buyer")
      throw new HttpError(422, "Select a buyer-side lead for brief analysis.");
    if (input.discovery && input.discovery.side !== lead.values.side)
      throw new HttpError(422, "Research side must match the selected lead.");
    const attached = (
      await db.query(
        "select distinct source_id from aerion.lead_sources where workspace_id=$1 and lead_id=$2 and source_id=any($3::uuid[])",
        [scope.workspaceId, input.leadId, input.sourceIds],
      )
    ).rows;
    if (attached.length !== new Set(input.sourceIds).size)
      throw new HttpError(422, "Select only documents attached to this lead.");
  }
  if (input.discovery) {
    const discovery = input.discovery;
    if (
      (discovery.purpose === "contacts"
        ? input.agentId !== "crm" || !input.leadId
        : discovery.side === "Buyer"
          ? input.agentId !== "buyer-discovery"
          : input.agentId !== "aircraft-discovery") ||
      !input.allowExternalSources
    )
      throw new HttpError(
        422,
        "Discovery requires its matching buyer/seller agent and public-source collection permission.",
      );
    if (
      input.connectorIds.length ||
      (input.sourceIds.length && discovery.purpose !== "contacts") ||
      input.aircraftId ||
      input.requirementId ||
      input.contactId
    )
      throw new HttpError(
        422,
        "Start discovery with its own search context. Review existing records separately.",
      );
    if (discovery.method === "web" && !searchConfiguration().ready)
      throw new HttpError(503, searchConfiguration().detail);
    for (const url of discovery.urls) connectorUrl(url);
  }
  if (input.provider !== "rules" && !input.allowModelData)
    throw new HttpError(
      422,
      "Acknowledge sending the selected workspace context and documents to the model provider.",
    );
  if (input.connectorIds.length && !input.allowExternalSources)
    throw new HttpError(422, "Allow collection from the selected source connectors for this run.");
  if (!providerConfiguration(input.provider).ready)
    throw new HttpError(503, providerConfiguration(input.provider).detail);
  return data;
}
export async function enqueueAgentInTransaction(db: PoolClient, scope: Scope, input: RunInput) {
  await db.query("select id from aerion.workspaces where id=$1 for update", [scope.workspaceId]);
  await validateInput(db, scope, input);
  const prior = await db.query(
    "select id,status,input from aerion.agent_runs where workspace_id=$1 and idempotency_key=$2",
    [scope.workspaceId, input.idempotencyKey],
  );
  if (prior.rows[0]) {
    if (fingerprint(runInputSchema.parse(prior.rows[0].input)) !== fingerprint(input))
      throw new HttpError(409, "This idempotency key belongs to a different agent request.");
    return { id: prior.rows[0].id, reused: true };
  }
  const { idempotencyKey: _key, ...meaning } = input;
  const key = fingerprint(meaning);
  const active = await db.query(
    "select id from aerion.agent_runs where workspace_id=$1 and agent_id=$2 and dedupe_key=$3 and status in ('queued','running')",
    [scope.workspaceId, input.agentId, key],
  );
  if (active.rows[0]) return { id: active.rows[0].id, reused: true };
  await enforceOperation(db, scope, input.provider === "rules" ? "agent" : "model-job");
  const count = await db.query(
    "select count(*)::int as n from aerion.agent_runs where workspace_id=$1 and status in ('queued','running')",
    [scope.workspaceId],
  );
  if (count.rows[0].n >= 20)
    throw new HttpError(
      422,
      "Twenty agent runs are already active. Wait or cancel an existing run.",
    );
  const id = randomUUID();
  await db.query(
    "insert into aerion.agent_runs(id,workspace_id,agent_id,provider,model,prompt_version,input,idempotency_key,dedupe_key) values($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [
      id,
      scope.workspaceId,
      input.agentId,
      input.provider,
      providerConfiguration(input.provider).model,
      agentPromptVersion,
      input,
      input.idempotencyKey,
      key,
    ],
  );
  await audit(db, scope, "agent.queued", id, {
    agentId: input.agentId,
    provider: input.provider,
    requirementId: input.requirementId,
  });
  return { id, reused: false };
}
export async function enqueueAgent(scope: Scope, raw: RunInput) {
  const input = runInputSchema.parse(raw);
  return transaction(scope.actorId, scope.workspaceId, (db) =>
    enqueueAgentInTransaction(db, scope, input),
  );
}
export async function readAgentCenter(scope: Scope, page = 1): Promise<AgentCenter> {
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    const workspace = await db.query("select id from aerion.workspaces where id=$1", [
      scope.workspaceId,
    ]);
    if (!workspace.rows[0]) throw new HttpError(404, "Workspace not found.");
    const runs = await db.query(
      `select ${runColumns} from aerion.agent_runs where workspace_id=$1 order by created_at desc,id desc limit 40 offset $2`,
      [scope.workspaceId, (page - 1) * 40],
    );
    const stats = await db.query(
      "select status,count(*)::int as n from aerion.agent_runs where workspace_id=$1 group by status",
      [scope.workspaceId],
    );
    const connectors = await db.query(
      'select id,name,url,format,purpose,enabled,last_collected_at as "lastCollectedAt" from aerion.source_connectors where workspace_id=$1 order by created_at desc limit 100',
      [scope.workspaceId],
    );
    const schedules = await db.query(
      'select agent_id as "agentId",enabled,provider,interval_hours as "intervalHours",next_run_at as "nextRunAt",input from aerion.agent_schedules where workspace_id=$1',
      [scope.workspaceId],
    );
    return {
      runs: runs.rows.map((row) => ({ ...row, input: runInputSchema.parse(row.input) })),
      connections: mailConfiguration(scope),
      totalRuns: stats.rows.reduce((n, r) => n + r.n, 0),
      counts: Object.fromEntries(stats.rows.map((r) => [r.status, r.n])),
      connectors: connectors.rows,
      schedules: schedules.rows,
      providers: agentProviderIds.map((id) => ({
        id,
        ...providerConfiguration(id),
      })),
    };
  });
}
export async function readAgentRun(scope: Scope, id: string): Promise<AgentRunDetail> {
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    const result = await db.query(
      `select ${runColumns} from aerion.agent_runs where id=$1 and workspace_id=$2`,
      [id, scope.workspaceId],
    );
    if (!result.rows[0]) throw new HttpError(404, "Agent run not found.");
    const steps = await db.query(
      'select id,tool,input,output,created_at as "createdAt" from aerion.agent_steps where run_id=$1 and workspace_id=$2 order by created_at,id limit 100',
      [id, scope.workspaceId],
    );
    const proposals = await db.query(
      'select id,run_id as "runId",title,reason,action,citations,status,resolution_note as "resolutionNote",applied_ref as "appliedRef" from aerion.agent_proposals where run_id=$1 and workspace_id=$2 order by id',
      [id, scope.workspaceId],
    );
    return {
      ...result.rows[0],
      input: runInputSchema.parse(result.rows[0].input),
      steps: steps.rows,
      proposals: proposals.rows,
    };
  });
}
export async function changeRun(
  scope: Scope,
  id: string,
  revision: number,
  operation: "cancel" | "retry",
) {
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    await db.query("select id from aerion.workspaces where id=$1 for update", [scope.workspaceId]);
    const result = await db.query(
      `select ${runColumns} from aerion.agent_runs where id=$1 and workspace_id=$2 for update`,
      [id, scope.workspaceId],
    );
    const run: AgentRun = result.rows[0];
    if (!run) throw new HttpError(404, "Agent run not found.");
    if (run.revision !== revision)
      throw new HttpError(409, "This run changed. Reload before retrying.");
    if (operation === "retry") {
      if (!["failed", "cancelled", "needs-input"].includes(run.status))
        throw new HttpError(422, "Only failed, cancelled or input-blocked runs can be retried.");
      return enqueueAgentInTransaction(db, scope, { ...run.input, idempotencyKey: randomUUID() });
    }
    if (!["queued", "running"].includes(run.status))
      throw new HttpError(409, "This run is no longer active.");
    await db.query(
      "update aerion.agent_runs set status='cancelled',revision=revision+1,lease_token=null,finished_at=now() where id=$1",
      [id],
    );
    await audit(db, scope, "agent.cancelled", id);
    return { id };
  });
}
export async function saveConnector(scope: Scope, raw: z.infer<typeof connectorSchema>) {
  const input = connectorSchema.parse(raw),
    url = connectorUrl(input.url).href;
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    await db.query("select id from aerion.workspaces where id=$1 for update", [scope.workspaceId]);
    const count = await db.query(
      "select count(*)::int as n from aerion.source_connectors where workspace_id=$1",
      [scope.workspaceId],
    );
    if (count.rows[0].n >= 100)
      throw new HttpError(422, "Up to 100 source connectors are supported.");
    const id = randomUUID();
    const result = await db.query(
      "insert into aerion.source_connectors(id,workspace_id,name,url,format,purpose,enabled) values($1,$2,$3,$4,$5,$6,$7) on conflict(workspace_id,url) do update set name=excluded.name,enabled=excluded.enabled,format=excluded.format,purpose=excluded.purpose returning id",
      [id, scope.workspaceId, input.name, url, input.format, input.purpose, input.enabled],
    );
    await audit(db, scope, "agent.connector-saved", result.rows[0].id, { ...input, url });
    return { id: result.rows[0].id };
  });
}
export async function saveSchedule(scope: Scope, raw: z.infer<typeof scheduleSchema>) {
  const input = scheduleSchema.parse(raw);
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    await db.query("select id from aerion.workspaces where id=$1 for update", [scope.workspaceId]);
    if (input.enabled)
      await validateInput(db, scope, {
        ...input.input,
        agentId: input.agentId,
        provider: input.provider,
        idempotencyKey: randomUUID(),
      });
    await db.query(
      "insert into aerion.agent_schedules(workspace_id,agent_id,enabled,provider,interval_hours,input,next_run_at) values($1,$2,$3,$4,$5,$6,case when $3 then now()+make_interval(hours=>$5) else null end) on conflict(workspace_id,agent_id) do update set enabled=excluded.enabled,provider=excluded.provider,interval_hours=excluded.interval_hours,input=excluded.input,next_run_at=excluded.next_run_at,updated_at=now()",
      [
        scope.workspaceId,
        input.agentId,
        input.enabled,
        input.provider,
        input.intervalHours,
        input.input,
      ],
    );
    await audit(db, scope, "agent.schedule-saved", null, {
      agentId: input.agentId,
      enabled: input.enabled,
      intervalHours: input.intervalHours,
    });
    return { saved: true };
  });
}
export function actionAllowed(agentId: AgentId, action: ProposalAction) {
  if (action.type === "execution") {
    if (action.action.type === "add-action") return true;
    if (action.action.type === "shortlist")
      return ["matching", "aircraft-intelligence"].includes(agentId);
    if (action.action.type === "prepare-draft") return agentId === "outreach";
    return ["crm", "communication"].includes(agentId);
  }
  return (
    (
      {
        requirement: ["buyer-requirements"],
        contact: ["crm"],
        deal: ["deal-coordination", "matching"],
        interaction: ["communication", "crm"],
        comparable: ["negotiation", "aircraft-intelligence"],
        "lead-enrichment": ["crm"],
        lead:
          action.type === "lead"
            ? [action.values.side === "Buyer" ? "buyer-discovery" : "aircraft-discovery"]
            : [],
      } as Record<string, string[]>
    )[action.type]?.includes(agentId) ?? false
  );
}
export async function retainProposal(
  db: PoolClient,
  scope: Scope,
  runId: string,
  agentId: AgentId,
  raw: AgentProposal,
) {
  const proposal = proposalSchema.parse(raw);
  if (!actionAllowed(agentId, proposal.action))
    throw new HttpError(422, `${agentById(agentId).name} cannot propose this action.`);
  const sourceIds = [...new Set(proposal.citations.map((c) => c.sourceId))];
  const sources = await db.query(
    "select id,pages from aerion.sources where workspace_id=$1 and id=any($2::uuid[])",
    [scope.workspaceId, sourceIds],
  );
  validateCitations(proposal.citations, sources.rows);
  validateProposedFacts(proposal.action, proposal.citations, sources.rows);
  const runInput = (
    await db.query("select input from aerion.agent_runs where workspace_id=$1 and id=$2", [
      scope.workspaceId,
      runId,
    ])
  ).rows[0]?.input;
  if (!runInput) throw new HttpError(404, "Agent run not found.");
  await validateLeadAction(db, scope, runId, runInputSchema.parse(runInput), proposal.action);
  if (proposal.action.type === "lead") {
    if (await existingPendingLead(db, scope, proposal.action, runId))
      throw new HttpError(409, "This page and lead subject already await review in another run.");
    if (await existingLeadId(db, scope, proposal.action))
      throw new HttpError(409, "This page and lead subject are already saved.");
    const result = await db.query(
      "select r.id from aerion.discovery_results r join aerion.discovery_searches s on s.id=r.search_id and s.workspace_id=r.workspace_id where r.id=$1 and r.workspace_id=$2 and s.run_id=$3 and r.source_id=$4 and r.status='retained'",
      [proposal.action.resultId, scope.workspaceId, runId, proposal.action.sourceId],
    );
    if (!result.rows.length)
      throw new HttpError(422, "A lead must cite a publisher page inspected during this run.");
  }
  await validateInteractionParty(db, scope, proposal.action, proposal.citations);
  await validateDuplicateAction(db, scope, proposal.action);
  const contextHash = await proposalContext(db, scope, proposal.action),
    hash = fingerprint(proposal);
  const result = await db.query(
    "insert into aerion.agent_proposals(id,workspace_id,run_id,title,reason,action,citations,context_hash,fingerprint) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(run_id,fingerprint) do nothing returning id",
    [
      randomUUID(),
      scope.workspaceId,
      runId,
      proposal.title,
      proposal.reason,
      proposal.action,
      JSON.stringify(proposal.citations),
      contextHash,
      hash,
    ],
  );
  return result.rows[0]?.id ?? null;
}
async function applyProposal(
  db: PoolClient,
  scope: Scope,
  action: ProposalAction,
  citations: AgentProposal["citations"],
  runId: string,
) {
  const workspace = await db.query(
    "select data,revision from aerion.workspaces where id=$1 for update",
    [scope.workspaceId],
  );
  const data = workspaceSchema.parse(workspace.rows[0].data),
    id = randomUUID();
  if (action.type === "execution") {
    const row = await db.query(
      "select revision from aerion.execution_cases where workspace_id=$1 and requirement_id=$2",
      [scope.workspaceId, action.requirementId],
    );
    return (
      await mutateExecutionInTransaction(
        db,
        scope,
        action.requirementId,
        action.action,
        row.rows[0]?.revision ?? 0,
      )
    ).recordId;
  }
  if (action.type === "requirement") {
    await mutateWorkspaceInTransaction(
      db,
      scope,
      { type: "requirement", item: { ...action.values, id, status: "Draft" } },
      workspace.rows[0].revision,
    );
    if (action.leadId) {
      const saved = await db.query(
        "update aerion.lead_cases set requirement_id=$1,status='Qualifying',revision=revision+1,updated_at=now() where workspace_id=$2 and lead_id=$3 and requirement_id is null and status<>'Dismissed' returning lead_id",
        [id, scope.workspaceId, action.leadId],
      );
      if (!saved.rows.length)
        throw new HttpError(409, "The lead already has a brief or is no longer active.");
      await audit(db, scope, "lead.agent-brief", action.leadId, { requirementId: id, runId });
    }
    return id;
  }
  if (action.type === "lead-enrichment") {
    const { summary: _summary, ...facts } = action.values;
    const key = fingerprint({ leadId: action.leadId, facts });
    const result = await db.query(
      "insert into aerion.lead_enrichments(id,workspace_id,lead_id,run_id,result_id,source_id,values,citations,dedupe_key,reviewer) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(workspace_id,dedupe_key) do nothing returning id",
      [
        id,
        scope.workspaceId,
        action.leadId,
        runId,
        action.resultId,
        action.sourceId,
        action.values,
        JSON.stringify(citations),
        key,
        scope.actorId,
      ],
    );
    if (!result.rows.length)
      throw new HttpError(409, "These published details are already retained for this lead.");
    await db.query(
      "insert into aerion.lead_sources(workspace_id,lead_id,source_id,purpose) values($1,$2,$3,'Contact') on conflict do nothing",
      [scope.workspaceId, action.leadId, action.sourceId],
    );
    await db.query(
      "update aerion.lead_cases set revision=revision+1,updated_at=now() where workspace_id=$1 and lead_id=$2",
      [scope.workspaceId, action.leadId],
    );
    await audit(db, scope, "lead.contact-research-reviewed", action.leadId, {
      enrichmentId: id,
      runId,
    });
    return id;
  }
  if (action.type === "contact") {
    if (data.contacts.some((c) => c.email.toLowerCase() === action.values.email.toLowerCase()))
      throw new HttpError(
        409,
        "A contact with this email already exists. Link the existing contact.",
      );
    await mutateWorkspaceInTransaction(
      db,
      scope,
      { type: "contact", item: { ...action.values, id } },
      workspace.rows[0].revision,
    );
    return id;
  }
  if (action.type === "deal") {
    await mutateWorkspaceInTransaction(
      db,
      scope,
      {
        type: "deal",
        item: {
          id,
          title: `${data.requirements.find((r) => r.id === action.requirementId)?.client} · sourcing opportunity`,
          requirementId: action.requirementId,
          aircraftId: action.aircraftId,
          stage: "Sourcing",
          nextAction: action.nextAction,
          dueDate: action.dueDate,
        },
      },
      workspace.rows[0].revision,
    );
    return id;
  }
  if (action.type === "interaction") {
    if (action.occurredOn > calendarDate())
      throw new HttpError(422, "An interaction cannot be recorded in the future.");
    if (!data.contacts.some((c) => c.id === action.contactId))
      throw new HttpError(404, "Contact not found.");
    const result = await db.query(
      "insert into aerion.contact_interactions(id,workspace_id,contact_id,requirement_id,source_id,occurred_on,direction,summary,reviewer) values($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict(workspace_id,contact_id,source_id,direction) do nothing returning id",
      [
        id,
        scope.workspaceId,
        action.contactId,
        action.requirementId,
        action.sourceId,
        action.occurredOn,
        action.direction,
        action.summary,
        scope.actorId,
      ],
    );
    if (!result.rows[0]) throw new HttpError(409, "This contact interaction is already recorded.");
    return id;
  }
  if (action.type === "lead") {
    const row = (
      await db.query(
        "select r.url from aerion.discovery_results r join aerion.discovery_searches s on s.id=r.search_id and s.workspace_id=r.workspace_id where r.id=$1 and r.workspace_id=$2 and s.run_id=$3 and r.source_id=$4 and r.status='retained'",
        [action.resultId, scope.workspaceId, runId, action.sourceId],
      )
    ).rows[0];
    if (!row)
      throw new HttpError(422, "The inspected publisher evidence is missing from this run.");
    const inserted = await db.query(
      "insert into aerion.discovery_leads(id,workspace_id,run_id,result_id,source_id,url,values,citations,dedupe_key,reviewer) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(workspace_id,dedupe_key) do nothing returning id",
      [
        id,
        scope.workspaceId,
        runId,
        action.resultId,
        action.sourceId,
        row.url,
        action.values,
        JSON.stringify(citations),
        leadIdentity(row.url, action.values),
        scope.actorId,
      ],
    );
    if (!inserted.rows.length)
      throw new HttpError(
        409,
        "This page and lead subject are already saved. Review the existing lead.",
      );
    await db.query("insert into aerion.lead_cases(workspace_id,lead_id) values($1,$2)", [
      scope.workspaceId,
      id,
    ]);
    await db.query(
      "insert into aerion.lead_sources(workspace_id,lead_id,source_id,purpose) values($1,$2,$3,'Original')",
      [scope.workspaceId, id, action.sourceId],
    );
    return id;
  }
  if (action.reportedOn > calendarDate())
    throw new HttpError(422, "A comparable reporting date cannot be in the future.");
  const result = await db.query(
    "insert into aerion.market_comparables(id,workspace_id,source_id,manufacturer,model,year,amount_usd,basis,reported_on,notes,citations,reviewer) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) on conflict(workspace_id,source_id,model,year,amount_usd,basis,reported_on) do nothing returning id",
    [
      id,
      scope.workspaceId,
      action.sourceId,
      action.manufacturer,
      action.model,
      action.year,
      action.amountUsd,
      action.basis,
      action.reportedOn,
      action.notes,
      JSON.stringify(citations),
      scope.actorId,
    ],
  );
  if (!result.rows[0]) throw new HttpError(409, "This comparable observation is already recorded.");
  return id;
}
export async function decideProposal(
  scope: Scope,
  id: string,
  input: { decision: "accept" | "reject"; revision: number; note: string; attested: boolean },
) {
  z.object({
    decision: z.enum(["accept", "reject"]),
    revision: z.number().int().nonnegative(),
    note: z.string().trim().min(5).max(2000),
    attested: z.boolean(),
  }).parse(input);
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    await db.query("select id from aerion.workspaces where id=$1 for update", [scope.workspaceId]);
    const result = await db.query(
      "select p.*,r.revision,r.status as run_status,r.agent_id from aerion.agent_proposals p join aerion.agent_runs r on r.id=p.run_id and r.workspace_id=p.workspace_id where p.id=$1 and p.workspace_id=$2 for update of p,r",
      [id, scope.workspaceId],
    );
    const p = result.rows[0];
    if (!p) throw new HttpError(404, "Proposal not found.");
    if (p.status !== "proposed")
      throw new HttpError(409, "This proposal has already been resolved.");
    if (p.revision !== input.revision)
      throw new HttpError(409, "This run changed. Reload its proposals first.");
    if (["queued", "running", "cancelled", "failed"].includes(p.run_status))
      throw new HttpError(409, "This run is not available for action review.");
    const action = proposalSchema.shape.action.parse(p.action);
    let status = input.decision === "accept" ? "accepted" : "rejected",
      appliedRef: string | null = null;
    if (input.decision === "accept") {
      if (!input.attested)
        throw new HttpError(422, "Confirm that you reviewed the proposed action and its evidence.");
      if (!actionAllowed(p.agent_id, action))
        throw new HttpError(422, "The proposing agent cannot perform this action.");
      if ((await proposalContext(db, scope, action)) !== p.context_hash) status = "obsolete";
      else {
        const citedSources = await db.query(
          "select id,pages from aerion.sources where workspace_id=$1 and id=any($2::uuid[])",
          [
            scope.workspaceId,
            [...new Set((p.citations as Citation[]).map((citation) => citation.sourceId))],
          ],
        );
        validateCitations(p.citations, citedSources.rows);
        validateProposedFacts(action, p.citations, citedSources.rows);
        appliedRef = await applyProposal(db, scope, action, p.citations, p.run_id);
      }
    }
    await db.query(
      "update aerion.agent_proposals set status=$1,resolution_note=$2,reviewer=$3,resolved_at=now(),applied_ref=$4 where id=$5",
      [status, input.note, scope.actorId, appliedRef, id],
    );
    const left = await db.query(
      "select count(*)::int as n from aerion.agent_proposals where run_id=$1 and status='proposed'",
      [p.run_id],
    );
    await db.query(
      "update aerion.agent_runs set revision=revision+1,status=case when $2=0 and status='review' then 'completed' else status end where id=$1",
      [p.run_id, left.rows[0].n],
    );
    await audit(db, scope, `agent.proposal-${status}`, id, {
      runId: p.run_id,
      agentId: p.agent_id,
      actionType: action.type,
      note: input.note,
      appliedRef,
    });
    return {
      status,
      appliedRef,
      message:
        status === "obsolete"
          ? "The referenced context changed. Run the agent again before applying this action."
          : "Decision recorded.",
    };
  });
}
