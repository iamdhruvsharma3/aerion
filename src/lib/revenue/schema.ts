import { z } from "zod";
import { currencies, moneyMinor, percentageFee, percentageUnits, type Currency } from "./money";
import type { Contact } from "../schema";

const text = z.string().trim().min(1).max(300);
const recordId = text;
const note = z.string().trim().min(20).max(3000);
const amount = z.string().trim().min(1).max(24);
export const currencySchema = z.enum(currencies as [Currency, ...Currency[]]);
export const engagementTermsSchema = z
  .object({
    title: text,
    clientContactId: recordId,
    payerContactId: recordId,
    representation: z.enum([
      "Buyer sourcing",
      "Seller representation",
      "Introduction",
      "Other service",
    ]),
    requirementId: recordId.nullable(),
    dealId: recordId.nullable(),
    scope: note,
    startsOn: z.iso.date(),
    endsOn: z.iso.date().nullable(),
    currency: currencySchema,
    feeType: z.enum(["Fixed", "Percentage"]),
    fixedAmount: amount.nullable(),
    percentage: amount.nullable(),
    estimateBasis: amount.nullable(),
    basisDescription: z.string().trim().min(10).max(1500),
    earningTrigger: z.enum(["Closing", "Introduction", "Milestone", "Other"]),
    earningTerms: note,
    paymentTerms: z.string().trim().min(10).max(2000),
    signedSourceId: z.uuid().nullable(),
    signatory: z.string().trim().max(300),
    signedOn: z.iso.date().nullable(),
  })
  .superRefine((terms, ctx) => {
    if (terms.endsOn && terms.endsOn < terms.startsOn)
      ctx.addIssue({
        code: "custom",
        path: ["endsOn"],
        message: "End date must be on or after the start date.",
      });
    try {
      if (terms.feeType === "Fixed") {
        if (!terms.fixedAmount || terms.percentage || terms.estimateBasis)
          throw new Error(
            "A fixed fee needs only its agreed amount; percentage and estimate basis must be empty.",
          );
        moneyMinor(terms.fixedAmount, terms.currency);
      } else {
        if (!terms.percentage || terms.fixedAmount)
          throw new Error("A percentage fee needs a percentage; fixed amount must be empty.");
        percentageUnits(terms.percentage);
        if (terms.estimateBasis)
          percentageFee(moneyMinor(terms.estimateBasis, terms.currency), terms.percentage);
      }
    } catch (error) {
      ctx.addIssue({
        code: "custom",
        path: ["feeType"],
        message: error instanceof Error ? error.message : "Invalid fee terms.",
      });
    }
  });
export type EngagementTerms = z.infer<typeof engagementTermsSchema>;
export const createEngagementSchema = z.object({
  terms: engagementTermsSchema,
  idempotencyKey: z.uuid(),
});
export const revenueActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("edit"), terms: engagementTermsSchema }),
  z.object({ kind: z.literal("activate"), note, attested: z.literal(true) }),
  z.object({
    kind: z.literal("end"),
    endedOn: z.iso.date(),
    note,
    sourceId: z.uuid(),
    attested: z.literal(true),
  }),
  z.object({
    kind: z.literal("earn"),
    earnedOn: z.iso.date(),
    basisAmount: amount.nullable(),
    sourceId: z.uuid(),
    note,
    attested: z.literal(true),
  }),
  z.object({
    kind: z.literal("void-earning"),
    earningId: z.uuid(),
    sourceId: z.uuid(),
    note,
    attested: z.literal(true),
  }),
  z.object({
    kind: z.literal("invoice"),
    earningId: z.uuid(),
    amount,
    taxAmount: amount,
    taxLabel: z.string().trim().max(200),
    issuedOn: z.iso.date(),
    dueOn: z.iso.date(),
    issuerName: text,
    issuerEmail: z.email(),
    issuerAddress: z.string().trim().min(5).max(1500),
    issuerRegistration: z.string().trim().max(300),
    billToAddress: z.string().trim().min(5).max(1500),
    description: z.string().trim().min(10).max(2000),
    paymentInstructions: z.string().trim().min(10).max(2000),
    note,
    attested: z.literal(true),
  }),
  z.object({
    kind: z.literal("void-invoice"),
    invoiceId: z.uuid(),
    sourceId: z.uuid(),
    note,
    attested: z.literal(true),
  }),
  z.object({
    kind: z.literal("receipt"),
    invoiceId: z.uuid(),
    amount,
    paymentTotal: amount,
    receivedOn: z.iso.date(),
    reference: z.string().trim().min(2).max(200),
    sourceId: z.uuid(),
    note,
    attested: z.literal(true),
  }),
  z.object({
    kind: z.literal("void-payment"),
    paymentId: z.uuid(),
    sourceId: z.uuid(),
    note,
    attested: z.literal(true),
  }),
  z.object({
    kind: z.literal("reverse-receipt"),
    receiptId: z.uuid(),
    sourceId: z.uuid(),
    note,
    attested: z.literal(true),
  }),
  z.object({
    kind: z.literal("expense"),
    amount,
    incurredOn: z.iso.date(),
    category: z.enum(["Research", "Travel", "Professional services", "Technology", "Other"]),
    description: z.string().trim().min(10).max(1500),
    reference: z.string().trim().min(2).max(200),
    sourceId: z.uuid(),
    note,
    attested: z.literal(true),
  }),
  z.object({
    kind: z.literal("reverse-expense"),
    expenseId: z.uuid(),
    sourceId: z.uuid(),
    note,
    attested: z.literal(true),
  }),
]);
export type RevenueAction = z.infer<typeof revenueActionSchema>;
export const revenueMutationSchema = z.object({
  revision: z.number().int().nonnegative(),
  idempotencyKey: z.uuid(),
  action: revenueActionSchema,
});

export type Engagement = {
  id: string;
  revision: number;
  status: "Draft" | "Active" | "Ended";
  terms: EngagementTerms;
  parties: { client: Contact; payer: Contact };
  activatedAt: string | null;
  activationNote: string;
  endedOn: string | null;
  endedNote: string;
  createdAt: string;
  updatedAt: string;
};
export type Earning = {
  id: string;
  engagementId: string;
  earnedOn: string;
  amountMinor: string;
  basisMinor: string | null;
  sourceId: string;
  note: string;
  status: "Recorded" | "Voided";
  voidNote: string;
  transactionSnapshot: {
    cycle: number;
    completedOn: string;
    completionSourceId: string;
    revision: number;
  } | null;
  createdAt: string;
};
export type InvoiceSnapshot = {
  issuerName: string;
  issuerEmail: string;
  issuerAddress: string;
  issuerRegistration: string;
  billTo: { name: string; company: string; email: string; address: string };
  engagementTitle: string;
  description: string;
  paymentInstructions: string;
  taxLabel: string;
  feeTerms: {
    type: "Fixed" | "Percentage";
    percentage: string | null;
    basisDescription: string;
    earningTerms: string;
    paymentTerms: string;
  };
};
export type RevenueInvoice = {
  id: string;
  engagementId: string;
  earningId: string;
  number: string;
  currency: Currency;
  issuedOn: string;
  dueOn: string;
  subtotalMinor: string;
  taxMinor: string;
  totalMinor: string;
  snapshot: InvoiceSnapshot;
  status: "Issued" | "Voided";
  voidNote: string;
  createdAt: string;
  receivedMinor: string;
  outstandingMinor: string;
};
export type RevenueReceipt = {
  id: string;
  invoiceId: string;
  paymentId: string;
  engagementId: string;
  amountMinor: string;
  receivedOn: string;
  reference: string;
  sourceId: string;
  note: string;
  status: "Recorded" | "Reversed";
  reversalSourceId: string | null;
  reversalNote: string;
  createdAt: string;
};
export type RevenuePayment = {
  id: string;
  payerContactId: string;
  payer: Contact;
  reference: string;
  currency: Currency;
  amountMinor: string;
  allocatedMinor: string;
  unallocatedMinor: string;
  receivedOn: string;
  sourceId: string;
  note: string;
  legacyAmount: boolean;
  status: "Recorded" | "Voided";
  voidNote: string;
  createdAt: string;
};
export type RevenueExpense = {
  id: string;
  engagementId: string;
  amountMinor: string;
  incurredOn: string;
  category: string;
  description: string;
  reference: string;
  sourceId: string;
  note: string;
  status: "Recorded" | "Reversed";
  reversalNote: string;
  reversalSourceId: string | null;
  createdAt: string;
};
export type RevenueTotals = {
  currency: Currency;
  estimatedMinor: string;
  contractedMinor: string;
  earnedMinor: string;
  invoicedMinor: string;
  outstandingMinor: string;
  receivedMinor: string;
  expensesMinor: string;
  netCashMinor: string;
};
export type EngagementSummary = Engagement & {
  estimatedMinor: string | null;
  totals: RevenueTotals;
  effectiveStatus: "Draft" | "Active" | "Ended" | "Expired" | "Upcoming";
};
export type RevenueCenter = {
  engagements: EngagementSummary[];
  totals: RevenueTotals[];
  sources: { id: string; title: string }[];
};
export type RevenueDetail = {
  engagement: EngagementSummary;
  earnings: Earning[];
  invoices: RevenueInvoice[];
  receipts: RevenueReceipt[];
  payments: RevenuePayment[];
  expenses: RevenueExpense[];
  activity: { id: string; action: string; detail: Record<string, unknown>; createdAt: string }[];
  sources: { id: string; title: string }[];
  completionWarning: string | null;
};
