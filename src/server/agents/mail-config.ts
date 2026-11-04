import { z } from "zod";
import type { Scope } from "../db";
import { HttpError } from "../http";
const localActor = "00000000-0000-4000-8000-000000000001";
export function mailOwner(scope: Scope) {
  const configured =
    process.env.AERION_MAIL_OWNER_ID ||
    (process.env.AERION_LOCAL_AUTH === "true" ? localActor : null);
  return configured === scope.actorId;
}
export function mailConfiguration(scope: Scope) {
  const owner = mailOwner(scope);
  return {
    mailbox: {
      ready:
        owner &&
        Boolean(
          process.env.IMAP_HOST &&
            process.env.IMAP_USER &&
            (process.env.IMAP_PASSWORD || process.env.IMAP_ACCESS_TOKEN) &&
            process.env.IMAP_FOLDER,
        ),
      account: owner ? (process.env.IMAP_USER ?? null) : null,
      folder: owner ? (process.env.IMAP_FOLDER ?? null) : null,
    },
    smtp: {
      ready:
        owner &&
        Boolean(
          process.env.SMTP_HOST &&
            process.env.SMTP_USER &&
            (process.env.SMTP_PASSWORD || process.env.SMTP_ACCESS_TOKEN) &&
            z.email().safeParse(process.env.SMTP_FROM).success,
        ),
      sender: owner ? (process.env.SMTP_FROM ?? null) : null,
    },
    detail:
      "Use a dedicated business mailbox/folder. Credentials remain server-only; hosted mail integrations must be bound to AERION_MAIL_OWNER_ID.",
  };
}
export function requireMail(scope: Scope, kind: "mailbox" | "smtp") {
  const config = mailConfiguration(scope);
  if (!config[kind].ready)
    throw new HttpError(
      503,
      kind === "mailbox"
        ? "Mailbox intake is not configured for this founder. Set IMAP_HOST, IMAP_USER, IMAP_FOLDER and an app password or access token."
        : "Email delivery is not configured for this founder. Set SMTP_HOST, SMTP_USER, SMTP_FROM and an app password or access token.",
    );
  return config;
}
