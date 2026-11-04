import { z } from "zod";

export const operationSettingsSchema = z.object({
  paused: z.boolean(),
  maxModelJobs: z.number().int().min(1).max(500),
  maxAgentTokens: z.number().int().min(1000).max(100000000),
  maxSearches: z.number().int().min(1).max(1000),
  maxMail: z.number().int().min(1).max(500),
});
export const defaultOperationSettings = {
  paused: false,
  maxModelJobs: 25,
  maxAgentTokens: 1000000,
  maxSearches: 50,
  maxMail: 25,
};
export type OperationSettings = z.infer<typeof operationSettingsSchema>;
export const operationUpdateSchema = z.object({
  revision: z.number().int().nonnegative(),
  settings: operationSettingsSchema,
  note: z.string().trim().min(10).max(1000),
});
export type Operations = {
  checkedAt: string;
  settings: OperationSettings;
  revision: number;
  usage: { modelJobs: number; agentTokens: number; searches: number; mail: number; day: string };
  worker: { ready: boolean; lastSeen: string | null; active: number };
  configuration: { local: boolean; nvidia: boolean; brave: boolean; smtp: boolean; imap: boolean };
  jobs: {
    queuedAgents: number;
    runningAgents: number;
    failedAgents: number;
    queuedExtractions: number;
    failedExtractions: number;
    uncertainMail: number;
  };
  backup: {
    createdAt: string;
    verifiedAt: string | null;
    bytes: number;
    sha256: string;
    verification: Record<string, unknown>;
  } | null;
  validations: {
    agentId: string;
    name: string;
    status: "passed" | "failed" | "observed" | "pending";
    origin: string | null;
    model: string | null;
    checkedAt: string | null;
    sourceRunId: string | null;
    summary: string | null;
    acceptanceProfile: string | null;
    proofKind: "same-workspace" | "published-fixture" | null;
    reportHash: string | null;
    counts: {
      toolCalls: number;
      proposals: number;
      accepted: number;
      reportDiagnostics?: number;
    } | null;
    observed: { sourceRunId: string; model: string | null; finishedAt: string | null } | null;
    history: {
      status: "passed" | "failed";
      verified: boolean;
      origin: string;
      checkedAt: string;
      sourceRunId: string;
      reportHash: string;
    }[];
  }[];
  stale: { aircraft: number; leadsWithoutAction: number };
  alerts: {
    key: string;
    title: string;
    detail: string;
    href: string;
    severity: "attention" | "setup";
  }[];
};
