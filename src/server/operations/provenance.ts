import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { z } from "zod";
import { agentCatalog, type AgentId } from "../../lib/agents/catalog";
import {
  runInputSchema,
  proposalSchema,
  reportSchema,
  type ProposalAction,
} from "../../lib/agents/schema";
import { workspaceSchema, type Workspace } from "../../lib/schema";
import { audit, transaction, type Scope } from "../db";
import { HttpError } from "../http";
import {
  fingerprint,
  validateCitations,
  validateProposedFacts,
  validateReport,
} from "../agents/evidence";
import { actionAllowed } from "../agents/repository";

const profileVersion = "aerion-live-capability-v1";
const expectedActions: Partial<Record<AgentId, string>> = {
  "buyer-requirements": "requirement",
  outreach: "execution.prepare-draft",
  communication: "interaction",
  "due-diligence": "execution.add-action",
  "deal-coordination": "execution.add-action",
  negotiation: "comparable",
  crm: "contact",
};
const requiredTools: Record<AgentId, string[]> = {
  "aircraft-discovery": ["discover_sources", "inspect_discovery_source", "propose_action"],
  "aircraft-intelligence": ["aircraft_evidence"],
  "buyer-discovery": ["discover_sources", "inspect_discovery_source", "propose_action"],
  "buyer-requirements": ["source_passages", "propose_action"],
  matching: ["match_aircraft"],
  outreach: ["case_context", "propose_action"],
  communication: ["source_passages", "propose_action"],
  documents: ["source_passages"],
  "due-diligence": ["case_context", "propose_action"],
  "deal-coordination": ["case_context", "propose_action"],
  negotiation: ["source_passages", "propose_action"],
  crm: ["source_passages", "propose_action"],
};
export const validationRequestSchema = z.object({
  agentId: z.enum(agentCatalog.map((a) => a.id) as [AgentId, ...AgentId[]]),
  provider: z.enum(["openai", "nvidia", "ollama"]),
  model: z.string().min(1).max(300),
  runId: z.uuid(),
  status: z.enum(["passed", "failed"]),
  origin: z.enum(["live-fixture", "operational-run"]),
  reportHash: z.string().regex(/^[a-f0-9]{64}$/),
  result: z.unknown(),
});
export type AgentValidationRequest = z.infer<typeof validationRequestSchema>;
export const fixtureResultSchema = z
  .object({
    agentId: z.enum(agentCatalog.map((a) => a.id) as [AgentId, ...AgentId[]]),
    runId: z.uuid(),
    provider: z.enum(["openai", "nvidia", "ollama"]),
    model: z.string().min(1).max(300),
    acceptancePassed: z.boolean(),
  })
  .passthrough();
export const fixtureArtifactSchema = z
  .object({
    database: z.string().min(1),
    actorId: z.uuid(),
    fixture: z.object({ workspaceId: z.uuid() }).passthrough(),
    results: z.array(fixtureResultSchema).min(1).max(100),
    realMessagesSent: z.literal(0),
  })
  .passthrough();
type RunRow = {
  id: string;
  agentId: AgentId;
  provider: string;
  model: string | null;
  status: string;
  input: unknown;
  report: unknown;
  error: string | null;
  usage: { requests: number; inputTokens: number; outputTokens: number } | null;
  finishedAt: string | null;
};
type Step = {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
};
type StoredProposal = {
  id: string;
  title: string;
  reason: string;
  action: ProposalAction;
  citations: Parameters<typeof validateCitations>[0];
  status: string;
  appliedRef: string | null;
};
type Proof = {
  agentId: AgentId;
  provider: string;
  model: string | null;
  runId: string;
  status: "passed" | "failed";
  origin: "live-fixture" | "operational-run";
  reportHash: string;
  result: {
    version: 1;
    profileVersion: string;
    summary: string;
    errors: string[];
    counts: { toolCalls: number; proposals: number; accepted: number; reportDiagnostics?: number };
    requiredTools: string[];
    expectedAction: string | null;
    acceptedActions: string[];
    reportHash: string;
    traceHash: string;
    proposalHash: string;
    usage: RunRow["usage"];
    finishedAt: string | null;
    provenance: {
      kind: "same-workspace" | "published-fixture";
      sourceScopeHash?: string;
      artifactHash?: string;
    };
  };
};
const actionName = (action: ProposalAction) =>
  action.type === "execution" ? `execution.${action.action.type}` : action.type;
function equalClaim(claim: Record<string, unknown>, field: string, actual: unknown) {
  if (field in claim && fingerprint({ value: claim[field] }) !== fingerprint({ value: actual }))
    throw new HttpError(
      422,
      `Acceptance assertion ${field} does not match the stored run evidence.`,
    );
}
async function ownedWorkspace(db: PoolClient, scope: Scope) {
  const row = (
    await db.query("select data from aerion.workspaces where id=$1 and owner_id=$2", [
      scope.workspaceId,
      scope.actorId,
    ])
  ).rows[0];
  if (!row)
    throw new HttpError(404, "Acceptance source workspace is not owned by the selected actor.");
  return workspaceSchema.parse(row.data);
}
async function runRow(db: PoolClient, scope: Scope, id: string): Promise<RunRow> {
  const row = (
    await db.query(
      'select id,agent_id as "agentId",provider,model,status,input,report,error,usage,finished_at as "finishedAt" from aerion.agent_runs where workspace_id=$1 and id=$2',
      [scope.workspaceId, id],
    )
  ).rows[0];
  if (!row)
    throw new HttpError(404, "Acceptance source run was not found in the selected workspace.");
  return row;
}
async function appliedRecordExists(
  db: PoolClient,
  scope: Scope,
  proposal: StoredProposal,
  data: Workspace,
) {
  const { action, appliedRef } = proposal;
  if (!appliedRef) return false;
  if (action.type === "contact" || action.type === "requirement") {
    const item =
      action.type === "contact"
        ? data.contacts.find((c) => c.id === appliedRef)
        : data.requirements.find((r) => r.id === appliedRef);
    return Boolean(
      item &&
        Object.entries(action.values).every(
          ([key, value]) =>
            fingerprint((item as unknown as Record<string, unknown>)[key]) === fingerprint(value),
        ),
    );
  }
  if (action.type === "interaction")
    return Boolean(
      (
        await db.query(
          "select id from aerion.contact_interactions where workspace_id=$1 and id=$2 and contact_id=$3 and source_id=$4 and summary=$5",
          [scope.workspaceId, appliedRef, action.contactId, action.sourceId, action.summary],
        )
      ).rows.length,
    );
  if (action.type === "comparable")
    return Boolean(
      (
        await db.query(
          "select id from aerion.market_comparables where workspace_id=$1 and id=$2 and source_id=$3 and manufacturer=$4 and model=$5 and year=$6 and amount_usd=$7 and basis=$8 and reported_on=$9",
          [
            scope.workspaceId,
            appliedRef,
            action.sourceId,
            action.manufacturer,
            action.model,
            action.year,
            action.amountUsd,
            action.basis,
            action.reportedOn,
          ],
        )
      ).rows.length,
    );
  if (action.type === "lead-enrichment")
    return Boolean(
      (
        await db.query(
          "select id from aerion.lead_enrichments where workspace_id=$1 and id=$2 and lead_id=$3 and source_id=$4",
          [scope.workspaceId, appliedRef, action.leadId, action.sourceId],
        )
      ).rows.length,
    );
  if (action.type === "lead")
    return Boolean(
      (
        await db.query(
          "select id from aerion.discovery_leads where workspace_id=$1 and id=$2 and source_id=$3",
          [scope.workspaceId, appliedRef, action.sourceId],
        )
      ).rows.length,
    );
  if (action.type === "execution" && action.action.type === "prepare-draft")
    return Boolean(
      (
        await db.query(
          "select d.id from aerion.outreach_drafts d join aerion.execution_cases c on c.id=d.case_id and c.workspace_id=d.workspace_id where d.workspace_id=$1 and d.id=$2 and c.requirement_id=$3 and d.aircraft_id=$4 and d.contact_id=$5 and d.audience=$6",
          [
            scope.workspaceId,
            appliedRef,
            action.requirementId,
            action.action.aircraftId,
            action.action.contactId,
            action.action.audience,
          ],
        )
      ).rows.length,
    );
  if (action.type === "execution" && action.action.type === "add-action")
    return Boolean(
      (
        await db.query(
          "select a.id from aerion.case_actions a join aerion.execution_cases c on c.id=a.case_id and c.workspace_id=a.workspace_id where a.workspace_id=$1 and a.id=$2 and c.requirement_id=$3 and a.kind=$4 and a.title=$5 and a.detail=$6",
          [
            scope.workspaceId,
            appliedRef,
            action.requirementId,
            action.action.kind,
            action.action.title,
            action.action.detail,
          ],
        )
      ).rows.length,
    );
  return true;
}
/** Reconstruct acceptance from private stored rows. Caller assertions are comparisons, never proof. */
async function inspectStoredRun(
  db: PoolClient,
  scope: Scope,
  raw: AgentValidationRequest,
): Promise<Proof> {
  const request = validationRequestSchema.parse(raw),
    data = await ownedWorkspace(db, scope),
    run = await runRow(db, scope, request.runId);
  if (
    request.origin === "live-fixture" &&
    !String((await db.query("select current_database() as name")).rows[0].name).endsWith("_test")
  )
    throw new HttpError(
      422,
      "Direct fictional-fixture acceptance requires a dedicated _test database. Publish its verified proof through the fixture importer.",
    );
  if (
    run.agentId !== request.agentId ||
    run.provider !== request.provider ||
    run.model !== request.model
  )
    throw new HttpError(422, "Acceptance role, provider or model does not match the stored run.");
  if (fingerprint(run.report) !== request.reportHash)
    throw new HttpError(422, "Acceptance report hash does not match the stored report.");
  if (["queued", "running"].includes(run.status))
    throw new HttpError(422, "Acceptance requires a finished run.");
  const steps = (
    await db.query(
      "select id,tool,input,output from aerion.agent_steps where workspace_id=$1 and run_id=$2 order by created_at,id",
      [scope.workspaceId, run.id],
    )
  ).rows as Step[];
  const proposals = (
    await db.query(
      'select id,title,reason,action,citations,status,applied_ref as "appliedRef" from aerion.agent_proposals where workspace_id=$1 and run_id=$2 order by id',
      [scope.workspaceId, run.id],
    )
  ).rows as StoredProposal[];
  const input = runInputSchema.parse(run.input),
    definition = agentCatalog.find((a) => a.id === run.agentId);
  if (!definition) throw new HttpError(422, "Stored run has an unsupported role.");
  const errors: string[] = [];
  if (
    !["openai", "nvidia", "ollama"].includes(run.provider) ||
    !run.model?.trim() ||
    !run.usage ||
    !Number.isInteger(run.usage.requests) ||
    run.usage.requests < 1 ||
    run.usage.requests > 6 ||
    !Number.isInteger(run.usage.inputTokens) ||
    !Number.isInteger(run.usage.outputTokens) ||
    run.usage.inputTokens < 0 ||
    run.usage.outputTokens < 0
  )
    errors.push("No bounded completed live model request is recorded.");
  if (!["review", "completed"].includes(run.status) || run.error || !run.report)
    errors.push("The live run did not finish with a valid saved report.");
  if (input.agentId !== run.agentId || input.provider !== run.provider)
    errors.push("The queued role/provider snapshot does not match the run.");
  const granted = input.discovery
    ? definition.tools.filter((t) =>
        [
          "workspace_context",
          "discover_sources",
          "inspect_discovery_source",
          "source_passages",
          "propose_action",
        ].includes(t),
      )
    : input.leadId
      ? definition.tools.filter((t) =>
          ["workspace_context", "source_passages", "propose_action"].includes(t),
        )
      : definition.tools;
  const diagnostics = steps.filter((s) => s.tool === "finish_report"),
    businessSteps = steps.filter((s) => s.tool !== "finish_report");
  const diagnosticBudget = Math.max(
    0,
    (run.usage?.requests ?? 0) - (["review", "completed"].includes(run.status) ? 1 : 0),
  );
  const validDiagnostics =
    run.provider === "nvidia" &&
    diagnostics.length <= Math.min(6, diagnosticBudget) &&
    diagnostics.every(
      (s) =>
        typeof s.output?.error === "string" &&
        s.input !== null &&
        typeof s.input === "object" &&
        Object.hasOwn(s.input, "rejectedReport"),
    );
  if (diagnostics.length && !validDiagnostics)
    errors.push("An ungranted or unbounded runtime report diagnostic was recorded.");
  if (
    !businessSteps.length ||
    businessSteps.length > 30 ||
    businessSteps.some((s) => !granted.includes(s.tool))
  )
    errors.push(
      "The retained tool trace is missing, exceeds its budget or contains an ungranted tool.",
    );
  const successful = businessSteps.filter(
      (s) => !s.output?.error && !s.output?.missing && !s.output?.truncated,
    ),
    successNames = new Set(successful.map((s) => s.tool));
  const contactDiscovery = run.agentId === "crm" && input.discovery?.purpose === "contacts";
  const expected = contactDiscovery ? "lead-enrichment" : (expectedActions[run.agentId] ?? null);
  const required = contactDiscovery
    ? ["discover_sources", "inspect_discovery_source", "propose_action"]
    : requiredTools[run.agentId];
  for (const tool of required)
    if (!successNames.has(tool)) errors.push(`Required successful tool ${tool} was not recorded.`);
  const accepted = proposals.filter((p) => p.status === "accepted");
  if (expected && !accepted.some((p) => actionName(p.action) === expected))
    errors.push(`Expected accepted action ${expected} was not recorded.`);
  if (
    ["buyer-discovery", "aircraft-discovery"].includes(run.agentId) &&
    !proposals.some(
      (p) =>
        p.action.type === "lead" &&
        p.action.values.side === (run.agentId === "buyer-discovery" ? "Buyer" : "Seller") &&
        ["proposed", "accepted"].includes(p.status),
    )
  )
    errors.push("No retained lead proposal for this discovery side was recorded.");
  if (
    run.agentId === "matching" &&
    !successful.some(
      (s) =>
        s.tool === "match_aircraft" &&
        Number(s.output?.total) > 0 &&
        Array.isArray(s.output?.matches) &&
        s.output.matches.length > 0,
    )
  )
    errors.push("No actual aircraft-match evaluation was returned.");
  const sourceIds = [
    ...new Set([
      ...(run.report
        ? reportSchema.parse(run.report).findings.flatMap((f) => f.citations.map((c) => c.sourceId))
        : []),
      ...proposals.flatMap((p) => p.citations.map((c) => c.sourceId)),
    ]),
  ];
  const sources = (
    await db.query(
      "select id,pages from aerion.sources where workspace_id=$1 and id=any($2::uuid[])",
      [scope.workspaceId, sourceIds],
    )
  ).rows;
  try {
    if (run.report) validateReport(reportSchema.parse(run.report), sources);
    for (const proposal of proposals) {
      const parsed = proposalSchema.parse(proposal);
      validateCitations(parsed.citations, sources);
      validateProposedFacts(parsed.action, parsed.citations);
      if (!actionAllowed(run.agentId, parsed.action))
        errors.push("A saved proposal is not permitted for this role.");
      if (
        !successful.some(
          (s) => s.tool === "propose_action" && fingerprint(s.input) === fingerprint(parsed),
        )
      )
        errors.push("A saved proposal has no matching successful propose_action trace.");
    }
  } catch {
    errors.push("A saved report or proposal fails retained evidence validation.");
  }
  if (
    ["documents", "aircraft-intelligence"].includes(run.agentId) &&
    (!run.report || !reportSchema.parse(run.report).findings.some((f) => f.citations.length))
  )
    errors.push("No retained evidence citation supports this document/aircraft capability result.");
  for (const proposal of accepted)
    if (!(await appliedRecordExists(db, scope, proposal, data)))
      errors.push("An accepted action has no matching applied record in the selected workspace.");
  const passed = errors.length === 0,
    status = passed ? "passed" : "failed",
    acceptedActions = accepted.map((p) => actionName(p.action));
  const claims =
    request.result && typeof request.result === "object"
      ? (request.result as Record<string, unknown>)
      : {};
  equalClaim(
    claims,
    "steps",
    steps.map((s) => s.tool),
  );
  equalClaim(claims, "proposals", proposals.length);
  equalClaim(claims, "applied", accepted.length);
  equalClaim(claims, "acceptedActions", acceptedActions);
  equalClaim(claims, "expectedAction", expected);
  equalClaim(claims, "acceptancePassed", passed);
  equalClaim(claims, "provider", run.provider);
  equalClaim(claims, "model", run.model);
  equalClaim(claims, "runId", run.id);
  equalClaim(claims, "agentId", run.agentId);
  equalClaim(claims, "status", run.status);
  equalClaim(claims, "usage", run.usage);
  equalClaim(claims, "summary", (run.report as { summary?: string } | null)?.summary);
  if (request.status !== status)
    throw new HttpError(422, `The stored role acceptance is ${status}: ${errors.join(" ")}`);
  return {
    agentId: run.agentId,
    provider: run.provider,
    model: run.model,
    runId: run.id,
    status,
    origin: request.origin,
    reportHash: request.reportHash,
    result: {
      version: 1,
      profileVersion,
      summary: passed
        ? `Verified bounded ${request.origin === "live-fixture" ? "fictional fixture" : "workspace"} capability: required tools and ${expected ? `accepted ${expected} action` : ["buyer-discovery", "aircraft-discovery"].includes(run.agentId) ? "source-backed lead proposal" : "retained evidence result"} are present. Business outcomes and domain quality require separate review.`
        : `Capability acceptance failed: ${errors.join(" ")}`,
      errors,
      counts: {
        toolCalls: businessSteps.length,
        proposals: proposals.length,
        accepted: accepted.length,
        ...(diagnostics.length ? { reportDiagnostics: diagnostics.length } : {}),
      },
      requiredTools: required,
      expectedAction: expected,
      acceptedActions,
      reportHash: request.reportHash,
      traceHash: fingerprint(steps),
      proposalHash: fingerprint(proposals),
      usage: run.usage,
      finishedAt: run.finishedAt,
      provenance: { kind: "same-workspace" },
    },
  };
}
async function persistProof(db: PoolClient, scope: Scope, proof: Proof) {
  const previous = (
    await db.query(
      "select agent_id,provider,model,status,origin,report_hash,result from aerion.agent_validations where workspace_id=$1 and source_run_id=$2",
      [scope.workspaceId, proof.runId],
    )
  ).rows[0];
  if (previous) {
    if (
      previous.agent_id !== proof.agentId ||
      previous.provider !== proof.provider ||
      previous.model !== proof.model ||
      previous.status !== proof.status ||
      previous.origin !== proof.origin ||
      previous.report_hash !== proof.reportHash ||
      fingerprint(previous.result) !== fingerprint(proof.result)
    )
      throw new HttpError(
        409,
        "An immutable acceptance record already exists with different evidence. Run a new acceptance check to retain a new result.",
      );
    return { runId: proof.runId, status: proof.status, reused: true };
  }
  await db.query(
    "insert into aerion.agent_validations(id,workspace_id,agent_id,provider,model,source_run_id,status,origin,report_hash,result) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
    [
      randomUUID(),
      scope.workspaceId,
      proof.agentId,
      proof.provider,
      proof.model,
      proof.runId,
      proof.status,
      proof.origin,
      proof.reportHash,
      JSON.stringify(proof.result),
    ],
  );
  await audit(db, scope, "operations.agent-validated", proof.runId, {
    agentId: proof.agentId,
    status: proof.status,
    origin: proof.origin,
    reportHash: proof.reportHash,
    profileVersion,
  });
  return { runId: proof.runId, status: proof.status, reused: false };
}
export async function recordAgentValidation(scope: Scope, record: AgentValidationRequest) {
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    await db.query("select id from aerion.workspaces where id=$1 for update", [scope.workspaceId]);
    return persistProof(db, scope, await inspectStoredRun(db, scope, record));
  });
}
export async function acceptStoredAgentRun(scope: Scope, runId: string) {
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    await db.query("select id from aerion.workspaces where id=$1 for update", [scope.workspaceId]);
    await ownedWorkspace(db, scope);
    const run = await runRow(db, scope, z.uuid().parse(runId));
    const base = {
      agentId: run.agentId,
      provider: run.provider as AgentValidationRequest["provider"],
      model: run.model ?? "",
      runId: run.id,
      origin: "operational-run" as const,
      reportHash: fingerprint(run.report),
      result: {},
    };
    let proof: Proof;
    try {
      proof = await inspectStoredRun(db, scope, { ...base, status: "passed" });
    } catch (e) {
      if (
        !(
          e instanceof HttpError &&
          e.status === 422 &&
          e.message.startsWith("The stored role acceptance is failed:")
        )
      )
        throw e;
      proof = await inspectStoredRun(db, scope, { ...base, status: "failed" });
    }
    return persistProof(db, scope, proof);
  });
}
/** Only this server function can publish sanitized proof from a dedicated test database. No raw report, source text, parties or source-scope identifiers are copied. */
export async function publishAgentFixtureValidations(
  target: Scope,
  sourceDb: PoolClient,
  source: Scope,
  rawClaims: unknown[],
  artifactHash: string,
) {
  if (!/^[a-f0-9]{64}$/.test(artifactHash))
    throw new HttpError(422, "Invalid fixture artifact hash.");
  const claims = z.array(fixtureResultSchema).min(1).max(100).parse(rawClaims);
  if (new Set(claims.map((c) => c.runId)).size !== claims.length)
    throw new HttpError(422, "Fixture artifact repeats a run ID.");
  const database = (await sourceDb.query("select current_database() as name")).rows[0]
    .name as string;
  if (!database.endsWith("_test"))
    throw new HttpError(
      422,
      "Fixture acceptance may only be imported from an explicitly selected dedicated _test database.",
    );
  const proofs: Proof[] = [];
  await sourceDb.query("begin isolation level repeatable read read only");
  try {
    await sourceDb.query("set local role aerion_runtime");
    await sourceDb.query(
      "select set_config('aerion.actor_id',$1,true),set_config('aerion.workspace_id',$2,true)",
      [source.actorId, source.workspaceId],
    );
    await ownedWorkspace(sourceDb, source);
    for (const claim of claims) {
      const run = await runRow(sourceDb, source, claim.runId);
      const proof = await inspectStoredRun(sourceDb, source, {
        agentId: claim.agentId,
        provider: claim.provider,
        model: claim.model,
        runId: claim.runId,
        status: claim.acceptancePassed ? "passed" : "failed",
        origin: "live-fixture",
        reportHash: fingerprint(run.report),
        result: claim,
      });
      proof.result.provenance = {
        kind: "published-fixture",
        sourceScopeHash: fingerprint({
          database,
          actorId: source.actorId,
          workspaceId: source.workspaceId,
        }),
        artifactHash,
      };
      proofs.push(proof);
    }
    await sourceDb.query("commit");
  } catch (e) {
    await sourceDb.query("rollback");
    throw e;
  }
  return transaction(target.actorId, target.workspaceId, async (db) => {
    await db.query("select id from aerion.workspaces where id=$1 for update", [target.workspaceId]);
    await ownedWorkspace(db, target);
    const results = [];
    for (const proof of proofs) results.push(await persistProof(db, target, proof));
    return results;
  });
}
