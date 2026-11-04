import { z } from "zod";
import { agentProviderSchema, type AgentProvider } from "../agents/schema";
export const communicationStates = [
  "Unassigned",
  "Suggested",
  "Ambiguous",
  "Linked",
  "Dismissed",
] as const;
const note = z.string().trim().min(20).max(2000);
export const communicationActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("link"),
    revision: z.number().int().nonnegative(),
    leadId: z.uuid(),
    note,
    attested: z.literal(true),
  }),
  z.object({
    kind: z.literal("correct-link"),
    revision: z.number().int().nonnegative(),
    leadId: z.uuid(),
    note,
    attested: z.literal(true),
  }),
  z.object({ kind: z.literal("dismiss"), revision: z.number().int().nonnegative(), note }),
  z.object({ kind: z.literal("reopen"), revision: z.number().int().nonnegative(), note }),
  z.object({
    kind: z.literal("analyze"),
    revision: z.number().int().nonnegative(),
    provider: agentProviderSchema,
    allowModelData: z.boolean(),
    idempotencyKey: z.uuid(),
  }),
  z.object({
    kind: z.literal("clarify"),
    revision: z.number().int().nonnegative(),
    note,
    attested: z.literal(true),
  }),
  z.object({
    kind: z.literal("use-revision"),
    revision: z.number().int().nonnegative(),
    leadRevision: z.number().int().nonnegative(),
    runId: z.uuid(),
    proposalId: z.uuid(),
    note,
    attested: z.literal(true),
  }),
  z.object({
    kind: z.literal("suppress"),
    revision: z.number().int().nonnegative(),
    email: z.email().max(254),
    reason: z.enum(["Do not contact", "Delivery failure", "Founder decision"]),
    note,
    attested: z.literal(true),
  }),
]);
export const suppressionDecisionSchema = z.object({
  email: z.email().max(254),
  revision: z.number().int().nonnegative(),
  active: z.boolean(),
  note,
  attested: z.literal(true),
});
export type CommunicationMessage = {
  id: string;
  sourceId: string;
  messageId: string | null;
  sender: string;
  recipients: string[];
  subject: string;
  inReplyTo: string[];
  references: string[];
  direction: "Inbound" | "Outbound" | "Unknown";
  classification: "Message" | "Auto reply" | "Delivery report";
  suggestedLeadIds: string[];
  matchedDeliveryIds: string[];
  routingBasis: string;
  state: (typeof communicationStates)[number];
  leadId: string | null;
  revision: number;
  reviewNote: string;
  createdAt: string;
  updatedAt: string;
};
export type CommunicationLead = {
  id: string;
  organization: string | null;
  aircraftModel: string | null;
  side: "Buyer" | "Seller";
  status: string;
};
export type CommunicationDetail = CommunicationMessage & {
  text: string;
  title: string;
  attachments: { id: string; title: string; filename: string; contentType: string }[];
  lead: CommunicationLead | null;
  leadRevision: number | null;
  currentRequirementId: string | null;
  analysisRuns: {
    id: string;
    agentId: string;
    status: string;
    createdAt: string;
    kind: string;
    priorRequirementId: string | null;
    leadId: string;
    proposals: {
      id: string;
      title: string;
      status: string;
      appliedRef: string | null;
      type: string;
    }[];
  }[];
  revisions: {
    id: string;
    priorRequirementId: string;
    requirementId: string;
    reviewNote: string;
    createdAt: string;
  }[];
  assignmentCorrections: {
    id: string;
    priorLeadId: string;
    leadId: string;
    priorRequirementId: string | null;
    priorOrganization: string | null;
    organization: string | null;
    reviewNote: string;
    createdAt: string;
  }[];
};
export type CommunicationInboxData = {
  messages: CommunicationMessage[];
  leads: CommunicationLead[];
  counts: Record<(typeof communicationStates)[number], number>;
  providers: { id: AgentProvider; ready: boolean; model: string | null }[];
  mailbox: { ready: boolean; account: string | null; folder: string | null };
  suppressions: {
    email: string;
    reason: string;
    sourceId: string;
    active: boolean;
    revision: number;
    reviewNote: string;
    updatedAt: string;
  }[];
};
