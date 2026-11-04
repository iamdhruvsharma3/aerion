import { z } from "zod";
import type { Aircraft, Contact, Deal, Requirement } from "../schema";
import type { AircraftMatch } from "../matching";
import { confirmationSchema } from "../intelligence/market-schema";

const id = z.string().min(1).max(300);
const note = z.string().trim().min(5).max(2000);
export const readinessDefinitions = [
  { key: "authority", group: "Representation", title: "Seller authority and representation" },
  {
    key: "availability",
    group: "Aircraft",
    title: "Current aircraft specification and availability",
  },
  { key: "records", group: "Records", title: "Maintenance status and technical records" },
  { key: "inspection", group: "Inspection", title: "Inspection scope and findings" },
  { key: "title", group: "Legal", title: "Title and outstanding legal questions" },
  { key: "terms", group: "Commercial", title: "Commercial terms and compensation agreement" },
] as const;
export const readinessKeys = readinessDefinitions.map((d) => d.key) as [
  "authority",
  "availability",
  "records",
  "inspection",
  "title",
  "terms",
];
export const readinessStatuses = ["Missing", "Received", "Reviewed", "Verified"] as const;
export const executionActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("shortlist"),
    aircraftId: id,
    decision: z.enum(["Shortlisted", "Rejected", "Undecided"]),
    reason: note,
  }),
  z.object({ type: z.literal("link-contact"), contactId: id }),
  z.object({
    type: z.literal("confirm-brief"),
    confirmation: confirmationSchema,
    attested: z.literal(true),
  }),
  z.object({
    type: z.literal("prepare-draft"),
    aircraftId: id,
    contactId: id,
    audience: z.enum(["Buyer", "Seller"]),
  }),
  z.object({
    type: z.literal("review-draft"),
    draftId: z.uuid(),
    status: z.enum(["Reviewed", "Archived"]),
    note,
    attested: z.boolean(),
  }),
  z.object({
    type: z.literal("add-action"),
    kind: z.enum(["Follow-up", "Question"]),
    title: z.string().trim().min(1).max(300),
    detail: z.string().trim().max(2000),
    dueDate: z.iso.date().nullable(),
  }),
  z.object({
    type: z.literal("action-status"),
    actionId: z.uuid(),
    status: z.enum(["Open", "Done"]),
  }),
  z.object({ type: z.literal("suggest-actions") }),
  z.object({
    type: z.literal("readiness"),
    key: z.enum(readinessKeys),
    status: z.enum(readinessStatuses),
    sourceId: z.uuid(),
    note,
    verifiedBy: z.string().trim().max(300).optional(),
    verifiedOn: z.iso.date().optional(),
    attested: z.boolean(),
  }),
]);
export type ExecutionAction = z.infer<typeof executionActionSchema>;
export type BriefConfirmation = z.infer<typeof confirmationSchema> & {
  origin: "signal" | "execution";
  href: string;
};
export type Claim = {
  field: string;
  label: string;
  value: string | number;
  attribution:
    | "Source-reported"
    | "Founder-reviewed correction"
    | "Founder-recorded brief"
    | "Founder-recorded contact";
  href: string;
  sourceId: string | null;
  quote: string;
  page: number | null;
};
export type ShortlistDecision = {
  aircraftId: string;
  decision: "Shortlisted" | "Rejected" | "Undecided";
  reason: string;
  updatedAt: string;
};
export type OutreachDraft = {
  id: string;
  aircraftId: string;
  contactId: string;
  audience: "Buyer" | "Seller";
  subject: string;
  body: string;
  claims: Claim[];
  contextHash: string;
  status: "Prepared" | "Reviewed" | "Archived";
  reviewNote: string;
  createdAt: string;
  reviewedAt: string | null;
  stale: boolean;
};
export type CaseAction = {
  id: string;
  kind: "Follow-up" | "Question";
  title: string;
  detail: string;
  dueDate: string | null;
  status: "Open" | "Done";
  seedKey: string | null;
};
export type ReadinessItem = {
  key: (typeof readinessKeys)[number];
  status: (typeof readinessStatuses)[number];
  sourceId: string;
  note: string;
  verifiedBy: string | null;
  verifiedOn: string | null;
  updatedAt: string;
};
export type ExecutionContext = {
  supersededBy?: { requirementId: string; leadId: string } | null;
  requalificationRequired?: boolean;
  revision: number;
  requirement: Requirement;
  confirmation: BriefConfirmation | null;
  matches: AircraftMatch[];
  decisions: ShortlistDecision[];
  drafts: OutreachDraft[];
  actions: CaseAction[];
  readiness: ReadinessItem[];
  contacts: Contact[];
  availableContacts: Contact[];
  deals: Deal[];
  sources: { id: string; title: string; kind: string; createdAt: string }[];
  activity: { id: string; action: string; createdAt: string; detail: Record<string, unknown> }[];
};
export type DraftInput = {
  aircraft: Aircraft;
  requirement: Requirement;
  contact: Contact;
  confirmation: BriefConfirmation;
  claims: Claim[];
  audience: "Buyer" | "Seller";
};
export function dueState(action: CaseAction, today: string) {
  return action.status === "Done"
    ? "Done"
    : !action.dueDate
      ? "No due date"
      : action.dueDate < today
        ? "Overdue"
        : action.dueDate === today
          ? "Due today"
          : "Upcoming";
}

export type ExecutionAttention = {
  total: number;
  items: {
    id: string;
    title: string;
    kind: "Follow-up" | "Question";
    dueDate: string;
    requirementId: string;
    client: string;
  }[];
};
