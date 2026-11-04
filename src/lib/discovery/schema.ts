import { z } from "zod";
import type { AgentRun, Citation, ProposalRecord } from "../agents/schema";

export const discoveryInputSchema = z
  .object({
    side: z.enum(["Buyer", "Seller"]),
    target: z.string().trim().min(2).max(120),
    market: z.enum(["Any", "Commercial", "Business"]),
    region: z.string().trim().max(120),
    method: z.enum(["web", "urls"]),
    query: z.string().trim().max(400),
    urls: z.array(z.url().max(2000)).max(3),
    freshness: z.enum(["any", "month", "year"]),
    buyerIntent: z.enum(["Demand", "Fleet", "Profiles"]).optional(),
    purpose: z.enum(["leads", "contacts"]).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.query.split(/\s+/).length > 75)
      ctx.addIssue({ code: "custom", message: "Search queries support up to 75 words." });
    if (value.method === "web" && (value.query.length < 3 || value.urls.length))
      ctx.addIssue({
        code: "custom",
        message: "Web discovery needs a search query and no URL list.",
      });
    if (value.method === "urls" && (!value.urls.length || value.query))
      ctx.addIssue({
        code: "custom",
        message: "URL discovery needs one to three public URLs and no query.",
      });
  });
export type DiscoveryInput = z.infer<typeof discoveryInputSchema>;
export const leadValuesSchema = z.object({
  side: z.enum(["Buyer", "Seller"]),
  basis: z.enum(["Stated demand", "Aircraft listing", "Fleet activity", "Business profile"]),
  organization: z
    .string()
    .trim()
    .min(2)
    .max(200)
    .nullable()
    .describe(
      "Exact organization name as printed in a cited publisher passage. No role annotations such as '(broker)'. Add a separate quote containing the name if needed. Null if no name is stated.",
    ),
  aircraftModel: z
    .string()
    .trim()
    .min(2)
    .max(160)
    .nullable()
    .describe("Exact aircraft model spelling printed in a cited passage. Null if unstated."),
  geography: z
    .string()
    .trim()
    .min(2)
    .max(160)
    .nullable()
    .describe(
      "Location literally stated in a cited passage. Null if missing. Never copy Any, Worldwide, the search region or other search settings into this field.",
    ),
  contactName: z.string().trim().min(2).max(160).nullable(),
  email: z.email().max(254).nullable(),
  phone: z.string().trim().min(6).max(80).nullable(),
  summary: z.string().trim().min(10).max(1500),
});
export type LeadValues = z.infer<typeof leadValuesSchema>;
export type DiscoveryResult = {
  id: string;
  rank: number;
  url: string;
  title: string;
  snippet: string;
  status: "unread" | "collecting" | "retained" | "failed";
  sourceId: string | null;
  error: string | null;
};
export type DiscoverySession = {
  run: AgentRun;
  searchStatus: "pending" | "completed" | "failed" | null;
  searchedAt: string | null;
  error: string | null;
  results: DiscoveryResult[];
};
export type DiscoveryLead = {
  id: string;
  runId: string;
  sourceId: string;
  url: string;
  values: LeadValues;
  citations: Citation[];
  createdAt: string;
};
export type DiscoveryCenter = {
  search: { ready: boolean; detail: string };
  providers: { id: string; ready: boolean; model: string | null; detail: string }[];
  sessions: DiscoverySession[];
  proposals: (ProposalRecord & { runRevision: number; sourceUrl: string })[];
  leads: DiscoveryLead[];
  counts: { runs: number; pending: number; saved: number; pages: number };
};
export function suggestedQuery(
  side: DiscoveryInput["side"],
  target: string,
  region: string,
  intent: "Demand" | "Fleet" | "Profiles" = "Demand",
) {
  if (side === "Buyer") {
    const focus = target.replace(/["\r\n]/g, " ").trim();
    if (intent === "Demand") {
      const subject = `${focus ? `"${focus.slice(0, 100)}" ` : ""}${region.trim().slice(0, 70)}`.trim();
      return `${subject} "wanted" OR ${subject} "acquisition mandates"`.trim().slice(0, 400);
    }
    return `${focus ? `"${focus}" ` : ""}${intent === "Fleet" ? 'aircraft "fleet expansion"' : "aircraft operator company"} ${region.trim()}`
      .trim()
      .slice(0, 400);
  }
  const subject = `${target.trim()} ${region.trim()}`.trim();
  return `${subject} ${side === "Seller" ? 'aircraft "for sale"' : "aircraft wanted"}`
    .trim()
    .slice(0, 400);
}
