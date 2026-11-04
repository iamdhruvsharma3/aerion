import { z } from "zod";
import { agentProviderIds } from "./providers";
import { agentIds } from "./catalog";
import { contactSchema, requirementSchema } from "../schema";
import { executionActionSchema } from "../execution/schema";
import { discoveryInputSchema, leadValuesSchema } from "../discovery/schema";
import { enrichmentActionSchema } from "../leads/schema";
export const agentProviderSchema = z.enum(agentProviderIds);
export type AgentProvider = z.infer<typeof agentProviderSchema>;
export type ModelProvider = Exclude<AgentProvider, "rules">;
const id = z.string().min(1).max(300);
export const runInputSchema = z.object({
  agentId: z.enum(agentIds),
  provider: agentProviderSchema,
  requirementId: id.nullable(),
  aircraftId: id.nullable(),
  contactId: id.nullable(),
  sourceIds: z.array(z.uuid()).max(20),
  connectorIds: z.array(z.uuid()).max(10),
  objective: z.string().trim().max(2000),
  allowExternalSources: z.boolean(),
  allowModelData: z.boolean(),
  allowMailbox: z.boolean().default(false),
  discovery: discoveryInputSchema.optional(),
  leadId: z.uuid().optional(),
  idempotencyKey: z.uuid(),
});
export type RunInput = z.infer<typeof runInputSchema>;
export const citationSchema = z.object({
  sourceId: z.uuid(),
  page: z.number().int().min(1).max(40),
  quote: z.string().min(1).max(1500),
});
export type Citation = z.infer<typeof citationSchema>;
export const findingSchema = z.object({
  title: z.string().min(1).max(300),
  detail: z.string().min(1).max(4000),
  severity: z.enum(["info", "review", "missing"]),
  citations: z.array(citationSchema).max(12),
});
export const reportSchema = z.object({
  summary: z.string().min(1).max(4000),
  findings: z.array(findingSchema).max(60),
  limitations: z.array(z.string().min(1).max(1000)).max(30),
});
export type AgentReport = z.infer<typeof reportSchema>;
const allowedExecution = z.discriminatedUnion("type", [
  executionActionSchema.options[0],
  executionActionSchema.options[1],
  executionActionSchema.options[3],
  executionActionSchema.options[5],
]);
export const leadActionSchema = z.object({
  type: z.literal("lead"),
  resultId: z.uuid(),
  sourceId: z.uuid(),
  values: leadValuesSchema,
});
export const requirementActionSchema = z.object({
  type: z.literal("requirement"),
  leadId: z.uuid().nullable().optional(),
  values: requirementSchema.omit({ id: true, intelligence: true, status: true }),
});
export const proposalActionSchema = z.discriminatedUnion("type", [
  leadActionSchema,
  enrichmentActionSchema,
  z.object({ type: z.literal("execution"), requirementId: id, action: allowedExecution }),
  requirementActionSchema,
  z.object({ type: z.literal("contact"), values: contactSchema.omit({ id: true }) }),
  z.object({
    type: z.literal("deal"),
    requirementId: id,
    aircraftId: id,
    nextAction: z.string().min(5).max(300),
    dueDate: z.iso.date(),
  }),
  z.object({
    type: z.literal("interaction"),
    contactId: id,
    requirementId: id.nullable(),
    sourceId: z.uuid(),
    occurredOn: z.iso.date(),
    direction: z.enum(["Inbound", "Outbound"]),
    summary: z.string().min(5).max(2000),
  }),
  z.object({
    type: z.literal("comparable"),
    sourceId: z.uuid(),
    manufacturer: id,
    model: id,
    year: z.number().int().min(1950).max(2100),
    amountUsd: z.number().positive(),
    basis: z.enum(["Asking price", "Sold price", "Monthly lease"]),
    reportedOn: z.iso.date(),
    notes: z.string().max(2000),
  }),
]);
export type ProposalAction = z.infer<typeof proposalActionSchema>;
export const proposalSchema = z.object({
  title: z.string().min(5).max(300),
  reason: z.string().min(5).max(2000),
  action: proposalActionSchema,
  citations: z.array(citationSchema).max(20),
});
export type AgentProposal = z.infer<typeof proposalSchema>;
export const connectorSchema = z.object({
  name: z.string().trim().min(1).max(200),
  url: z.url().max(2000),
  format: z.enum(["page", "feed", "json", "text"]),
  purpose: z.enum(["aircraft", "market"]),
  enabled: z.boolean(),
});
export type SourceConnector = z.infer<typeof connectorSchema> & {
  id: string;
  lastCollectedAt: string | null;
};
export type AgentSchedule = {
  agentId: (typeof agentIds)[number];
  enabled: boolean;
  provider: AgentProvider;
  intervalHours: number;
  nextRunAt: string | null;
  input: Omit<RunInput, "agentId" | "provider" | "idempotencyKey">;
};
export const scheduleSchema = z.object({
  agentId: z.enum(agentIds),
  enabled: z.boolean(),
  provider: agentProviderSchema,
  intervalHours: z.number().int().min(1).max(168),
  input: runInputSchema.omit({ agentId: true, provider: true, idempotencyKey: true }),
});
export type AgentRun = {
  id: string;
  agentId: (typeof agentIds)[number];
  provider: AgentProvider;
  model: string | null;
  status: "queued" | "running" | "review" | "completed" | "needs-input" | "failed" | "cancelled";
  attempts: number;
  input: RunInput;
  report: AgentReport | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  revision: number;
  usage: { inputTokens: number; outputTokens: number; requests: number } | null;
};
export type ProposalRecord = AgentProposal & {
  id: string;
  runId: string;
  status: "proposed" | "accepted" | "rejected" | "obsolete";
  resolutionNote: string;
  appliedRef: string | null;
};
export type AgentRunDetail = AgentRun & {
  steps: { id: string; tool: string; input: unknown; output: unknown; createdAt: string }[];
  proposals: ProposalRecord[];
};
export type AgentCenter = {
  connections: import("./mail-schema").MailStatus["configuration"];
  runs: AgentRun[];
  totalRuns: number;
  counts: Record<string, number>;
  connectors: SourceConnector[];
  schedules: AgentSchedule[];
  providers: { id: AgentProvider; ready: boolean; model: string | null; detail: string }[];
};
