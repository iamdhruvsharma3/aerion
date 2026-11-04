import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRun, AgentProposal, RunInput } from "../../lib/agents/schema";
import type { DiscoveryResult, LeadValues } from "../../lib/discovery/schema";
import { pool, transaction, workspaceFor, type Scope } from "../db";
import { readSource, readWorkspace } from "../repository";
import { enqueueAgent, readAgentRun, decideProposal, retainProposal } from "../agents/repository";
import { processNextAgent } from "../agents/runtime";
import { AgentTools } from "../agents/tools";
import * as model from "../agents/model";
import * as collector from "../agents/collector";
import { discoverSources, inspectDiscoverySource } from "./service";
import { readDiscoveryCenter } from "./repository";

const testUrl = process.env.AERION_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("Public discovery, retained evidence and founder review", () => {
  const actors = [randomUUID(), randomUUID()];
  let a: Scope, b: Scope, firstRun: AgentRun, firstProposal: AgentProposal;
  const original = Buffer.from(
    "<!doctype html><html><body><main><h1>Fictional Atlas Aviation</h1><p>Fictional Atlas Aviation offers an Airbus A319 for sale. Fictional Atlas Aviation business enquiries: fixture@example.com.</p><p>Fictional engineering fixture only. Not actual aircraft inventory.</p></main></body></html>",
  );
  const values: LeadValues = {
    side: "Seller",
    basis: "Aircraft listing",
    organization: "Fictional Atlas Aviation",
    aircraftModel: "Airbus A319",
    geography: null,
    contactName: null,
    email: "fixture@example.com",
    phone: null,
    summary:
      "The fictional listing supports a seller research lead. Current availability and authority remain unconfirmed.",
  };
  const input = (overrides: Partial<RunInput> = {}): RunInput => ({
    agentId: "aircraft-discovery",
    provider: "nvidia",
    aircraftId: null,
    requirementId: null,
    contactId: null,
    sourceIds: [],
    connectorIds: [],
    objective: "Fictional discovery acceptance test.",
    allowExternalSources: true,
    allowModelData: true,
    allowMailbox: false,
    idempotencyKey: randomUUID(),
    discovery: {
      side: "Seller",
      target: "Airbus A319",
      market: "Any",
      region: "",
      method: "urls",
      query: "",
      urls: ["https://aviation.example.com/aircraft"],
      freshness: "any",
    },
    ...overrides,
  });
  beforeAll(async () => {
    if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
      throw new Error("Dedicated _test database required.");
    process.env.DATABASE_URL = testUrl;
    execFileSync(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
      env: { ...process.env, DATABASE_URL: testUrl },
      stdio: "pipe",
    });
    a = await workspaceFor(actors[0]);
    b = await workspaceFor(actors[1]);
    vi.stubEnv("NVIDIA_API_KEY", "fake-test-key");
    vi.stubEnv("NVIDIA_MODEL", "nvidia/test-model");
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "fake-search-key");
    vi.spyOn(collector, "fetchPublicSource").mockImplementation(async (url) => ({
      original,
      contentType: "text/html",
      url,
    }));
    vi.spyOn(model, "runModel").mockImplementation(async (tools) => {
      const manifest = (await tools.invoke("discover_sources", {})) as {
        results: DiscoveryResult[];
      };
      const page = (await tools.invoke("inspect_discovery_source", {
        resultId: manifest.results[0].id,
      })) as { sourceId: string; resultId: string; text: string };
      const proposal: AgentProposal = {
        title: "Review fictional aircraft listing",
        reason:
          "The inspected publisher passage states an aircraft for sale and its organization's business email.",
        action: { type: "lead", resultId: page.resultId, sourceId: page.sourceId, values },
        citations: [{ sourceId: page.sourceId, page: 1, quote: page.text }],
      };
      firstProposal ??= proposal;
      await tools.invoke("propose_action", proposal);
      return {
        report: {
          summary: "Inspected a fictional publisher page for engineering acceptance.",
          findings: [
            {
              title: "Retained publisher evidence",
              detail: "The fictional listing remains unqualified.",
              severity: "review",
              citations: proposal.citations,
            },
          ],
          limitations: ["Fictional test, not a real business lead."],
        },
        usage: { inputTokens: 0, outputTokens: 0, requests: 0 },
      };
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    if (!a) return;
    const db = await pool().connect();
    try {
      await db.query("begin");
      for (const table of [
        "activity",
        "lead_drafts",
        "lead_enrichments",
        "lead_sources",
        "lead_cases",
        "discovery_leads",
        "discovery_results",
        "discovery_searches",
        "agent_proposals",
        "agent_steps",
        "agent_runs",
        "sources",
      ])
        await db.query(`delete from aerion.${table} where workspace_id=any($1::uuid[])`, [
          [a.workspaceId, b.workspaceId],
        ]);
      await db.query("delete from aerion.workspaces where owner_id=any($1::uuid[])", [actors]);
      await db.query("commit");
    } finally {
      db.release();
      await pool().end();
    }
  });
  it("runs discovery through the actual worker and saves a lead only after an attested founder review", async () => {
    const request = input();
    const queued = await enqueueAgent(a, request);
    expect((await enqueueAgent(a, request)).id).toBe(queued.id);
    await processNextAgent(a);
    const run = await readAgentRun(a, queued.id);
    firstRun = run;
    expect(run.status, run.error ?? "").toBe("review");
    expect(run.steps.map((s) => s.tool)).toEqual([
      "discover_sources",
      "inspect_discovery_source",
      "propose_action",
    ]);
    expect(run.proposals).toHaveLength(1);
    expect((await readDiscoveryCenter(a)).counts).toEqual({
      runs: 1,
      pages: 1,
      pending: 1,
      saved: 0,
    });
    const duplicate = await enqueueAgent(a, input());
    await processNextAgent(a);
    const pendingDuplicate = await readAgentRun(a, duplicate.id);
    expect(pendingDuplicate.proposals).toHaveLength(0);
    expect(
      pendingDuplicate.steps.find((step) => step.tool === "propose_action")?.output,
    ).toMatchObject({ alreadyProposed: true });
    expect(firstProposal.action.type).toBe("lead");
    if (firstProposal.action.type !== "lead") throw new Error("Expected lead");
    const source = await readSource(a, firstProposal.action.sourceId, true);
    expect(source.original.equals(original)).toBe(true);
    await expect(
      decideProposal(a, run.proposals[0].id, {
        decision: "accept",
        revision: run.revision,
        attested: false,
        note: "Evidence review fixture",
      }),
    ).rejects.toThrow(/reviewed/);
    const accepted = await decideProposal(a, run.proposals[0].id, {
      decision: "accept",
      revision: run.revision,
      attested: true,
      note: "Fictional evidence reviewed for engineering acceptance only.",
    });
    expect(accepted.status).toBe("accepted");
    const center = await readDiscoveryCenter(a);
    expect(center.counts.saved).toBe(1);
    expect(center.counts.pending).toBe(0);
    expect(center.leads[0].values.email).toBe("fixture@example.com");
    const workspace = await readWorkspace(a);
    expect(workspace.data.contacts).toHaveLength(0);
    expect(workspace.data.aircraft).toHaveLength(0);
    expect(workspace.data.requirements).toHaveLength(0);
  });
  it("deduplicates a saved page/subject on a later run and keeps discovery tools within their run", async () => {
    const queued = await enqueueAgent(a, input());
    await processNextAgent(a);
    const run = await readAgentRun(a, queued.id);
    expect(run.status, run.error ?? "").toBe("completed");
    expect(run.proposals).toHaveLength(0);
    expect(run.steps.find((s) => s.tool === "propose_action")?.output).toMatchObject({
      alreadySaved: true,
      staged: false,
    });
    expect((await readDiscoveryCenter(a)).counts.saved).toBe(1);
    if (firstProposal.action.type !== "lead") throw new Error("Expected lead");
    const other = await enqueueAgent(b, input());
    const otherRun = await readAgentRun(b, other.id);
    await expect(
      inspectDiscoverySource(
        b,
        otherRun,
        firstProposal.action.resultId,
        new AbortController().signal,
      ),
    ).rejects.toThrow(/does not belong/);
    await expect(
      transaction(a.actorId, a.workspaceId, (db) =>
        retainProposal(db, a, run.id, run.agentId, firstProposal),
      ),
    ).rejects.toThrow(/already saved/);
    const tools = new AgentTools(
      a,
      run,
      new AbortController().signal,
      async () => {},
      async () => {},
    );
    await expect(
      tools.invoke("queue_extraction", {
        sourceId: firstProposal.action.sourceId,
        purpose: "aircraft",
      }),
    ).rejects.toThrow(/not granted/);
    await expect(
      transaction(actors[1], a.workspaceId, (db) =>
        db.query("select * from aerion.discovery_leads"),
      ),
    ).resolves.toMatchObject({ rows: [] });
    await expect(
      transaction(a.actorId, a.workspaceId, (db) =>
        db.query("update aerion.discovery_leads set values='{}' where workspace_id=$1", [
          a.workspaceId,
        ]),
      ),
    ).rejects.toThrow(/permission denied/);
  });
  it("retains one Brave response per run, reuses it after worker interruption and enforces a durable page budget", async () => {
    const response = JSON.stringify({
      web: {
        results: Array.from({ length: 6 }, (_, i) => ({
          title: `Fictional listing ${i}`,
          url: `https://aviation.example.com/aircraft-${i}`,
          description: "Search snippet only",
        })),
      },
    });
    const search = vi.fn().mockResolvedValue(new Response(response, { status: 200 }));
    vi.stubGlobal("fetch", search);
    const request = input();
    if (!request.discovery) throw new Error("Expected scope");
    request.discovery = {
      ...request.discovery,
      method: "web",
      query: 'Airbus A319 "for sale"',
      urls: [],
    };
    const queued = await enqueueAgent(a, request);
    const run = await readAgentRun(a, queued.id);
    const signal = new AbortController().signal;
    const manifest = await discoverSources(a, run, signal);
    expect((await discoverSources(a, run, signal)).results.map((r) => r.id)).toEqual(
      manifest.results.map((r) => r.id),
    );
    expect(search).toHaveBeenCalledTimes(1);
    for (const result of manifest.results.slice(0, 3))
      await inspectDiscoverySource(a, run, result.id, signal);
    await expect(inspectDiscoverySource(a, run, manifest.results[3].id, signal)).rejects.toThrow(
      /three-page/,
    );
    const before = vi.mocked(collector.fetchPublicSource).mock.calls.length;
    await inspectDiscoverySource(a, run, manifest.results[0].id, signal);
    expect(vi.mocked(collector.fetchPublicSource).mock.calls.length).toBe(before);
    const stored = await transaction(
      a.actorId,
      a.workspaceId,
      async (db) =>
        (await db.query("select original from aerion.discovery_searches where run_id=$1", [run.id]))
          .rows[0],
    );
    expect(stored.original.toString()).toBe(response);
  });
  it("does not repeat a failed paid search and rejects private URLs or mismatched roles before enqueueing", async () => {
    const failedSearch = vi.fn().mockResolvedValue(new Response("Account error", { status: 429 }));
    vi.stubGlobal("fetch", failedSearch);
    const request = input();
    if (!request.discovery) throw new Error("Expected scope");
    request.discovery = {
      ...request.discovery,
      method: "web",
      query: "Different aircraft query",
      urls: [],
    };
    const queued = await enqueueAgent(a, request);
    const run = await readAgentRun(a, queued.id);
    await expect(discoverSources(a, run, new AbortController().signal)).rejects.toThrow(/HTTP 429/);
    await expect(discoverSources(a, run, new AbortController().signal)).rejects.toThrow(/HTTP 429/);
    expect(failedSearch).toHaveBeenCalledTimes(1);
    await expect(enqueueAgent(a, input({ agentId: "buyer-discovery" }))).rejects.toThrow(
      /matching buyer/,
    );
    await expect(
      enqueueAgent(
        a,
        input({
          discovery: {
            ...request.discovery,
            method: "urls",
            query: "",
            urls: ["https://127.0.0.1/"],
          },
        }),
      ),
    ).rejects.toThrow(/Private|reserved/);
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "");
    await expect(enqueueAgent(a, input({ discovery: request.discovery }))).rejects.toThrow(
      /BRAVE_SEARCH_API_KEY/,
    );
    expect((await readDiscoveryCenter(b)).counts.saved).toBe(0);
    expect(firstRun.id).toBeTruthy();
  });
});
