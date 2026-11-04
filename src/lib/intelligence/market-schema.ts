import { z } from "zod";
import { requirementSchema } from "../schema";
import type { SourceRecord } from "./schema";

const text = z.string().trim().min(1).max(300);
export const signalValuesSchema = z.object({
  organization: text.optional(),
  aircraftFamily: text.optional(),
  intent: z.enum(["Demand", "Supply", "Fleet activity"]).optional(),
  market: z.enum(["Commercial", "Business"]).optional(),
  geography: text.optional(),
  eventDate: z.iso.date().optional(),
  quantity: z.number().int().min(1).max(10000).optional(),
});
export const signalFields = [
  "organization",
  "aircraftFamily",
  "intent",
  "market",
  "geography",
  "eventDate",
  "quantity",
] as const;
export type SignalField = (typeof signalFields)[number];
export type SignalValues = z.infer<typeof signalValuesSchema>;
export const signalLabels: Record<SignalField, string> = {
  organization: "Organization",
  aircraftFamily: "Aircraft family",
  intent: "Signal type",
  market: "Market",
  geography: "Geography",
  eventDate: "Event date",
  quantity: "Quantity",
};
export const signalFactSchema = z.object({
  field: z.enum(signalFields),
  value: z.union([text, z.number()]),
  quote: z.string().min(1).max(1500),
  page: z.number().int().min(1).max(40),
  method: z.enum(["label", "headline", "model"]),
});
export type SignalFact = z.infer<typeof signalFactSchema>;
export const marketOutputSchema = z.object({
  signals: z.array(z.object({ facts: z.array(signalFactSchema).min(1).max(50) })).max(100),
});
export type MarketOutput = z.infer<typeof marketOutputSchema>;
export const signalStages = [
  "Signal",
  "Lead",
  "Potential requirement",
  "Confirmed requirement",
  "Dismissed",
] as const;
export type SignalStage = (typeof signalStages)[number];
export const confirmationSchema = z.object({
  contact: text,
  confirmedOn: z.iso.date(),
  basis: z.string().trim().min(20).max(2000),
});
export type SignalRecord = {
  id: string;
  sourceId: string;
  extractionId: string;
  sourceTitle: string;
  capturedAt: string;
  sourceUrl: string | null;
  facts: SignalFact[];
  proposed: SignalValues;
  values: SignalValues;
  warnings: string[];
  confidence: "Stated" | "Incomplete" | "Conflicting";
  stage: SignalStage;
  revision: number;
  note: string;
  reviewer: string | null;
  reviewedAt: string | null;
  createdAt: string;
  requirementId: string | null;
  confirmation: z.infer<typeof confirmationSchema> | null;
};
export type Intelligence = {
  signals: SignalRecord[];
  total: number;
  page: number;
  pages: number;
  counts: Record<SignalStage, number>;
  sources: SourceRecord[];
  facets: { organizations: string[]; families: string[]; geographies: string[] };
};
export const signalDecisionSchema = z.object({
  action: z.enum(["lead", "potential", "confirm", "dismiss"]),
  revision: z.number().int().nonnegative(),
  values: signalValuesSchema,
  note: z.string().trim().min(5).max(2000),
  attested: z.boolean(),
  requirement: requirementSchema.omit({ id: true, intelligence: true }).optional(),
  confirmation: confirmationSchema.optional(),
});
export type SignalDecision = z.infer<typeof signalDecisionSchema>;
export const sampleMarketSource = `Organization: Example Meridian Aviation\nAircraft family: Airbus A319\nSignal type: Demand\nMarket: Commercial\nGeography: India\nEvent date: 2026-10-20\nQuantity: 1\n\nFictional training brief. No actual buyer, mandate, or demand is represented.\n---\nOrganization: Example Summit Air\nAircraft family: Challenger 3500\nSignal type: Fleet activity\nMarket: Business\nGeography: Europe\nEvent date: 2026-09-10\nQuantity: 2\n\nFictional fleet announcement. An announced order is not an open buying requirement.`;
