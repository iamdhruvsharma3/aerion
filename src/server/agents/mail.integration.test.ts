import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pool, transaction, workspaceFor, type Scope } from "../db";
import {
  createSource,
  decideReview,
  mutateWorkspace,
  readPipeline,
  readSource,
  readWorkspace,
} from "../repository";
import { enqueueExtraction, processNext } from "../jobs";
import { sampleSource } from "../../lib/intelligence/schema";
import { mutateExecution, readExecution } from "../execution";
import { mailConfiguration } from "./mail-config";
import { collectMailbox } from "./mailbox";
import { queueDelivery, processNextDelivery, readMailStatus, decideDelivery } from "./delivery";
const protocol = vi.hoisted(() => ({
  send: vi.fn(),
  createTransport: vi.fn(),
  closeSmtp: vi.fn(),
  connect: vi.fn(),
  lock: vi.fn(),
  search: vi.fn(),
  closeImap: vi.fn(),
  logout: vi.fn(),
  release: vi.fn(),
  imapOptions: vi.fn(),
  uidValidity: 111,
  messages: [] as { uid: number; source: Buffer; size: number }[],
}));
vi.mock("nodemailer", () => ({ default: { createTransport: protocol.createTransport } }));
vi.mock("imapflow", () => ({
  ImapFlow: class {
    mailbox = { uidValidity: protocol.uidValidity };
    constructor(options: unknown) {
      protocol.imapOptions(options);
    }
    connect = protocol.connect;
    getMailboxLock = protocol.lock;
    search = protocol.search;
    close = protocol.closeImap;
    logout = protocol.logout;
    async *fetch(ids: number[]) {
      for (const message of protocol.messages.filter((m) => ids.includes(m.uid))) yield message;
    }
  },
}));
const testUrl = process.env.AERION_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("Mailbox and reviewed delivery integration", () => {
  const actors = [randomUUID(), randomUUID()];
  let a: Scope, b: Scope, aircraftId: string;
  let counter = 0;
  const environmentKeys = [
    "AERION_MAIL_OWNER_ID",
    "IMAP_HOST",
    "IMAP_USER",
    "IMAP_FOLDER",
    "IMAP_PASSWORD",
    "SMTP_HOST",
    "SMTP_USER",
    "SMTP_PASSWORD",
    "SMTP_FROM",
  ] as const;
  const environment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
  async function draft(review = true) {
    const n = ++counter,
      requirementId = randomUUID(),
      contactId = randomUUID();
    let workspace = await readWorkspace(a);
    workspace = await mutateWorkspace(
      a,
      {
        type: "requirement",
        item: {
          id: requirementId,
          client: `Fictional Mail Buyer ${n}`,
          aircraftModel: "Airbus A319",
          category: "Commercial",
          quantity: 1,
          minYear: 2010,
          engine: "CFM56",
          budget: 23000000,
          deadline: "2027-04-01",
          destination: "India",
          status: "Draft",
          description: "Fictional integration fixture; no actual buyer.",
        },
      },
      workspace.revision,
    );
    await mutateWorkspace(
      a,
      {
        type: "contact",
        item: {
          id: contactId,
          name: `Fictional Mail Contact ${n}`,
          role: "Buyer representative",
          company: "Fictional Mail Company",
          email: `mail-fixture-${n}@example.com`,
          location: "India",
          type: "Buyer",
          notes: "Fictional fixture only.",
        },
      },
      workspace.revision,
    );
    const change = async (action: Parameters<typeof mutateExecution>[2]) =>
      mutateExecution(a, requirementId, action, (await readExecution(a, requirementId)).revision);
    await change({
      type: "confirm-brief",
      confirmation: {
        contact: `Fictional Mail Contact ${n}`,
        confirmedOn: "2026-01-01",
        basis: "Fictional mail integration brief, not a real mandate or request.",
      },
      attested: true,
    });
    await change({ type: "link-contact", contactId });
    await change({
      type: "shortlist",
      aircraftId,
      decision: "Shortlisted",
      reason: "Fictional source-backed candidate matches the recorded constraints.",
    });
    await change({ type: "prepare-draft", aircraftId, contactId, audience: "Buyer" });
    let result = (await readExecution(a, requirementId)).drafts[0];
    if (review) {
      await change({
        type: "review-draft",
        draftId: result.id,
        status: "Reviewed",
        note: "Fictional recipient, body and every retained claim reviewed.",
        attested: true,
      });
      result = (await readExecution(a, requirementId)).drafts[0];
    }
    return { draft: result, requirementId, contactId };
  }
  const approval = (draftId: string) => ({
    draftId,
    idempotencyKey: randomUUID(),
    attested: true as const,
    note: "Fictional test approval. All SMTP and IMAP traffic uses test doubles.",
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
    Object.assign(process.env, {
      AERION_MAIL_OWNER_ID: actors[0],
      IMAP_HOST: "imap.fixture.invalid",
      IMAP_USER: "founder@example.com",
      IMAP_FOLDER: "Aerion",
      IMAP_PASSWORD: "fictional-imap-test-secret",
      SMTP_HOST: "smtp.fixture.invalid",
      SMTP_USER: "founder@example.com",
      SMTP_PASSWORD: "fictional-smtp-test-secret",
      SMTP_FROM: "founder@example.com",
    });
    const text = sampleSource.replace("LOCAL-EXAMPLE-01", `MAIL-${randomUUID()}`),
      source = await createSource(a, {
        title: "Fictional mail aircraft",
        kind: "text",
        sourceUrl: null,
        filename: "mail-aircraft.txt",
        contentType: "text/plain",
        original: Buffer.from(text),
        pages: [{ page: 1, text }],
      });
    await enqueueExtraction(a, source.id, "local");
    await processNext(a);
    aircraftId =
      (
        await decideReview(a, (await readPipeline(a)).reviews[0].id, {
          decision: "approve",
          note: "",
          attested: true,
        })
      ).aircraftId ?? "";
  }, 30000);
  beforeEach(() => {
    protocol.send.mockReset();
    protocol.createTransport.mockReset();
    protocol.closeSmtp.mockReset();
    protocol.createTransport.mockReturnValue({
      sendMail: protocol.send,
      close: protocol.closeSmtp,
    });
    protocol.send.mockImplementation(async (message: { to: string; messageId: string }) => ({
      accepted: [message.to],
      response: "250 Fictional server acceptance",
      messageId: message.messageId,
    }));
    protocol.connect.mockResolvedValue(undefined);
    protocol.lock.mockResolvedValue({ release: protocol.release });
    protocol.logout.mockResolvedValue(undefined);
  });
  afterAll(async () => {
    for (const [key, value] of environment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (!a) return;
    const db = await pool().connect();
    try {
      await db.query("begin");
      for (const table of [
        "activity",
        "source_links",
        "mail_deliveries",
        "mailbox_cursors",
        "readiness_items",
        "case_actions",
        "outreach_drafts",
        "shortlist_decisions",
        "case_contacts",
        "execution_cases",
        "signals",
        "reviews",
        "extractions",
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
  it("collects exact email originals and supported attachments without mutating the mailbox, and resumes from its UID cursor", async () => {
    const email = Buffer.from(
      'From: seller@example.com\r\nTo: founder@example.com\r\nDate: Thu, 29 Oct 2026 10:00:00 +0000\r\nSubject: Fictional engine record\r\nMessage-ID: <fixture-intake@example.com>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="fixture"\r\n\r\n--fixture\r\nContent-Type: text/plain\r\n\r\nPlease review this fictional specification.\r\n--fixture\r\nContent-Type: text/plain\r\nContent-Disposition: attachment; filename="engine.txt"\r\nContent-Transfer-Encoding: base64\r\n\r\nRW5naW5lOiBDRk01Ni01Qg==\r\n--fixture--\r\n',
    );
    protocol.messages = [{ uid: 1, source: email, size: email.length }];
    protocol.search.mockResolvedValue([1]);
    const result = await collectMailbox(a, new AbortController().signal);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].attachmentIds).toHaveLength(1);
    expect(protocol.lock).toHaveBeenCalledWith("Aerion", { readOnly: true, acquireTimeout: 10000 });
    expect(protocol.imapOptions.mock.calls[0][0].tls.rejectUnauthorized).toBe(true);
    expect((await readSource(a, result.messages[0].sourceId, true)).original.equals(email)).toBe(
      true,
    );
    const links = await transaction(a.actorId, a.workspaceId, (db) =>
      db.query("select * from aerion.source_links where parent_id=$1", [
        result.messages[0].sourceId,
      ]),
    );
    expect(links.rows[0].child_id).toBe(result.messages[0].attachmentIds[0]);
    expect((await collectMailbox(a, new AbortController().signal)).messages).toHaveLength(0);
  });
  it("requires a current reviewed draft and explicit approval before queuing", async () => {
    const prepared = await draft(false);
    await expect(queueDelivery(a, approval(prepared.draft.id))).rejects.toMatchObject({
      status: 422,
    });
    const reviewed = await draft();
    await expect(
      queueDelivery(a, { ...approval(reviewed.draft.id), attested: false as true }),
    ).rejects.toThrow();
    await expect(queueDelivery(b, approval(reviewed.draft.id))).rejects.toMatchObject({
      status: 503,
    });
    expect(mailConfiguration(b).smtp.sender).toBeNull();
  });
  it("submits an approved immutable snapshot once and records server acceptance without claiming recipient delivery", async () => {
    const item = await draft(),
      request = approval(item.draft.id),
      queued = await queueDelivery(a, request);
    expect((await queueDelivery(a, request)).id).toBe(queued.id);
    expect((await queueDelivery(a, approval(item.draft.id))).id).toBe(queued.id);
    expect(await processNextDelivery(a)).toBe(true);
    const delivery = (await readMailStatus(a, item.draft.id)).deliveries[0];
    expect(delivery.status).toBe("accepted");
    expect(delivery.attempts).toBe(1);
    expect(delivery.body).toBe(item.draft.body);
    expect(protocol.send).toHaveBeenCalledTimes(1);
    expect(protocol.createTransport.mock.calls[0][0].tls.rejectUnauthorized).toBe(true);
    expect(protocol.createTransport.mock.calls[0][0].requireTLS).toBe(true);
    expect(protocol.send.mock.calls[0][0].messageId).toBe(delivery.messageId);
    expect(await processNextDelivery(a)).toBe(false);
    expect((await readMailStatus({ ...b, workspaceId: a.workspaceId })).deliveries).toEqual([]);
    await expect(
      transaction(a.actorId, a.workspaceId, (db) =>
        db.query("update aerion.mail_deliveries set recipient='altered@example.com' where id=$1", [
          queued.id,
        ]),
      ),
    ).rejects.toThrow("permission denied");
  });
  it("does not automatically resend an ambiguous outcome and requires reconciliation before retrying", async () => {
    const item = await draft();
    await queueDelivery(a, approval(item.draft.id));
    protocol.send.mockRejectedValueOnce(
      Object.assign(new Error("Fictional timeout after DATA"), {
        command: "DATA",
        code: "ETIMEDOUT",
      }),
    );
    await processNextDelivery(a);
    let delivery = (await readMailStatus(a, item.draft.id)).deliveries[0];
    expect(delivery.status).toBe("unknown");
    expect(await processNextDelivery(a)).toBe(false);
    expect(protocol.send).toHaveBeenCalledTimes(1);
    await expect(
      decideDelivery(a, delivery.id, {
        operation: "retry",
        revision: delivery.revision,
        attested: true,
        note: "A new attempt must not be allowed for an unknown outcome.",
      }),
    ).rejects.toMatchObject({ status: 422 });
    await decideDelivery(a, delivery.id, {
      operation: "confirm-not-sent",
      revision: delivery.revision,
      attested: true,
      note: "Fictional server-log review confirms this test message was not accepted.",
    });
    delivery = (await readMailStatus(a, item.draft.id)).deliveries[0];
    await decideDelivery(a, delivery.id, {
      operation: "retry",
      revision: delivery.revision,
      attested: true,
      note: "Fictional recipient and unchanged approved message reviewed before explicit retry.",
    });
    await processNextDelivery(a);
    expect((await readMailStatus(a, item.draft.id)).deliveries[0].status).toBe("accepted");
    expect(protocol.send).toHaveBeenCalledTimes(2);
  });
  it("makes interrupted submissions unknown and cancels queued messages without network work", async () => {
    const interrupted = await draft(),
      first = await queueDelivery(a, approval(interrupted.draft.id));
    await transaction(a.actorId, a.workspaceId, (db) =>
      db.query(
        "update aerion.mail_deliveries set status='sending',sending_at=now()-interval '3 minutes' where id=$1",
        [first.id],
      ),
    );
    expect(await processNextDelivery(a)).toBe(false);
    expect((await readMailStatus(a, interrupted.draft.id)).deliveries[0].status).toBe("unknown");
    expect(protocol.send).not.toHaveBeenCalled();
    const item = await draft(),
      queued = await queueDelivery(a, approval(item.draft.id));
    await decideDelivery(a, queued.id, {
      operation: "cancel",
      revision: 0,
      attested: true,
      note: "Fictional founder cancellation before any SMTP submission.",
    });
    expect(await processNextDelivery(a)).toBe(false);
    expect((await readMailStatus(a, item.draft.id)).deliveries[0].status).toBe("cancelled");
    expect(protocol.send).not.toHaveBeenCalled();
  });
  it("rechecks the approved draft context before external submission", async () => {
    const item = await draft();
    await queueDelivery(a, approval(item.draft.id));
    const snapshot = await readWorkspace(a);
    try {
      await transaction(a.actorId, a.workspaceId, (db) =>
        db.query("update aerion.workspaces set data=$1,revision=revision+1 where id=$2", [
          {
            ...snapshot.data,
            aircraft: snapshot.data.aircraft.map((aircraft) => ({
              ...aircraft,
              availableDate: null,
            })),
          },
          a.workspaceId,
        ]),
      );
      await processNextDelivery(a);
      expect((await readMailStatus(a, item.draft.id)).deliveries[0].status).toBe("failed");
      expect(protocol.send).not.toHaveBeenCalled();
    } finally {
      await transaction(a.actorId, a.workspaceId, (db) =>
        db.query("update aerion.workspaces set data=$1,revision=revision+1 where id=$2", [
          snapshot.data,
          a.workspaceId,
        ]),
      );
    }
  });
});
