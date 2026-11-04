import { randomUUID, createHash } from "node:crypto";
import { ImapFlow } from "imapflow";
import { transaction, audit, type Scope } from "../db";
import { createSource } from "../repository";
import { documentPages } from "../documents";
import { HttpError } from "../http";
import { requireMail } from "./mail-config";
import { parseEmail } from "./email-parser";
import { registerRetainedEmail } from "../communication/service";
export async function collectMailbox(scope: Scope, signal: AbortSignal) {
  const configuration = requireMail(scope, "mailbox"),
    token = randomUUID(),
    folder = configuration.mailbox.folder ?? "";
  const accountKey = createHash("sha256")
    .update(`${process.env.IMAP_HOST}|${process.env.IMAP_USER}|${folder}`)
    .digest("hex");
  const cursor = await transaction(scope.actorId, scope.workspaceId, async (db) => {
    await db.query(
      "insert into aerion.mailbox_cursors(workspace_id,account_key,uid_validity) values($1,$2,'') on conflict do nothing",
      [scope.workspaceId, accountKey],
    );
    const result = await db.query(
      "select * from aerion.mailbox_cursors where workspace_id=$1 and account_key=$2 for update",
      [scope.workspaceId, accountKey],
    );
    if (
      result.rows[0].lease_token &&
      new Date(result.rows[0].leased_at).getTime() > Date.now() - 300000
    )
      throw new HttpError(409, "Another run is collecting this mailbox folder.");
    await db.query(
      "update aerion.mailbox_cursors set lease_token=$1,leased_at=now() where workspace_id=$2 and account_key=$3",
      [token, scope.workspaceId, accountKey],
    );
    return result.rows[0];
  });
  const client = new ImapFlow({
    host: process.env.IMAP_HOST ?? "",
    port: Number(process.env.IMAP_PORT ?? 993),
    secure: true,
    auth: {
      user: process.env.IMAP_USER ?? "",
      ...(process.env.IMAP_ACCESS_TOKEN
        ? { accessToken: process.env.IMAP_ACCESS_TOKEN }
        : { pass: process.env.IMAP_PASSWORD ?? "" }),
    },
    logger: false,
    disableAutoIdle: true,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
    maxLiteralSize: 2100000,
    tls: { rejectUnauthorized: true },
  });
  const abort = () => client.close();
  signal.addEventListener("abort", abort, { once: true });
  const retained: { sourceId: string; subject: string; attachmentIds: string[] }[] = [],
    issues: string[] = [];
  let validity = cursor.uid_validity,
    lastUid = Number(cursor.last_uid);
  try {
    signal.throwIfAborted();
    await client.connect();
    const lock = await client.getMailboxLock(folder, { readOnly: true, acquireTimeout: 10000 });
    try {
      if (!client.mailbox) throw new Error("The configured mailbox folder could not be selected.");
      validity = String(client.mailbox.uidValidity);
      const start = validity === cursor.uid_validity ? lastUid : 0;
      if (validity !== cursor.uid_validity) lastUid = 0;
      const found = await client.search(
        start ? { uid: `${start + 1}:*` } : { since: new Date(Date.now() - 30 * 86400000) },
        { uid: true },
      );
      const uids = (Array.isArray(found) ? found : [])
        .filter((uid) => uid > start)
        .sort((a, b) => a - b)
        .slice(0, 5);
      if (uids.length)
        for await (const message of client.fetch(
          uids,
          { uid: true, source: { start: 0, maxLength: 2000001 }, size: true },
          { uid: true },
        )) {
          signal.throwIfAborted();
          const uid = message.uid;
          if (
            !message.source ||
            (message.size ?? message.source.length) > 2000000 ||
            message.source.length > 2000000
          ) {
            issues.push(`UID ${uid}: message exceeds 2 MB or source bytes are unavailable.`);
            lastUid = Math.max(lastUid, uid);
            continue;
          }
          try {
            const parsed = await parseEmail(message.source, process.env.IMAP_USER),
              source = await retainMessage(
                scope,
                message.source,
                parsed.subject,
                parsed.text,
                `message-${uid}.eml`,
              ),
              attachmentIds: string[] = [];
            for (const attachment of parsed.email.attachments.slice(0, 4)) {
              const filename = (attachment.filename ?? "").replace(/[\\/]/g, "_").slice(0, 180);
              if (!/\.(pdf|csv|txt)$/i.test(filename)) {
                issues.push(
                  `UID ${uid}: ${filename || attachment.mimeType} remains in the original email; this attachment type was not extracted.`,
                );
                continue;
              }
              const original =
                typeof attachment.content === "string"
                  ? Buffer.from(
                      attachment.content,
                      attachment.encoding === "base64" ? "base64" : "utf8",
                    )
                  : attachment.content instanceof Uint8Array
                    ? Buffer.from(attachment.content)
                    : Buffer.from(attachment.content);
              if (original.length > 2000000) {
                issues.push(`UID ${uid}: attachment ${filename} exceeds 2 MB.`);
                continue;
              }
              const kind = filename.toLowerCase().endsWith(".pdf")
                ? "pdf"
                : filename.toLowerCase().endsWith(".csv")
                  ? "csv"
                  : "text";
              try {
                const pages = await documentPages(original, kind);
                const id = await createSource(scope, {
                  title: `${parsed.subject} · ${filename}`.slice(0, 300),
                  kind,
                  sourceUrl: null,
                  filename,
                  contentType: attachment.mimeType,
                  original,
                  pages,
                });
                attachmentIds.push(id.id);
                await transaction(scope.actorId, scope.workspaceId, (db) =>
                  db.query(
                    "insert into aerion.source_links(workspace_id,parent_id,child_id,relation) values($1,$2,$3,'attachment') on conflict do nothing",
                    [scope.workspaceId, source.id, id.id],
                  ),
                );
              } catch (error) {
                if (!(error instanceof HttpError && error.status === 409))
                  issues.push(
                    `UID ${uid}: attachment ${filename} needs a separate source review or readable transcription.`,
                  );
              }
            }
            await registerRetainedEmail(scope, source.id, parsed);
            retained.push({ sourceId: source.id, subject: parsed.subject, attachmentIds });
            lastUid = Math.max(lastUid, uid);
          } catch (error) {
            if (error instanceof HttpError && [413, 422].includes(error.status)) {
              issues.push(`UID ${uid}: ${error.message} The message remains in the mailbox.`);
              lastUid = Math.max(lastUid, uid);
            } else throw error;
          }
        }
    } finally {
      lock.release();
    }
    await transaction(scope.actorId, scope.workspaceId, async (db) => {
      await db.query(
        "update aerion.mailbox_cursors set uid_validity=$1,last_uid=$2,lease_token=null,leased_at=null,updated_at=now() where workspace_id=$3 and account_key=$4 and lease_token=$5",
        [validity, lastUid, scope.workspaceId, accountKey, token],
      );
      await audit(db, scope, "agent.mailbox-collected", null, {
        folder,
        messages: retained.length,
        issues,
      });
    });
    return { messages: retained, issues, readOnly: true, limit: 5, initialLookbackDays: 30 };
  } finally {
    signal.removeEventListener("abort", abort);
    try {
      await client.logout();
    } catch {
      client.close();
    }
    await transaction(scope.actorId, scope.workspaceId, (db) =>
      db.query(
        "update aerion.mailbox_cursors set lease_token=null,leased_at=null where workspace_id=$1 and account_key=$2 and lease_token=$3",
        [scope.workspaceId, accountKey, token],
      ),
    );
  }
}
async function retainMessage(
  scope: Scope,
  original: Buffer,
  title: string,
  text: string,
  filename: string,
) {
  try {
    return await createSource(scope, {
      title,
      kind: "text",
      sourceUrl: null,
      filename,
      contentType: "message/rfc822",
      original,
      pages: [{ page: 1, text }],
    });
  } catch (error) {
    if (!(error instanceof HttpError && error.status === 409)) throw error;
    const hash = createHash("sha256").update(original).digest("hex"),
      result = await transaction(scope.actorId, scope.workspaceId, (db) =>
        db.query("select id from aerion.sources where workspace_id=$1 and sha256=$2", [
          scope.workspaceId,
          hash,
        ]),
      );
    if (!result.rows[0]) throw error;
    return { id: result.rows[0].id as string };
  }
}
