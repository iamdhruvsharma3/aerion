import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pool, transaction, workspaceFor, type Scope } from "../db";
import {
  readOperations,
  recordAgentValidation,
  updateOperations,
  publishAgentFixtureValidations,
} from "./service";
import { fingerprint } from "../agents/evidence";
import * as model from "../agents/model";
import { defaultOperationSettings } from "../../lib/operations/schema";
import { enqueueAgent } from "../agents/repository";
import { processNextAgent } from "../agents/runtime";
import { createSource } from "../repository";
import { enqueueExtraction, processNext } from "../jobs";
import { discoverSources } from "../discovery/service";
import { readAgentRun } from "../agents/repository";
import { workerHeartbeat } from "./health";
import type { RunInput } from "../../lib/agents/schema";

const testUrl = process.env.AERION_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("Operational controls with real PostgreSQL", () => {
  let a: Scope, b: Scope;
  const heartbeatId = randomUUID();
  let validatedRun: Awaited<ReturnType<typeof readAgentRun>>;
  const privateMarker = `Fictional private acceptance text ${randomUUID()}`;
  async function observedDocumentRun(repairedReport = false) {
    const body = `${privateMarker}\nUnique fixture ${randomUUID()}`;
    const source = await createSource(b, {
      title: "Fictional private validation document",
      kind: "text",
      sourceUrl: null,
      filename: "fixture.txt",
      contentType: "text/plain",
      original: Buffer.from(body),
      pages: [{ page: 1, text: body }],
    });
    const spy = vi
      .spyOn(model, "runModel")
      .mockImplementationOnce(
        async (tools, usage = { requests: 0, inputTokens: 0, outputTokens: 0 }) => {
          await tools.invoke("workspace_context", {});
          await tools.invoke("source_passages", { sourceId: source.id, page: 1, offset: 0 });
          if (repairedReport) {
            for (let index = 0; index < 28; index++) await tools.invoke("workspace_context", {});
            await tools.trace(
              "finish_report",
              { rejectedReport: null },
              {
                error: "Fictional rejected report citation; the final saved report was corrected.",
              },
            );
          }
          Object.assign(usage, {
            requests: repairedReport ? 2 : 1,
            inputTokens: 10,
            outputTokens: 5,
          });
          return {
            report: {
              summary:
                "Fictional mocked live transport validation. No real inference or business activity.",
              findings: [
                {
                  title: "Retained fixture",
                  detail: "A fictional source was inspected.",
                  severity: "review" as const,
                  citations: [{ sourceId: source.id, page: 1, quote: body }],
                },
              ],
              limitations: ["Protocol fixture only, not actual NVIDIA inference."],
            },
            usage,
          };
        },
      );
    try {
      const run = await enqueueAgent(b, {
        ...input(`Fictional provenance ${randomUUID()}`),
        sourceIds: [source.id],
      });
      expect(await processNextAgent(b)).toBe(true);
      return await readAgentRun(b, run.id);
    } finally {
      spy.mockRestore();
    }
  }
  const input = (objective: string, provider: "rules" | "nvidia" = "nvidia"): RunInput => ({
    agentId: "documents",
    provider,
    aircraftId: null,
    requirementId: null,
    contactId: null,
    sourceIds: [],
    connectorIds: [],
    objective,
    allowExternalSources: false,
    allowModelData: provider !== "rules",
    allowMailbox: false,
    idempotencyKey: randomUUID(),
  });
  beforeAll(async () => {
    if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
      throw new Error("Dedicated _test database required.");
    process.env.DATABASE_URL = testUrl;
    execFileSync(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
      env: { ...process.env, DATABASE_URL: testUrl },
      stdio: "pipe",
    });
    a = await workspaceFor(randomUUID());
    b = await workspaceFor(randomUUID());
    vi.stubEnv("NVIDIA_API_KEY", "fictional-test-key");
    vi.stubEnv("BRAVE_SEARCH_API_KEY", "fictional-test-search-key");
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
        "agent_validations",
        "operations_settings",
        "discovery_results",
        "discovery_searches",
        "agent_proposals",
        "agent_steps",
        "agent_runs",
        "reviews",
        "extractions",
        "sources",
      ])
        await db.query(`delete from aerion.${table} where workspace_id=any($1::uuid[])`, [
          [a.workspaceId, b.workspaceId],
        ]);
      await db.query("delete from aerion.worker_heartbeats where id=$1", [heartbeatId]);
      await db.query("delete from aerion.workspaces where id=any($1::uuid[])", [
        [a.workspaceId, b.workspaceId],
      ]);
      await db.query("commit");
    } finally {
      db.release();
      await pool().end();
    }
  });
  it("records scoped limits and rejects concurrent settings changes without exposing another workspace's validation", async () => {
    let detail = await readOperations(a);
    expect(detail.settings.maxModelJobs).toBe(25);
    detail = await updateOperations(a, {
      revision: detail.revision,
      settings: { ...defaultOperationSettings, maxModelJobs: 1, maxSearches: 1 },
      note: "Fictional operating budget acceptance check",
    });
    expect(detail.revision).toBe(1);
    await expect(
      updateOperations(a, {
        revision: 0,
        settings: defaultOperationSettings,
        note: "Fictional stale settings request",
      }),
    ).rejects.toThrow("settings changed");
    expect((await readOperations(b)).settings.maxModelJobs).toBe(25);
    await expect(
      recordAgentValidation(a, {
        agentId: "documents",
        provider: "nvidia",
        model: "fictional-test",
        runId: randomUUID(),
        status: "passed",
        origin: "live-fixture",
        reportHash: "a".repeat(64),
        result: { summary: "A caller claim is not acceptance evidence." },
      }),
    ).rejects.toThrow("not found");
    expect(
      (await readOperations(b)).validations.find((v) => v.agentId === "documents")?.status,
    ).toBe("pending");
    await expect(
      transaction(a.actorId, a.workspaceId, (db) =>
        db.query("update aerion.agent_validations set status='failed' where workspace_id=$1", [
          a.workspaceId,
        ]),
      ),
    ).rejects.toThrow();
  });
  it("reserves the daily AI job limit atomically and preserves idempotent reuse", async () => {
    const request = input("Fictional first model job");
    const first = await enqueueAgent(a, request);
    expect((await enqueueAgent(a, request)).id).toBe(first.id);
    expect((await enqueueAgent(a, { ...request, idempotencyKey: randomUUID() })).id).toBe(first.id);
    await expect(enqueueAgent(a, input("Fictional second model job"))).rejects.toThrow(
      "daily AI job",
    );
    const body = "Model: A319\nFictional operating-control source only.";
    const source = await createSource(a, {
      title: "Fictional operating controls",
      kind: "text",
      sourceUrl: null,
      filename: "fixture.txt",
      contentType: "text/plain",
      original: Buffer.from(body),
      pages: [{ page: 1, text: body }],
    });
    await expect(enqueueExtraction(a, source.id, "nvidia")).rejects.toThrow("daily AI job");
    const detail = await readOperations(a);
    expect(detail.usage.modelJobs).toBe(1);
    await updateOperations(a, {
      revision: detail.revision,
      settings: { ...detail.settings, paused: true },
      note: "Fictional pause should stop new external work",
    });
    expect(await processNextAgent(a)).toBe(false);
    await expect(enqueueAgent(a, input("Fictional paused rules job", "rules"))).rejects.toThrow(
      "paused",
    );
    await enqueueExtraction(a, source.id, "local");
    expect(await processNext(a)).toBe(true);
  });
  it("enforces the daily Brave query allowance before making another external call", async () => {
    const detail = await readOperations(a);
    await updateOperations(a, {
      revision: detail.revision,
      settings: { ...detail.settings, paused: false },
      note: "Fictional resume for bounded search acceptance",
    });
    const fetch = vi.fn(async () => Response.json({ web: { results: [] } }));
    vi.stubGlobal("fetch", fetch);
    const searchInput = (query: string): RunInput => ({
      ...input(query, "rules"),
      agentId: "buyer-discovery",
      allowExternalSources: true,
      discovery: {
        side: "Buyer",
        buyerIntent: "Demand",
        purpose: "leads",
        target: "Fictional A319",
        market: "Commercial",
        region: "",
        method: "web",
        query,
        urls: [],
        freshness: "any",
      },
    });
    const first = await enqueueAgent(a, searchInput("Fictional buyer fixture one"));
    const firstRun = await readAgentRun(a, first.id);
    await discoverSources(a, firstRun, new AbortController().signal);
    await discoverSources(a, firstRun, new AbortController().signal);
    const second = await enqueueAgent(a, searchInput("Fictional buyer fixture two"));
    await expect(
      discoverSources(a, await readAgentRun(a, second.id), new AbortController().signal),
    ).rejects.toThrow("daily web search");
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await readOperations(a)).usage.searches).toBe(1);
  });
  it("reports an actual heartbeat and a stopped worker without claiming configuration proves liveness", async () => {
    await workerHeartbeat(heartbeatId);
    expect((await readOperations(a)).worker.ready).toBe(true);
    await workerHeartbeat(heartbeatId, true);
    const state = await readOperations(a);
    expect(state.worker.lastSeen).toBeTruthy();
    expect(state.alerts.every((alert) => !alert.detail.includes("fictional-test-key"))).toBe(true);
  });
  it("separates live-run observation from acceptance and rejects forged source claims", async () => {
    validatedRun = await observedDocumentRun();
    expect(
      (await readOperations(b)).validations.find((v) => v.agentId === "documents"),
    ).toMatchObject({ status: "observed", acceptanceProfile: null });
    const record = {
      agentId: "documents" as const,
      provider: "nvidia" as const,
      model: validatedRun.model ?? "",
      runId: validatedRun.id,
      status: "passed" as const,
      origin: "live-fixture" as const,
      reportHash: fingerprint(validatedRun.report),
      result: {
        steps: validatedRun.steps.map((s) => s.tool),
        proposals: 0,
        applied: 0,
        acceptedActions: [],
        expectedAction: null,
        acceptancePassed: true,
      },
    };
    await expect(recordAgentValidation(b, { ...record, agentId: "matching" })).rejects.toThrow(
      "role, provider or model",
    );
    await expect(
      recordAgentValidation(b, { ...record, model: "forged-provider-model" }),
    ).rejects.toThrow("role, provider or model");
    await expect(
      recordAgentValidation(b, { ...record, reportHash: "a".repeat(64) }),
    ).rejects.toThrow("report hash");
    await expect(
      recordAgentValidation(b, { ...record, result: { ...record.result, proposals: 99 } }),
    ).rejects.toThrow("proposals");
    await expect(
      recordAgentValidation(b, {
        ...record,
        result: { ...record.result, steps: ["workspace_context"] },
      }),
    ).rejects.toThrow("steps");
    await expect(
      recordAgentValidation(b, {
        ...record,
        result: { ...record.result, acceptedActions: ["contact"] },
      }),
    ).rejects.toThrow("acceptedActions");
    await expect(recordAgentValidation(a, record)).rejects.toThrow("not found");
    expect(await recordAgentValidation(b, record)).toMatchObject({
      status: "passed",
      reused: false,
    });
    expect(await recordAgentValidation(b, record)).toMatchObject({
      status: "passed",
      reused: true,
    });
    expect(
      (await readOperations(b)).validations.find((v) => v.agentId === "documents"),
    ).toMatchObject({
      status: "passed",
      proofKind: "same-workspace",
      counts: { toolCalls: 2, proposals: 0, accepted: 0 },
    });
    await expect(
      transaction(b.actorId, b.workspaceId, (db) =>
        db.query("update aerion.agent_validations set status='failed' where workspace_id=$1", [
          b.workspaceId,
        ]),
      ),
    ).rejects.toThrow();
  });
  it("publishes only independently verified sanitized fixture proof across scoped workspaces", async () => {
    const sourceDb = await pool().connect(),
      claims = {
        agentId: "documents",
        runId: validatedRun.id,
        provider: "nvidia",
        model: validatedRun.model,
        acceptancePassed: true,
        steps: validatedRun.steps.map((s) => s.tool),
        proposals: 0,
        applied: 0,
        acceptedActions: [],
        expectedAction: null,
        summary: validatedRun.report?.summary,
      };
    try {
      await expect(
        publishAgentFixtureValidations(
          a,
          sourceDb,
          { actorId: a.actorId, workspaceId: b.workspaceId },
          [claims],
          "b".repeat(64),
        ),
      ).rejects.toThrow("not owned");
      await expect(
        publishAgentFixtureValidations(a, sourceDb, b, [{ ...claims, applied: 1 }], "b".repeat(64)),
      ).rejects.toThrow("applied");
      expect(
        await publishAgentFixtureValidations(a, sourceDb, b, [claims], "b".repeat(64)),
      ).toEqual([{ runId: validatedRun.id, status: "passed", reused: false }]);
      expect(
        await publishAgentFixtureValidations(a, sourceDb, b, [claims], "b".repeat(64)),
      ).toEqual([{ runId: validatedRun.id, status: "passed", reused: true }]);
      const state = await readOperations(a),
        documents = state.validations.find((v) => v.agentId === "documents");
      expect(documents).toMatchObject({
        status: "passed",
        proofKind: "published-fixture",
        observed: null,
      });
      const stored = await transaction(a.actorId, a.workspaceId, (db) =>
        db.query(
          "select result from aerion.agent_validations where workspace_id=$1 and source_run_id=$2",
          [a.workspaceId, validatedRun.id],
        ),
      );
      const serialized = JSON.stringify(stored.rows[0].result);
      expect(serialized).not.toContain(privateMarker);
      expect(serialized).not.toContain(b.actorId);
      expect(serialized).not.toContain(b.workspaceId);
      expect(serialized).toContain("artifactHash");
    } finally {
      sourceDb.release();
    }
  });
  it("retains failed capability checks and records a later successful check separately", async () => {
    const forged = await observedDocumentRun();
    await transaction(b.actorId, b.workspaceId, (db) =>
      db.query(
        "insert into aerion.agent_steps(id,workspace_id,run_id,tool,input,output) values($1,$2,$3,'send_email','{}','{}')",
        [randomUUID(), b.workspaceId, forged.id],
      ),
    );
    const base = {
      agentId: "documents" as const,
      provider: "nvidia" as const,
      model: forged.model ?? "",
      runId: forged.id,
      origin: "live-fixture" as const,
      reportHash: fingerprint(forged.report),
      result: {},
    };
    await expect(recordAgentValidation(b, { ...base, status: "passed" })).rejects.toThrow(
      "ungranted tool",
    );
    await recordAgentValidation(b, { ...base, status: "failed" });
    expect(
      (await readOperations(b)).validations.find((v) => v.agentId === "documents")?.status,
    ).toBe("failed");
    const next = await observedDocumentRun();
    await recordAgentValidation(b, {
      ...base,
      runId: next.id,
      model: next.model ?? "",
      reportHash: fingerprint(next.report),
      status: "passed",
    });
    const final = (await readOperations(b)).validations.find((v) => v.agentId === "documents");
    expect(final?.status).toBe("passed");
    expect(final?.history).toHaveLength(3);
    expect(final?.history.some((record) => record.status === "failed" && record.verified)).toBe(
      true,
    );
  });
  it("accepts a corrected NVIDIA report diagnostic separately from the thirty business-tool limit", async () => {
    const run = await observedDocumentRun(true);
    expect(run.steps).toHaveLength(31);
    await recordAgentValidation(b, {
      agentId: "documents",
      provider: "nvidia",
      model: run.model ?? "",
      runId: run.id,
      status: "passed",
      origin: "live-fixture",
      reportHash: fingerprint(run.report),
      result: {
        steps: run.steps.map((s) => s.tool),
        proposals: 0,
        applied: 0,
        acceptancePassed: true,
      },
    });
    expect(
      (await readOperations(b)).validations.find((v) => v.agentId === "documents")?.counts,
    ).toEqual({ toolCalls: 30, proposals: 0, accepted: 0, reportDiagnostics: 1 });
    const impossible = await observedDocumentRun();
    await transaction(b.actorId, b.workspaceId, (db) =>
      db.query(
        "insert into aerion.agent_steps(id,workspace_id,run_id,tool,input,output) values($1,$2,$3,'finish_report',$4,$5)",
        [
          randomUUID(),
          b.workspaceId,
          impossible.id,
          { rejectedReport: null },
          {
            error:
              "A claimed rejected request would leave no request for the successful final report.",
          },
        ],
      ),
    );
    await expect(
      recordAgentValidation(b, {
        agentId: "documents",
        provider: "nvidia",
        model: impossible.model ?? "",
        runId: impossible.id,
        status: "passed",
        origin: "live-fixture",
        reportHash: fingerprint(impossible.report),
        result: {},
      }),
    ).rejects.toThrow("unbounded runtime report diagnostic");
  });
});
