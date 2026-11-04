import { z } from "zod";
import type { Deal, Requirement } from "../schema";

export const transactionStages = [
  "Sourcing",
  "Offer",
  "LOI",
  "Agreement",
  "Inspection",
  "Closing",
  "Completed",
  "Lost",
  "Cancelled",
] as const;
export type TransactionStage = (typeof transactionStages)[number];
export const singleAircraftScopeMessage =
  "Each opportunity tracks one saved aircraft serial. Requalify the offer for that aircraft and reopen a single-aircraft cycle; create separate serial-specific opportunities for any other aircraft.";
export const milestoneKeys = [
  "Representation",
  "Availability",
  "Letter of intent",
  "Executed agreement",
  "Technical records",
  "Pre-purchase inspection",
  "Title",
  "Settlement",
  "Delivery acceptance",
] as const;
export type MilestoneKey = (typeof milestoneKeys)[number];
export const evidenceStates = [
  "Received",
  "Reviewed",
  "Verification recorded",
  "Waiver recorded",
] as const;
const note = z.string().trim().min(20).max(3000);
const identity = z.string().trim().min(2).max(300);
const date = z.iso.date();
const money = z
  .string()
  .trim()
  .regex(
    /^(?:0|[1-9]\d{0,11})(?:\.\d{1,2})?$/,
    "Use a positive plain decimal with at most two decimal places.",
  )
  .refine(
    (v) => /^\d+(?:\.\d{1,2})?$/.test(v) && BigInt(v.replace(".", "")) > 0n,
    "Amount must be positive.",
  );
export const transactionActionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("configure"),
    transactionKind: z.enum(["Sale", "Lease"]),
    nextAction: identity,
    dueOn: date.nullable(),
    note,
  }),
  z.object({
    kind: z.literal("offer"),
    side: z.enum(["Buyer", "Seller"]),
    contactId: z.string().min(1).max(300),
    offerKind: z.enum(["Offer", "Counteroffer"]),
    parentId: z.uuid().nullable(),
    amount: money,
    currency: z
      .string()
      .trim()
      .regex(/^[A-Z]{3}$/),
    basis: z.enum(["Purchase price", "Monthly rent", "Hourly rate"]),
    quantity: z
      .number()
      .int()
      .refine((quantity): boolean => quantity === 1, singleAircraftScopeMessage),
    offeredOn: date,
    expiresOn: date.nullable(),
    terms: note,
    sourceId: z.uuid(),
    note,
    attested: z.literal(true),
  }),
  z.object({
    kind: z.literal("offer-decision"),
    offerId: z.uuid(),
    decision: z.enum(["Accepted", "Rejected", "Withdrawn"]),
    sourceId: z.uuid(),
    decidedOn: date,
    recordedBy: identity,
    note,
    attested: z.literal(true),
  }),
  z.object({
    kind: z.literal("evidence"),
    key: z.enum(milestoneKeys),
    sourceId: z.uuid(),
    occurredOn: date,
    party: identity,
    detail: note,
    note,
    attested: z.literal(true),
  }),
  z.object({
    kind: z.literal("evidence-decision"),
    evidenceId: z.uuid(),
    state: z.enum(["Reviewed", "Verification recorded", "Waiver recorded"]),
    recordedBy: identity,
    occurredOn: date,
    note,
    attested: z.literal(true),
  }),
  z.object({
    kind: z.literal("finding"),
    category: z.enum(["Technical", "Title", "Commercial", "Other"]),
    severity: z.enum(["Blocking", "Question"]),
    title: identity,
    detail: note,
    sourceId: z.uuid().nullable(),
    dueOn: date.nullable(),
    note,
    attested: z.literal(true),
  }),
  z.object({
    kind: z.literal("resolve-finding"),
    findingId: z.uuid(),
    resolution: z.enum(["Remedied", "Accepted", "Waived"]),
    sourceId: z.uuid(),
    recordedBy: identity,
    occurredOn: date,
    note,
    attested: z.literal(true),
  }),
  z.object({
    kind: z.literal("transition"),
    status: z.enum(transactionStages),
    occurredOn: date,
    sourceId: z.uuid().nullable(),
    note,
    attested: z.literal(true),
  }),
  z.object({
    kind: z.literal("reopen"),
    occurredOn: date,
    sourceId: z.uuid(),
    nextAction: identity,
    note,
    attested: z.literal(true),
  }),
]);
export type TransactionAction = z.infer<typeof transactionActionSchema>;
export type TransactionOffer = {
  id: string;
  cycle: number;
  side: "Buyer" | "Seller";
  contactId: string;
  contactName: string;
  contactEmail: string;
  offerKind: "Offer" | "Counteroffer";
  parentId: string | null;
  amount: string;
  currency: string;
  basis: string;
  quantity: number;
  offeredOn: string;
  expiresOn: string | null;
  terms: string;
  sourceId: string;
  note: string;
  status: "Recorded" | "Accepted" | "Rejected" | "Withdrawn";
  decisionNote: string | null;
  decidedOn: string | null;
  decisionSourceId: string | null;
  recordedBy: string | null;
  createdAt: string;
};
export type TransactionEvidence = {
  id: string;
  cycle: number;
  key: MilestoneKey;
  sourceId: string;
  sourceTitle: string;
  occurredOn: string;
  party: string;
  detail: string;
  state: (typeof evidenceStates)[number];
  reviewer: string | null;
  reviewNote: string;
  reviewedOn: string | null;
  createdAt: string;
  current: boolean;
};
export type TransactionFinding = {
  id: string;
  cycle: number;
  category: string;
  severity: "Blocking" | "Question";
  title: string;
  detail: string;
  sourceId: string | null;
  dueOn: string | null;
  status: "Open" | "Resolved";
  resolution: string | null;
  resolutionSourceId: string | null;
  resolvedBy: string | null;
  resolvedOn: string | null;
  resolutionNote: string;
  createdAt: string;
};
export type TransactionSummary = {
  dealId: string;
  status: TransactionStage;
  cycle: number;
  revision: number;
  transactionKind: "Sale" | "Lease";
  nextAction: string;
  dueOn: string | null;
  completedOn: string | null;
  completionSourceId: string | null;
  updatedAt: string | null;
};
export type TransactionDetail = TransactionSummary & {
  deal: Deal;
  contextChanged: boolean;
  supersededRequirement: boolean;
  singleAircraftScopeInvalid: boolean;
  commercialScopeIssue: string | null;
  aircraft: { manufacturer: string; model: string; serial: string } | null;
  requirement: Pick<
    Requirement,
    "client" | "aircraftModel" | "quantity" | "transactionKind" | "leaseCurrency" | "leaseBasis"
  > | null;
  contacts: { id: string; name: string; company: string; type: string; email: string }[];
  sources: { id: string; title: string }[];
  offers: TransactionOffer[];
  evidence: TransactionEvidence[];
  findings: TransactionFinding[];
  activity: { id: string; action: string; detail: Record<string, unknown>; createdAt: string }[];
};
export function isTerminal(status: TransactionStage) {
  return ["Completed", "Lost", "Cancelled"].includes(status);
}
export function nextTransactionStage(status: TransactionStage): TransactionStage | null {
  const index = transactionStages.indexOf(status);
  return index >= 0 && index < 6 ? transactionStages[index + 1] : null;
}
export function transactionGaps(
  detail: {
    cycle: number;
    contextChanged: boolean;
    offers: Pick<TransactionOffer, "cycle" | "status" | "quantity">[];
    evidence: Pick<TransactionEvidence, "cycle" | "current" | "key" | "state">[];
    findings: Pick<TransactionFinding, "cycle" | "severity" | "status">[];
  },
  target: TransactionStage,
) {
  const gaps: string[] = [];
  if (detail.contextChanged && !["Lost", "Cancelled"].includes(target))
    gaps.push(
      "Linked opportunity records changed; reopen the transaction cycle against current records.",
    );
  const current = detail.evidence.filter((e) => e.cycle === detail.cycle && e.current);
  const has = (key: MilestoneKey, minimum: "Received" | "Reviewed" | "Verification recorded") =>
    current.some(
      (e) =>
        e.key === key &&
        (e.state === "Waiver recorded"
          ? ["Letter of intent", "Pre-purchase inspection"].includes(key)
          : evidenceStates.indexOf(e.state) >= evidenceStates.indexOf(minimum)),
    );
  const need = (key: MilestoneKey, level: "Received" | "Reviewed" | "Verification recorded") => {
    if (!has(key, level)) gaps.push(`${key}: ${level.toLowerCase()} evidence required.`);
  };
  const stage = transactionStages.indexOf(target);
  if (stage >= 1 && stage <= 6) {
    if (
      detail.offers.some(
        (o) => o.cycle === detail.cycle && o.status === "Accepted" && o.quantity > 1,
      )
    )
      gaps.push(singleAircraftScopeMessage);
    need("Representation", "Reviewed");
    need("Availability", "Reviewed");
    if (!detail.offers.some((o) => o.cycle === detail.cycle))
      gaps.push("Record a source-backed offer.");
  }
  if (stage >= 2 && stage <= 6) {
    if (!detail.offers.some((o) => o.cycle === detail.cycle && o.status === "Accepted"))
      gaps.push("Record an accepted offer with the acceptance evidence.");
    need("Letter of intent", "Reviewed");
  }
  if (stage >= 3 && stage <= 6) need("Executed agreement", "Verification recorded");
  if (stage >= 4 && stage <= 6) need("Technical records", "Reviewed");
  if (stage >= 5 && stage <= 6) {
    need("Pre-purchase inspection", "Verification recorded");
    need("Title", "Verification recorded");
    if (
      detail.findings.some(
        (f) => f.cycle === detail.cycle && f.severity === "Blocking" && f.status === "Open",
      )
    )
      gaps.push("Resolve every blocking finding with retained evidence.");
  }
  if (target === "Completed") {
    need("Representation", "Verification recorded");
    need("Availability", "Verification recorded");
    need("Technical records", "Verification recorded");
    need("Settlement", "Verification recorded");
    need("Delivery acceptance", "Verification recorded");
  }
  return gaps;
}
