import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool, transaction, workspaceFor, type Scope } from "./db";
import {
  createSource,
  decideReview,
  mutateWorkspace,
  readPipeline,
  readSource,
  readReview,
  readWorkspace,
} from "./repository";
import { enqueueExtraction, processNext } from "./jobs";
import { sampleSource } from "../lib/intelligence/schema";
import { evaluateMatch } from "../lib/matching";
import { sameOrigin, HttpError } from "./http";
import { documentPages } from "./documents";

const testUrl = process.env.AERION_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("PostgreSQL pipeline", () => {
  const actors = [randomUUID(), randomUUID()];
  let a: Scope, b: Scope;
  async function source(text = sampleSource) {
    return createSource(a, {
      title: "Integration test source",
      kind: "text",
      sourceUrl: null,
      filename: "source.txt",
      contentType: "text/plain",
      original: Buffer.from(text),
      pages: [{ page: 1, text }],
    });
  }
  beforeAll(async () => {
    if (!testUrl || !new URL(testUrl).pathname.endsWith("_test"))
      throw new Error("Integration tests require a dedicated database ending in _test.");
    process.env.DATABASE_URL = testUrl;
    execFileSync(process.execPath, ["--import", "tsx", "scripts/migrate.ts"], {
      env: { ...process.env, DATABASE_URL: testUrl },
      stdio: "pipe",
    });
    a = await workspaceFor(actors[0]);
    b = await workspaceFor(actors[1]);
  });
  afterAll(async () => {
    if (!a) return;
    const db = await pool().connect();
    try {
      await db.query("begin");
      for (const table of ["activity", "reviews", "extractions", "sources"])
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
  it("isolates originals and candidate records even with another workspace ID", async () => {
    const created = await source();
    await expect(
      readSource({ ...b, workspaceId: a.workspaceId }, created.id),
    ).rejects.toMatchObject({ status: 404 });
    expect((await readPipeline({ ...b, workspaceId: a.workspaceId })).sources).toEqual([]);
    await expect(
      mutateWorkspace({ ...b, workspaceId: a.workspaceId }, { type: "toggle-task", id: "x" }, 0),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("retains exact original bytes and rejects duplicate uploads", async () => {
    const text = sampleSource.replace("LOCAL-EXAMPLE-01", randomUUID());
    const created = await source(text);
    expect((await readSource(a, created.id, true)).original.equals(Buffer.from(text))).toBe(true);
    await expect(source(text)).rejects.toMatchObject({ status: 409 });
    await expect(
      transaction(a.actorId, a.workspaceId, (db) =>
        db.query("update aerion.sources set title='altered' where id=$1", [created.id]),
      ),
    ).rejects.toThrow("permission denied");
  });
  it("publishes once after review and carries evidence into a matched opportunity", async () => {
    const created = await source(sampleSource.replace("LOCAL-EXAMPLE-01", randomUUID()));
    await enqueueExtraction(a, created.id, "local");
    await Promise.all([processNext(a), processNext(a)]);
    const reviews = (await readPipeline(a)).reviews.filter((r) => r.sourceId === created.id);
    expect(reviews).toHaveLength(1);
    const review = reviews[0];
    await expect(readReview({ ...b, workspaceId: a.workspaceId }, review.id)).rejects.toMatchObject(
      { status: 404 },
    );
    expect((await readWorkspace(a)).data.aircraft).toHaveLength(0);
    await expect(
      decideReview(a, review.id, { decision: "approve", attested: false, note: "" }),
    ).rejects.toMatchObject({ status: 422 });
    const results = await Promise.allSettled([
      decideReview(a, review.id, { decision: "approve", attested: true, note: "" }),
      decideReview(a, review.id, { decision: "approve", attested: true, note: "" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    let workspace = await readWorkspace(a);
    expect(workspace.data.aircraft).toHaveLength(1);
    const aircraft = workspace.data.aircraft[0];
    const requirement = {
      id: randomUUID(),
      client: "Fictional buyer",
      aircraftModel: "Airbus A319",
      category: "Commercial" as const,
      quantity: 1,
      minYear: 2010,
      engine: "CFM56",
      budget: 23000000,
      deadline: "2027-04-01",
      destination: "India",
      status: "Confirmed" as const,
      description: "Test brief",
    };
    expect(evaluateMatch(aircraft, requirement).state).toBe("eligible");
    workspace = await mutateWorkspace(
      a,
      { type: "requirement", item: requirement },
      workspace.revision,
    );
    workspace = await mutateWorkspace(
      a,
      {
        type: "deal",
        item: {
          id: randomUUID(),
          title: "Test opportunity",
          aircraftId: aircraft.id,
          requirementId: requirement.id,
          stage: "Sourcing",
          nextAction: "Reconfirm source claims",
          dueDate: "2026-10-27",
        },
      },
      workspace.revision,
    );
    expect(workspace.data.deals[0].evidence).toEqual(aircraft.evidence);
    expect(aircraft.evidence?.sourceId).toBe(created.id);
  });
  it("rejects incomplete approvals and edited values without an explanation", async () => {
    const created = await source(`Manufacturer: Airbus\nModel: A319\nSerial: ${randomUUID()}`);
    await enqueueExtraction(a, created.id, "local");
    await processNext(a);
    const review = (await readPipeline(a)).reviews.find((r) => r.sourceId === created.id);
    if (!review) throw new Error("Missing review");
    await expect(
      decideReview(a, review.id, { decision: "approve", attested: true, note: "" }),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      decideReview(a, review.id, {
        decision: "approve",
        attested: true,
        values: { ...review.values, year: 2015 },
        note: "",
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect((await readPipeline(a)).reviews.find((r) => r.id === review.id)?.status).toBe("pending");
    await decideReview(a, review.id, {
      decision: "reject",
      attested: false,
      note: "Insufficient source information",
    });
  });
  it("recovers an interrupted lease and does not publish automatically", async () => {
    const created = await source(sampleSource.replace("LOCAL-EXAMPLE-01", randomUUID()));
    const job = await enqueueExtraction(a, created.id, "local");
    await transaction(a.actorId, a.workspaceId, (db) =>
      db.query(
        "update aerion.extractions set status='running',attempts=1,lease_token=$1,leased_at=now()-interval '6 minutes' where id=$2",
        [randomUUID(), job.id],
      ),
    );
    expect(await processNext(a)).toBe(true);
    const sourceRecord = (await readPipeline(a)).sources.find((s) => s.id === created.id);
    expect(sourceRecord?.status).toBe("completed");
    expect(sourceRecord?.attempts).toBe(2);
    expect((await readPipeline(a)).reviews.find((r) => r.sourceId === created.id)?.status).toBe(
      "pending",
    );
  });
  it("detects concurrent writes instead of silently overwriting", async () => {
    const before = await readWorkspace(b);
    await mutateWorkspace(
      b,
      {
        type: "contact",
        item: {
          id: randomUUID(),
          name: "Example",
          role: "Owner",
          company: "Fictional",
          email: "example@example.com",
          location: "Example",
          type: "Seller",
          notes: "",
        },
      },
      before.revision,
    );
    await expect(
      mutateWorkspace(b, { type: "toggle-task", id: "x" }, before.revision),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("checks request origin before writes", () => {
    expect(() =>
      sameOrigin(
        new Request("http://127.0.0.1:3000/api/workspace", {
          method: "POST",
          headers: { Origin: "https://elsewhere.example" },
        }),
      ),
    ).toThrow(HttpError);
  });
  it("rejects unreadable PDFs and binary text", async () => {
    await expect(documentPages(Buffer.from("Not a PDF"), "pdf")).rejects.toMatchObject({
      status: 422,
    });
    await expect(documentPages(Buffer.from([0]), "text")).rejects.toMatchObject({ status: 422 });
  });
});
