import { z } from "zod";

const date = z.iso.date();
const text = z.string().trim().min(1).max(300);
// Omitted commercial fields preserve the original workspace's USD sale semantics.
// New intake records an explicit kind; unknown terms remain questions for review.
export const sourcingKindSchema = z.enum(["Sale", "Lease", "Not supplied"]);
export const offeringSchema = z.enum(["Sale", "Lease", "Sale or lease", "Not supplied"]);
export const leaseBasisSchema = z.enum(["Monthly rent", "Hourly rate"]);
const sourcingCurrency = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .nullable()
  .optional();
const evidenceSchema = z.object({ sourceId: z.uuid(), extractionId: z.uuid(), reviewId: z.uuid() });
const intelligenceEvidenceSchema = z.object({
  sourceId: z.uuid(),
  extractionId: z.uuid(),
  signalId: z.uuid(),
});
export const aircraftSchema = z.object({
  id: text,
  manufacturer: text,
  model: text,
  serial: text,
  registration: text,
  category: z.enum(["Commercial", "Business"]),
  year: z.number().int().min(1950).max(2100),
  engine: text,
  hours: z.number().nonnegative().nullable(),
  cycles: z.number().int().nonnegative().nullable(),
  price: z.number().positive().nullable(),
  offering: offeringSchema.optional(),
  leaseRate: z.number().positive().nullable().optional(),
  leaseCurrency: sourcingCurrency,
  leaseBasis: leaseBasisSchema.nullable().optional(),
  location: text,
  country: text,
  availableDate: date.nullable(),
  availability: z.enum(["Reported", "Confirmed", "Stale"]),
  source: text,
  sourceDate: date,
  notes: z.string().max(5000),
  evidence: evidenceSchema.optional(),
});
export const requirementSchema = z.object({
  id: text,
  client: text,
  aircraftModel: text,
  category: z.enum(["Commercial", "Business"]),
  quantity: z.number().int().min(1).max(50),
  minYear: z.number().int().min(1950).max(2100),
  engine: z.string().max(200),
  budget: z.number().positive().nullable(),
  transactionKind: sourcingKindSchema.optional(),
  leaseBudget: z.number().positive().nullable().optional(),
  leaseCurrency: sourcingCurrency,
  leaseBasis: leaseBasisSchema.nullable().optional(),
  deadline: date.nullable(),
  destination: text,
  status: z.enum(["Draft", "Confirmed", "Sourcing"]),
  description: z.string().max(5000),
  intelligence: intelligenceEvidenceSchema.optional(),
});
export const contactSchema = z.object({
  id: text,
  name: text,
  role: text,
  company: text,
  email: z.email(),
  location: text,
  type: z.enum(["Buyer", "Seller", "Broker", "Specialist"]),
  notes: z.string().max(5000),
});
export const dealStages = ["Sourcing", "Evaluation", "Due diligence", "Closing"] as const;
export const dealSchema = z.object({
  id: text,
  title: text,
  aircraftId: text,
  requirementId: text,
  stage: z.enum(dealStages),
  nextAction: text,
  dueDate: date,
  evidence: evidenceSchema.optional(),
  requirementEvidence: intelligenceEvidenceSchema.optional(),
});
export const taskSchema = z.object({
  id: text,
  title: text,
  detail: text,
  priority: z.enum(["High", "Medium", "Low"]),
  done: z.boolean(),
  aircraftId: z.string().optional(),
});
export const workspaceSchema = z.object({
  version: z.literal(1),
  aircraft: z.array(aircraftSchema).max(2000),
  requirements: z.array(requirementSchema).max(1000),
  contacts: z.array(contactSchema).max(1000),
  deals: z.array(dealSchema).max(1000),
  tasks: z.array(taskSchema).max(1000),
  saved: z.array(z.string()).max(2000),
});
export type Aircraft = z.infer<typeof aircraftSchema>;
export type Requirement = z.infer<typeof requirementSchema>;
export type Contact = z.infer<typeof contactSchema>;
export type Deal = z.infer<typeof dealSchema>;
export type Workspace = z.infer<typeof workspaceSchema>;
