import { randomUUID } from "node:crypto";
import { enforceOperation, operationSettings } from "../operations/limits";
import { assertCommunicationDelivery } from "../communication/delivery-guard";
import nodemailer from "nodemailer";
import type { z } from "zod";
import {
  deliveryRequestSchema,
  deliveryDecisionSchema,
  type MailStatus,
} from "../../lib/agents/mail-schema";
import { transaction, audit, type Scope } from "../db";
import { readExecutionInTransaction } from "../execution";
import { HttpError } from "../http";
import { mailConfiguration, requireMail } from "./mail-config";
import type { PoolClient } from "pg";
import { readLeadDraftInTransaction } from "../leads/drafts";
const columns =
  'id,coalesce(draft_id,lead_draft_id) as "draftId",requirement_id as "requirementId",recipient,sender,subject,body,status,attempts,revision,message_id as "messageId",error,server_response as "serverResponse",created_at as "createdAt",finished_at as "finishedAt"';
async function mailDraft(db: PoolClient, scope: Scope, id: string, kind: "execution" | "lead") {
  if (kind === "lead")
    return { ...(await readLeadDraftInTransaction(db, scope, id)), requirementId: null };
  const row = (
    await db.query(
      "select c.requirement_id from aerion.outreach_drafts d join aerion.execution_cases c on c.id=d.case_id and c.workspace_id=d.workspace_id where d.id=$1 and d.workspace_id=$2",
      [id, scope.workspaceId],
    )
  ).rows[0];
  if (!row) throw new HttpError(404, "Draft not found.");
  const desk = await readExecutionInTransaction(db, scope, row.requirement_id),
    draft = desk.drafts.find((d) => d.id === id);
  if (!draft) throw new HttpError(404, "Draft not found.");
  const recipient = String(draft.claims.find((c) => c.field === "contact.email")?.value ?? ""),
    contact = desk.contacts.find((c) => c.id === draft.contactId);
  if (!contact || contact.email !== recipient)
    throw new HttpError(
      422,
      "The saved recipient changed. Prepare and review a current draft before sending.",
    );
  return { ...draft, recipient, requirementId: desk.requirement.id };
}
export async function readMailStatus(scope: Scope, draftId?: string): Promise<MailStatus> {
  return transaction(scope.actorId, scope.workspaceId, async (db) => ({
    configuration: mailConfiguration(scope),
    deliveries: (
      await db.query(
        `select ${columns} from aerion.mail_deliveries where workspace_id=$1 and ($2::uuid is null or draft_id=$2 or lead_draft_id=$2) order by created_at desc limit 40`,
        [scope.workspaceId, draftId ?? null],
      )
    ).rows,
  }));
}
export async function queueDelivery(scope: Scope, raw: z.infer<typeof deliveryRequestSchema>) {
  const input = deliveryRequestSchema.parse(raw),
    configuration = requireMail(scope, "smtp");
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    await db.query("select id from aerion.workspaces where id=$1 for update", [scope.workspaceId]);
    const prior = await db.query(
      "select id,draft_id,lead_draft_id from aerion.mail_deliveries where workspace_id=$1 and idempotency_key=$2",
      [scope.workspaceId, input.idempotencyKey],
    );
    if (prior.rows[0]) {
      if (
        (input.kind === "lead" ? prior.rows[0].lead_draft_id : prior.rows[0].draft_id) !==
        input.draftId
      )
        throw new HttpError(409, "This delivery key belongs to a different draft.");
      return { id: prior.rows[0].id, reused: true };
    }
    const draft = await mailDraft(db, scope, input.draftId, input.kind ?? "execution");
    if (draft?.status !== "Reviewed" || draft.stale)
      throw new HttpError(
        422,
        "Email delivery requires a reviewed draft with current evidence and context.",
      );
    const recipient = draft.recipient;
    const existing = await db.query(
      "select id from aerion.mail_deliveries where workspace_id=$1 and (draft_id=$2 or lead_draft_id=$2)",
      [scope.workspaceId, input.draftId],
    );
    if (existing.rows[0]) return { id: existing.rows[0].id, reused: true };
    await enforceOperation(db, scope, "mail");
    await assertCommunicationDelivery(db, scope, recipient, draft.requirementId);
    const id = randomUUID(),
      sender = configuration.smtp.sender ?? "",
      messageId = `<${id}@${sender.split("@")[1]}>`;
    await db.query(
      "insert into aerion.mail_deliveries(id,workspace_id,draft_id,requirement_id,contact_id,sender,recipient,subject,body,context_hash,idempotency_key,reviewer,review_note,message_id,lead_draft_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
      [
        id,
        scope.workspaceId,
        input.kind === "lead" ? null : draft.id,
        draft.requirementId,
        draft.contactId,
        sender,
        recipient,
        draft.subject,
        draft.body,
        draft.contextHash,
        input.idempotencyKey,
        scope.actorId,
        input.note,
        messageId,
        input.kind === "lead" ? draft.id : null,
      ],
    );
    await audit(db, scope, "mail.delivery-approved", id, {
      draftId: draft.id,
      recipient,
      sender,
      note: input.note,
    });
    return { id, reused: false };
  });
}
export async function decideDelivery(
  scope: Scope,
  id: string,
  raw: z.infer<typeof deliveryDecisionSchema>,
) {
  const input = deliveryDecisionSchema.parse(raw);
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    await db.query("select id from aerion.workspaces where id=$1 for update", [scope.workspaceId]);
    const result = await db.query(
        "select * from aerion.mail_deliveries where id=$1 and workspace_id=$2 for update",
        [id, scope.workspaceId],
      ),
      row = result.rows[0];
    if (!row) throw new HttpError(404, "Delivery not found.");
    if (row.revision !== input.revision)
      throw new HttpError(409, "Delivery status changed. Reload before deciding.");
    let status: string;
    if (input.operation === "cancel") {
      if (row.status !== "queued")
        throw new HttpError(
          409,
          "Only a queued message can be cancelled. A sending message may already have been accepted by the server.",
        );
      status = "cancelled";
    } else if (input.operation === "retry") {
      if (!["failed", "cancelled"].includes(row.status))
        throw new HttpError(
          422,
          "Only a confirmed unsent or cancelled delivery can be retried. Resolve unknown outcomes first.",
        );
      requireMail(scope, "smtp");
      await enforceOperation(db, scope, "agent");
      await assertCommunicationDelivery(db, scope, row.recipient, row.requirement_id);
      const draft = await mailDraft(
        db,
        scope,
        row.lead_draft_id ?? row.draft_id,
        row.lead_draft_id ? "lead" : "execution",
      );
      if (draft?.status !== "Reviewed" || draft.stale || draft.contextHash !== row.context_hash)
        throw new HttpError(
          422,
          "This draft changed or is no longer reviewed. Prepare a new current draft.",
        );
      status = "queued";
    } else {
      if (row.status !== "unknown")
        throw new HttpError(
          422,
          "Manual reconciliation applies only to an unknown delivery outcome.",
        );
      status = input.operation === "confirm-accepted" ? "accepted" : "failed";
    }
    await db.query(
      "update aerion.mail_deliveries set status=$1,revision=revision+1,error=case when $1='queued' then null else error end,finished_at=case when $1='queued' then null else now() end where id=$2",
      [status, id],
    );
    await audit(db, scope, `mail.${input.operation}`, id, { status, note: input.note });
    return { status };
  });
}
/** SMTP acceptance is a submission receipt, never proof of recipient delivery. No automatic retry after an ambiguous result. */
export async function processNextDelivery(scope: Scope) {
  const job = await transaction(scope.actorId, scope.workspaceId, async (db) => {
    await db.query("select id from aerion.workspaces where id=$1 for update", [scope.workspaceId]);
    const interrupted = await db.query(
      "update aerion.mail_deliveries set status='unknown',revision=revision+1,error='The sending process was interrupted. Check the Sent folder or server logs before deciding whether to resend.',finished_at=now() where workspace_id=$1 and status='sending' and sending_at<now()-interval '2 minutes' returning id",
      [scope.workspaceId],
    );
    for (const row of interrupted.rows)
      await audit(db, scope, "mail.outcome-unknown", row.id, { reason: "interrupted-send" });
    if ((await operationSettings(db, scope)).paused) return null;
    const result = await db.query(
      "select * from aerion.mail_deliveries where workspace_id=$1 and status='queued' order by created_at,id for update skip locked limit 1",
      [scope.workspaceId],
    );
    if (!result.rows[0]) return null;
    await db.query(
      "update aerion.mail_deliveries set status='sending',sending_at=now(),attempts=attempts+1,revision=revision+1,error=null where id=$1",
      [result.rows[0].id],
    );
    return result.rows[0];
  });
  if (!job) return false;
  let transport: ReturnType<typeof nodemailer.createTransport> | null = null,
    started = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const config = requireMail(scope, "smtp"),
      draft = await transaction(scope.actorId, scope.workspaceId, async (db) => {
        await enforceOperation(db, scope, "agent");
        await assertCommunicationDelivery(db, scope, job.recipient, job.requirement_id);
        return mailDraft(
          db,
          scope,
          job.lead_draft_id ?? job.draft_id,
          job.lead_draft_id ? "lead" : "execution",
        );
      });
    if (
      draft?.status !== "Reviewed" ||
      draft.stale ||
      draft.contextHash !== job.context_hash ||
      config.smtp.sender !== job.sender
    )
      throw new HttpError(
        422,
        "The approved message context or sender changed before submission. No message was sent.",
      );
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 465),
      secure: Number(process.env.SMTP_PORT ?? 465) === 465,
      requireTLS: true,
      auth: process.env.SMTP_ACCESS_TOKEN
        ? {
            type: "OAuth2",
            user: process.env.SMTP_USER,
            accessToken: process.env.SMTP_ACCESS_TOKEN,
          }
        : { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
      tls: { rejectUnauthorized: true },
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
      logger: false,
      debug: false,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    const smtp = transport;
    started = true;
    const receipt = await Promise.race([
      smtp.sendMail({
        from: job.sender,
        to: job.recipient,
        subject: job.subject,
        text: job.body,
        messageId: job.message_id,
        disableFileAccess: true,
        disableUrlAccess: true,
      }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          smtp.close();
          reject(new Error("SMTP submission timed out with an unknown outcome."));
        }, 60000);
      }),
    ]);
    const accepted = (receipt.accepted ?? []).map((address: string | { address: string }) =>
      typeof address === "string" ? address : address.address,
    );
    if (!accepted.some((address: string) => address.toLowerCase() === job.recipient.toLowerCase()))
      throw new Error("The server did not report acceptance for the approved recipient.");
    await transaction(scope.actorId, scope.workspaceId, async (db) => {
      const saved = await db.query(
        "update aerion.mail_deliveries set status='accepted',server_response=$1,finished_at=now(),revision=revision+1 where id=$2 and workspace_id=$3 and status='sending' returning id",
        [
          String(receipt.response ?? "SMTP server accepted this message").slice(0, 1000),
          job.id,
          scope.workspaceId,
        ],
      );
      await audit(
        db,
        scope,
        saved.rowCount ? "mail.server-accepted" : "mail.late-server-receipt",
        job.id,
        {
          messageId: job.message_id,
          recipient: job.recipient,
        },
      );
    });
  } catch (error) {
    const command =
      error && typeof error === "object" && "command" in error ? String(error.command) : "";
    const responseCode =
      error && typeof error === "object" && "responseCode" in error
        ? Number(error.responseCode)
        : 0;
    const definitelyUnsent =
      !started ||
      ["CONN", "AUTH", "EHLO", "HELO", "STARTTLS", "MAIL FROM", "RCPT TO"].includes(command) ||
      (responseCode >= 400 && responseCode <= 599);
    const status = definitelyUnsent ? "failed" : "unknown",
      message =
        error instanceof HttpError
          ? error.message
          : status === "failed"
            ? "The SMTP connection, authentication or submission was rejected. No automatic retry was made. Check configuration and review before retrying."
            : "The server acceptance outcome is unknown. Check Sent/server logs and reconcile the outcome before any retry.";
    await transaction(scope.actorId, scope.workspaceId, async (db) => {
      await db.query(
        "update aerion.mail_deliveries set status=$1,error=$2,finished_at=now(),revision=revision+1 where id=$3 and workspace_id=$4 and status='sending'",
        [status, message, job.id, scope.workspaceId],
      );
      await audit(db, scope, `mail.${status}`, job.id, { draftId: job.draft_id });
    });
  } finally {
    if (timer) clearTimeout(timer);
    transport?.close();
  }
  return true;
}
