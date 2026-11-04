import { z } from "zod";
import { aircraftSchema } from "../schema";
import {
  amountSupported,
  currencySupported,
  leaseBasisSupported,
  offeringSupported,
  purchaseAmountSupported,
  retainedQuoteContext,
  retainedCommercialContext,
  csvPurchaseAmountSupported,
  csvLeaseAmountSupported,
  leaseAmountSupported,
} from "./commercial-evidence";

export const fieldNames = [
  "manufacturer",
  "model",
  "serial",
  "registration",
  "category",
  "year",
  "engine",
  "hours",
  "cycles",
  "price",
  "offering",
  "leaseRate",
  "leaseCurrency",
  "leaseBasis",
  "location",
  "country",
  "availableDate",
] as const;
export const fieldLabels: Record<FieldName, string> = {
  manufacturer: "Manufacturer",
  model: "Model",
  serial: "Serial number",
  registration: "Registration",
  category: "Market",
  year: "Year",
  engine: "Engine",
  hours: "Flight hours",
  cycles: "Flight cycles",
  price: "Purchase asking price · USD",
  offering: "Offered transaction",
  leaseRate: "Lease rate per aircraft",
  leaseCurrency: "Lease currency · ISO code",
  leaseBasis: "Lease rate basis",
  location: "Location",
  country: "Country",
  availableDate: "Available date",
};
export type FieldName = (typeof fieldNames)[number];
export const factSchema = z.object({
  field: z.enum(fieldNames),
  value: z.union([z.string().min(1).max(300), z.number()]),
  quote: z.string().min(1).max(1500),
  page: z.number().int().min(1).max(40),
});
export const extractionOutputSchema = z.object({
  candidates: z.array(z.object({ facts: z.array(factSchema).max(50) })).max(100),
});
export const pageSchema = z.object({
  page: z.number().int().positive(),
  text: z.string().max(200_000),
});
export type Fact = z.infer<typeof factSchema>;
export type SourcePage = z.infer<typeof pageSchema>;
export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;
export type SourceRecord = {
  id: string;
  title: string;
  kind: "text" | "csv" | "pdf";
  sourceUrl: string | null;
  filename: string;
  sha256: string;
  createdAt: string;
  pages: SourcePage[];
  status: "ready" | "queued" | "running" | "completed" | "failed";
  error: string | null;
  provider: string | null;
  attempts: number;
};
export type ReviewRecord = {
  id: string;
  sourceId: string;
  extractionId: string;
  status: "pending" | "approved" | "rejected";
  facts: Fact[];
  values: Partial<Record<FieldName, string | number>>;
  warnings: string[];
  reviewedAt: string | null;
  reviewer: string | null;
  aircraftId: string | null;
  note: string;
};
export type Pipeline = {
  sources: SourceRecord[];
  reviews: ReviewRecord[];
  modelReady: boolean;
  modelProviders?: {
    id: import("../agents/schema").ModelProvider;
    ready: boolean;
    model: string | null;
  }[];
  pendingReviews: number;
  approvedReviews: number;
  totalReviews: number;
};

const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
export function validateEvidence(
  output: ExtractionOutput,
  pages: SourcePage[],
  kind: SourceRecord["kind"] = "text",
) {
  return output.candidates.map((candidate) => {
    const facts: Fact[] = [];
    const warnings: string[] = [];
    const contexts = candidate.facts.map((fact) => {
      const page = pages.find((item) => item.page === fact.page);
      return page ? retainedCommercialContext(page.text, fact.quote) : fact.quote;
    });
    const candidateText = contexts.join("\n");
    for (const fact of candidate.facts) {
      const page = pages.find((p) => p.page === fact.page);
      if (!page || !normalize(page.text).includes(normalize(fact.quote))) {
        warnings.push(
          `${fieldLabels[fact.field]}: evidence passage was not found; proposed value removed.`,
        );
        continue;
      }
      const result = aircraftSchema.shape[fact.field].safeParse(fact.value);
      if (!result.success) {
        warnings.push(`${fieldLabels[fact.field]}: invalid value removed.`);
        continue;
      }
      const context = retainedQuoteContext(page.text, fact.quote);
      if (
        fact.field === "price" &&
        !(kind === "csv"
          ? csvPurchaseAmountSupported(page.text, fact.quote, Number(fact.value))
          : purchaseAmountSupported(context, Number(fact.value), { candidateText }))
      ) {
        warnings.push(
          "Purchase asking price · USD: a supported purchase amount in USD is required; periodic rent and lease-only prices cannot become purchase prices. Value removed.",
        );
        continue;
      }
      if (fact.field === "offering" && !offeringSupported(context, String(fact.value))) {
        warnings.push("Offered transaction: sale/lease meaning was not supported; value removed.");
        continue;
      }
      if (fact.field === "leaseCurrency" && !currencySupported(context, String(fact.value))) {
        warnings.push("Lease currency: explicit currency was not supported; value removed.");
        continue;
      }
      if (fact.field === "leaseBasis" && !leaseBasisSupported(context, String(fact.value))) {
        warnings.push(
          "Lease rate basis: explicit monthly/hourly units were not supported; value removed.",
        );
        continue;
      }
      if (fact.field === "leaseRate") {
        const ownSection = retainedCommercialContext(page.text, fact.quote);
        const sameSection = (other: Fact) =>
          other.page === fact.page && normalize(ownSection).includes(normalize(other.quote));
        const currency = candidate.facts.find(
          (item) =>
            item.field === "leaseCurrency" &&
            sameSection(item) &&
            contexts.some((text) => currencySupported(text, String(item.value))),
        );
        const basis = candidate.facts.find(
          (item) =>
            item.field === "leaseBasis" &&
            sameSection(item) &&
            contexts.some((text) => leaseBasisSupported(text, String(item.value))),
        );
        if (
          !currency ||
          !basis ||
          !amountSupported(context, Number(fact.value)) ||
          (currency &&
            basis &&
            !leaseAmountSupported(
              context,
              Number(fact.value),
              String(currency.value),
              String(basis.value),
            )) ||
          (kind === "csv" &&
            !csvLeaseAmountSupported(
              page.text,
              fact.quote,
              Number(fact.value),
              String(currency.value),
              String(basis.value),
            ))
        ) {
          warnings.push(
            "Lease rate: explicit amount, currency and monthly/hourly basis are required; value removed.",
          );
          continue;
        }
      }
      const stated =
        typeof fact.value === "number"
          ? new RegExp(`(^|[^\\d.])${String(fact.value).replace(".", "\\.")}([^\\d.]|$)`).test(
              normalize(fact.quote).replace(/,/g, ""),
            )
          : ["offering", "leaseBasis", "leaseCurrency"].includes(fact.field)
            ? true
            : normalize(fact.quote).toLowerCase().includes(normalize(fact.value).toLowerCase());
      if (!stated) {
        warnings.push(
          `${fieldLabels[fact.field]}: proposed value was not present in its evidence; removed.`,
        );
        continue;
      }
      if (
        !facts.some(
          (f) =>
            f.field === fact.field &&
            f.value === fact.value &&
            f.page === fact.page &&
            f.quote === fact.quote,
        )
      )
        facts.push({ ...fact, value: result.data as string | number });
    }
    const values: ReviewRecord["values"] = {};
    if (
      facts.some((fact) => fact.field === "leaseRate") &&
      !["leaseCurrency", "leaseBasis"].every((field) => facts.some((fact) => fact.field === field))
    ) {
      for (let index = facts.length - 1; index >= 0; index--)
        if (facts[index].field === "leaseRate") facts.splice(index, 1);
      warnings.push(
        "Lease rate: its currency or rate basis failed source validation; amount removed.",
      );
    }
    for (const field of fieldNames) {
      const candidates = facts.filter((f) => f.field === field);
      if (new Set(candidates.map((f) => f.value)).size > 1)
        warnings.push(
          `${fieldLabels[field]}: conflicting values. Select the supported value during review.`,
        );
      if (candidates.length) values[field] = candidates[0].value;
    }
    return { facts, values, warnings };
  });
}

export const sampleSource = `Manufacturer: Airbus\nModel: A319-112\nSerial: LOCAL-EXAMPLE-01\nRegistration: EXAMPLE\nCategory: Commercial\nYear: 2015\nEngine: CFM56-5B\nHours: 22000\nCycles: 10500\nPrice USD: 21500000\nLocation: Toulouse\nCountry: France\nAvailableDate: 2027-03-01\n\nFictional example for testing the review workflow.`;
