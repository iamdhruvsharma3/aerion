import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, transaction, workspaceFor, type Scope } from "./db";
import {
  createSource,
  decideReview,
  readPipeline,
  readSource,
  readWorkspace,
  mutateWorkspace,
} from "./repository";
import { enqueueExtraction, processNext } from "./jobs";
import { decideSignal, readIntelligence, readSignal } from "./intelligence";
import {
  sampleMarketSource,
  type SignalDecision,
  type SignalRecord,
} from "../lib/intelligence/market-schema";
import { sampleSource } from "../lib/intelligence/schema";
import { evaluateMatch } from "../lib/matching";
import { documentPages } from "./documents";

const testUrl = process.env.AERION_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("PostgreSQL market intelligence", () => {
  const actors = [randomUUID(), randomUUID()];
  let a: Scope, b: Scope;
  async function source(text: string, scope = a) {
    const original = Buffer.from(text);
    return createSource(scope, {
      title: "Fictional market integration fixture",
      kind: "text",
      sourceUrl: null,
      filename: "market.txt",
      contentType: "text/plain",
      original,
      pages: await documentPages(original, "text"),
    });
  }
  async function signal(text = sampleMarketSource) {
    const created = await source(`${text}\nFixture reference: ${randomUUID()}`);
    await enqueueExtraction(a, created.id, "local", "market");
    await processNext(a);
    const result = (await readIntelligence(a)).signals.find(
      (s) => s.sourceId === created.id && s.values.intent === "Demand",
    );
    if (!result) throw new Error("No signal");
    return result;
  }
  const decision = (s: SignalRecord, action: SignalDecision["action"]): SignalDecision => ({
    action,
    revision: s.revision,
    values: s.values,
    note: "Fictional evidence checked during integration validation.",
    attested: true,
  });
  beforeAll(async () => {
    if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
      throw new Error("Use a dedicated _test database.");
    process.env.DATABASE_URL = testUrl;
    execFileSync(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
      env: { ...process.env, DATABASE_URL: testUrl },
      stdio: "pipe",
    });
    a = await workspaceFor(actors[0]);
    b = await workspaceFor(actors[1]);
  }, 30000);
  afterAll(async () => {
    if (!a) return;
    const db = await pool().connect();
    try {
      await db.query("begin");
      for (const table of ["activity", "signals", "reviews", "extractions", "sources"])
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
  it("ingests 52 originals, deduplicates, extracts and paginates without publishing buyers", async () => {
    const texts = Array.from(
      { length: 52 },
      (_, i) =>
        `Organization: Fictional batch ${i}\nAircraft family: A319\nSignal type: Demand\nMarket: Commercial\nQuantity: 1\nEvent date: 2026-10-20\nFixture: ${randomUUID()}`,
    );
    const sources = await Promise.all(texts.map((t) => source(t, b)));
    for (const s of sources) await enqueueExtraction(b, s.id, "local", "market");
    for (let i = 0; i < 52; i++) await processNext(b);
    await expect(source(texts[0], b)).rejects.toMatchObject({ status: 409 });
    expect((await readSource(b, sources[0].id, true)).original.toString()).toBe(texts[0]);
    const page = await readIntelligence(b);
    expect(page.total).toBe(52);
    expect(page.signals).toHaveLength(40);
    expect(page.pages).toBe(2);
    expect((await readIntelligence(b, { page: 2 })).signals).toHaveLength(12);
    expect((await readWorkspace(b)).data.requirements).toHaveLength(0);
  }, 30000);
  it("enforces ownership for signals, downloads and decisions and keeps observations immutable", async () => {
    const s = await signal();
    const foreign = { ...b, workspaceId: a.workspaceId };
    await expect(readSignal(foreign, s.id)).rejects.toMatchObject({ status: 404 });
    expect((await readIntelligence(foreign)).total).toBe(0);
    await expect(readSource(foreign, s.sourceId, true)).rejects.toMatchObject({ status: 404 });
    await expect(decideSignal(foreign, s.id, decision(s, "lead"))).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      transaction(a.actorId, a.workspaceId, (db) =>
        db.query("update aerion.signals set facts='[]' where id=$1", [s.id]),
      ),
    ).rejects.toThrow("permission denied");
  });
  it("requires ordered review, explicit attestation and actual confirmation fields", async () => {
    let s = await signal();
    await expect(decideSignal(a, s.id, decision(s, "confirm"))).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      decideSignal(a, s.id, { ...decision(s, "lead"), attested: false }),
    ).rejects.toMatchObject({ status: 422 });
    await decideSignal(a, s.id, decision(s, "lead"));
    s = await readSignal(a, s.id);
    await decideSignal(a, s.id, decision(s, "potential"));
    s = await readSignal(a, s.id);
    await expect(decideSignal(a, s.id, decision(s, "confirm"))).rejects.toMatchObject({
      status: 422,
    });
    expect((await readWorkspace(a)).data.requirements).toHaveLength(0);
  });
  it("keeps fleet announcements out of buyer requirements", async () => {
    const created = await source(
      `Example Operator orders 5 Challenger 3500 jets\nReference: ${randomUUID()}`,
    );
    await enqueueExtraction(a, created.id, "local", "market");
    await processNext(a);
    let s = (await readIntelligence(a)).signals.find((s) => s.sourceId === created.id);
    if (!s) throw new Error("No fleet signal");
    await decideSignal(a, s.id, decision(s, "lead"));
    s = await readSignal(a, s.id);
    await expect(decideSignal(a, s.id, decision(s, "potential"))).rejects.toMatchObject({
      status: 422,
    });
  });
  it("uses separate aircraft/market jobs and recovers a market lease without duplicating signals", async () => {
    const created = await source(
      `${sampleSource.replace("LOCAL-EXAMPLE-01", randomUUID())}\n${sampleMarketSource.split("\n---\n")[0]}\nReference: ${randomUUID()}`,
    );
    const market = await enqueueExtraction(a, created.id, "local", "market");
    await enqueueExtraction(a, created.id, "local");
    await expect(enqueueExtraction(a, created.id, "local", "market")).rejects.toMatchObject({
      status: 409,
    });
    await transaction(a.actorId, a.workspaceId, (db) =>
      db.query(
        "update aerion.extractions set status='running',attempts=1,lease_token=$1,leased_at=now()-interval '6 minutes' where id=$2",
        [randomUUID(), market.id],
      ),
    );
    await Promise.all([processNext(a), processNext(a)]);
    const intelligence = await readIntelligence(a);
    expect(intelligence.signals.filter((s) => s.sourceId === created.id)).toHaveLength(1);
    expect((await readPipeline(a)).reviews.filter((r) => r.sourceId === created.id)).toHaveLength(
      1,
    );
    expect(intelligence.sources.find((s) => s.id === created.id)).toMatchObject({
      status: "completed",
      attempts: 2,
    });
  });
  it("confirms once under concurrent review and carries buyer evidence through the existing matcher", async () => {
    let s = await signal();
    await decideSignal(a, s.id, decision(s, "lead"));
    s = await readSignal(a, s.id);
    await expect(
      decideSignal(a, s.id, { ...decision(s, "potential"), revision: 0 }),
    ).rejects.toMatchObject({ status: 409 });
    await decideSignal(a, s.id, decision(s, "potential"));
    s = await readSignal(a, s.id);
    const confirm: SignalDecision = {
      ...decision(s, "confirm"),
      confirmation: {
        contact: "Fictional contact",
        confirmedOn: "2026-10-20",
        basis: "Fictional confirmation for engineering validation only.",
      },
      requirement: {
        client: s.values.organization ?? "",
        aircraftModel: s.values.aircraftFamily ?? "",
        category: "Commercial",
        quantity: 1,
        minYear: 2010,
        engine: "CFM56",
        budget: 23000000,
        deadline: "2027-04-01",
        destination: "India",
        status: "Confirmed",
        description: "Fictional test brief",
      },
    };
    if (!confirm.confirmation) throw new Error("Missing confirmation fixture");
    await expect(
      decideSignal(a, s.id, {
        ...confirm,
        confirmation: { ...confirm.confirmation, confirmedOn: "2099-01-01" },
      }),
    ).rejects.toMatchObject({ status: 422 });
    const results = await Promise.allSettled([
      decideSignal(a, s.id, confirm),
      decideSignal(a, s.id, confirm),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const approved = await readSignal(a, s.id);
    let workspace = await readWorkspace(a);
    const requirement = workspace.data.requirements.find((r) => r.id === approved.requirementId);
    expect(requirement?.intelligence?.signalId).toBe(s.id);
    const aircraftSource = await source(sampleSource.replace("LOCAL-EXAMPLE-01", randomUUID()));
    await enqueueExtraction(a, aircraftSource.id, "local");
    await processNext(a);
    const review = (await readPipeline(a)).reviews.find((r) => r.sourceId === aircraftSource.id);
    if (!review || !requirement) throw new Error("Fixture missing");
    await decideReview(a, review.id, { decision: "approve", attested: true, note: "" });
    workspace = await readWorkspace(a);
    const aircraft = workspace.data.aircraft.find((item) => item.evidence?.reviewId === review.id);
    if (!aircraft) throw new Error("No approved aircraft");
    expect(evaluateMatch(aircraft, requirement).state).toBe("eligible");
    workspace = await mutateWorkspace(
      a,
      {
        type: "deal",
        item: {
          id: randomUUID(),
          title: "Fictional opportunity",
          aircraftId: aircraft.id,
          requirementId: requirement.id,
          stage: "Sourcing",
          nextAction: "Check fictional brief",
          dueDate: "2026-10-27",
        },
      },
      workspace.revision,
    );
    expect(workspace.data.deals[0].requirementEvidence).toEqual(requirement.intelligence);
    await expect(
      mutateWorkspace(
        a,
        { type: "requirement", item: { ...requirement, id: randomUUID() } },
        workspace.revision,
      ),
    ).rejects.toMatchObject({ status: 422 });
    expect(
      (
        await readIntelligence(a, { stage: "Confirmed requirement", q: s.values.organization })
      ).signals.some((item) => item.id === s.id),
    ).toBe(true);
    expect(
      (await readIntelligence(a, { market: "Business", intent: "Fleet activity" })).signals.every(
        (item) => item.values.market === "Business",
      ),
    ).toBe(true);
  });
  it("filters by event date without substituting capture date or future events", async () => {
    const today = new Date().toISOString().slice(0, 10);
    for (const eventDate of [today, "1999-01-01", "2099-01-01", null]) {
      const created = await source(
        `Organization: Recency fixture ${randomUUID()}\nAircraft family: A319\nSignal type: Demand${eventDate ? `\nEvent date: ${eventDate}` : ""}`,
      );
      await enqueueExtraction(a, created.id, "local", "market");
      await processNext(a);
    }
    expect((await readIntelligence(a, { q: "Recency fixture" })).total).toBe(4);
    const recent = await readIntelligence(a, { q: "Recency fixture", days: 30 });
    expect(recent.total).toBe(1);
    expect(recent.signals[0].values.eventDate).toBe(today);
    expect(recent.signals[0].capturedAt).toBeTruthy();
  });
  it("requires a decision note for dismissal and keeps it terminal", async () => {
    const s = await signal();
    await expect(decideSignal(a, s.id, { ...decision(s, "dismiss"), note: "" })).rejects.toThrow();
    await decideSignal(a, s.id, decision(s, "dismiss"));
    const dismissed = await readSignal(a, s.id);
    await expect(decideSignal(a, s.id, decision(dismissed, "lead"))).rejects.toMatchObject({
      status: 409,
    });
  });
});
