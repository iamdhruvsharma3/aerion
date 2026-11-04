import { z } from "zod";
export const deliveryRequestSchema = z.object({
  draftId: z.uuid(),
  kind: z.enum(["execution", "lead"]).optional(),
  idempotencyKey: z.uuid(),
  attested: z.literal(true),
  note: z.string().trim().min(20).max(2000),
});
export const deliveryDecisionSchema = z.object({
  revision: z.number().int().nonnegative(),
  operation: z.enum(["cancel", "retry", "confirm-accepted", "confirm-not-sent"]),
  attested: z.literal(true),
  note: z.string().trim().min(20).max(2000),
});
export type MailDelivery = {
  id: string;
  draftId: string;
  requirementId: string | null;
  recipient: string;
  sender: string;
  subject: string;
  body: string;
  status: "queued" | "sending" | "accepted" | "failed" | "unknown" | "cancelled";
  attempts: number;
  revision: number;
  messageId: string;
  error: string | null;
  serverResponse: string | null;
  createdAt: string;
  finishedAt: string | null;
};
export type MailStatus = {
  configuration: {
    mailbox: { ready: boolean; account: string | null; folder: string | null };
    smtp: { ready: boolean; sender: string | null };
    detail: string;
  };
  deliveries: MailDelivery[];
};
