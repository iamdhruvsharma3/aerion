import { z } from "zod";
import { contactSchema, requirementSchema, type Contact, type Requirement } from "../schema";
import { confirmationSchema } from "../intelligence/market-schema";
import type { AgentRun, Citation } from "../agents/schema";
import type { DiscoveryLead } from "../discovery/schema";
import type { ExecutionContext } from "../execution/schema";

export const enrichmentValuesSchema = z.object({
  organization: z.string().trim().min(2).max(200),
  contactName: z.string().trim().min(2).max(160).nullable(),
  email: z.email().max(254).nullable(),
  phone: z.string().trim().min(6).max(80).nullable(),
  geography: z.string().trim().min(2).max(160).nullable(),
  summary: z.string().trim().min(10).max(1500),
});
export const enrichmentActionSchema = z.object({
  type: z.literal("lead-enrichment"),
  leadId: z.uuid(),
  resultId: z.uuid(),
  sourceId: z.uuid(),
  values: enrichmentValuesSchema,
});
const note = z.string().trim().min(20).max(2000);
export const leadCaseActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("update"),
    status: z.enum(["Research", "Qualifying", "Dismissed"]),
    nextAction: z.string().trim().max(500),
    dueOn: z.iso.date().nullable(),
  }),
  z.object({
    kind: z.literal("create-contact"),
    values: contactSchema.omit({ id: true }),
    note,
    attested: z.literal(true),
  }),
  z.object({ kind: z.literal("link-contact"), contactId: z.string().min(1).max(300), note }),
  z.object({
    kind: z.literal("create-requirement"),
    values: requirementSchema.omit({ id: true, intelligence: true, status: true }),
    note,
    attested: z.literal(true),
  }),
  z.object({
    kind: z.literal("link-requirement"),
    requirementId: z.string().min(1).max(300),
    note,
  }),
  z.object({
    kind: z.literal("confirm"),
    confirmation: confirmationSchema,
    note,
    attested: z.literal(true),
  }),
  z.object({
    kind: z.literal("attach-source"),
    sourceId: z.uuid(),
    purpose: z.enum(["Buyer brief", "Other"]),
    note,
  }),
  z.object({
    kind: z.literal("prepare-draft"),
    subject: z.string().trim().min(3).max(300).optional(),
    body: z.string().trim().min(20).max(12000).optional(),
  }),
  z.object({
    kind: z.literal("review-draft"),
    draftId: z.uuid(),
    status: z.enum(["Reviewed", "Archived"]),
    note,
    attested: z.literal(true),
  }),
  z.object({
    kind: z.literal("opportunity"),
    aircraftId: z.string().min(1).max(300),
    dueOn: z.iso.date(),
    note,
    attested: z.literal(true),
  }),
]);
export type LeadCaseAction = z.infer<typeof leadCaseActionSchema>;
export type LeadDraft = {
  id: string;
  leadId: string;
  contactId: string;
  recipient: string;
  subject: string;
  body: string;
  contextHash: string;
  status: "Prepared" | "Reviewed" | "Archived";
  stale: boolean;
  reviewNote: string;
  createdAt: string;
  reviewedAt: string | null;
};
export type LeadCase = {
  lead: DiscoveryLead;
  revision: number;
  status: "Research" | "Qualifying" | "Dismissed";
  nextAction: string;
  dueOn: string | null;
  contact: Contact | null;
  requirement: Requirement | null;
  desk: ExecutionContext | null;
  sources: {
    id: string;
    title: string;
    purpose: string;
    retired?: boolean;
    sourceUrl: string | null;
    createdAt: string;
  }[];
  availableSources: { id: string; title: string }[];
  enrichments: {
    id: string;
    sourceId: string;
    values: z.infer<typeof enrichmentValuesSchema>;
    citations: Citation[];
    createdAt: string;
  }[];
  drafts: LeadDraft[];
  runs: AgentRun[];
  activity: { id: string; action: string; detail: Record<string, unknown>; createdAt: string }[];
  readiness: { key: string; title: string; ready: boolean; detail: string }[];
};
