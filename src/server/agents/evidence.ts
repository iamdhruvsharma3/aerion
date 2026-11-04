import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import type { Citation, ProposalAction, AgentReport } from "../../lib/agents/schema";
import type { SourcePage, SourceRecord } from "../../lib/intelligence/schema";
import type { Scope } from "../db";
import { workspaceSchema } from "../../lib/schema";
import { HttpError } from "../http";
import { leadIdentity } from "../discovery/identity";
import { replyAssignmentVersion, requirementNeedsRequalification } from "../communication/context";
import { commercialRevisionStateInTransaction } from "./commercial-context";
import {
  currencySupported,
  hasLeaseLanguage,
  hasSaleLanguage,
  leaseBasisSupported,
  purchaseAmountSupported,
  retainedCommercialContext,
  leaseAmountSupported,
} from "../../lib/intelligence/commercial-evidence";
const normalize = (v: string) => v.replace(/\s+/g, " ").trim();
const listingAvailability = /\bfor\s+(?:(?:immediate|outright|dry|wet)\s+){0,2}(?:sale|lease)\b/i;
function canonical(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
export const fingerprint = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export function validateCitations(
  citations: Citation[],
  sources: Pick<SourceRecord, "id" | "pages">[],
) {
  for (const c of citations) {
    const page = sources.find((s) => s.id === c.sourceId)?.pages.find((p) => p.page === c.page);
    if (!page || !normalize(page.text).includes(normalize(c.quote)))
      throw new HttpError(
        422,
        `An agent citation does not resolve to the retained source passage. Source ${c.sourceId}, page ${c.page}, quote ${JSON.stringify(c.quote.slice(0, 180))}. Copy a continuous exact passage from that authorized source; workspace summaries are not publisher quotes.`,
      );
  }
}

/** Give a rejected report the actual authorized pages it misquoted, even beyond the initial excerpts. */
export function reportRepairPassages(
  report: AgentReport | null,
  sources: Pick<SourceRecord, "id" | "pages">[],
) {
  const pages: {
    sourceId: string;
    page: number;
    quote: string;
    more: boolean;
    totalCharacters: number;
  }[] = [];
  const include = (sourceId: string, pageNumber: number) => {
    if (
      pages.length >= 5 ||
      pages.some((item) => item.sourceId === sourceId && item.page === pageNumber)
    )
      return;
    const page = sources
      .find((item) => item.id === sourceId)
      ?.pages.find((item) => item.page === pageNumber);
    if (page)
      pages.push({
        sourceId,
        page: page.page,
        quote: page.text.slice(0, 1500),
        more: page.text.length > 1500,
        totalCharacters: page.text.length,
      });
  };
  if (report) {
    for (const citation of report.findings.flatMap((finding) => finding.citations)) {
      try {
        validateCitations([citation], sources);
      } catch {
        include(citation.sourceId, citation.page);
      }
    }
  } else {
    for (const source of sources.slice(0, 5)) {
      const page = source.pages[0];
      if (page) include(source.id, page.page);
    }
  }
  return pages;
}
export function containsValue(citations: Citation[], value: string | number) {
  return citations.some((c) => {
    const quote = normalize(c.quote).toLowerCase();
    if (typeof value === "number")
      return new RegExp(`(^|[^\\d.])${String(value).replace(".", "\\.")}([^\\d.]|$)`).test(
        quote.replace(/,/g, ""),
      );
    return quote.includes(normalize(value).toLowerCase());
  });
}
export function validateProposedFacts(
  action: ProposalAction,
  citations: Citation[],
  sources?: Pick<SourceRecord, "id" | "pages">[],
) {
  if (
    ["requirement", "contact", "comparable", "interaction", "lead", "lead-enrichment"].includes(
      action.type,
    ) &&
    !citations.length
  )
    throw new HttpError(422, "New factual records require retained source citations.");
  const requireValue = (value: string | number) => {
    if (!containsValue(citations, value))
      throw new HttpError(
        422,
        `A proposed factual value is not stated in its source citations: ${String(value).slice(0, 100)}`,
      );
  };
  if (action.type === "lead-enrichment") {
    if (!citations.every((c) => c.sourceId === action.sourceId))
      throw new HttpError(422, "Contact research must cite its inspected publisher page.");
    const v = action.values;
    for (const value of [v.organization, v.contactName, v.email, v.phone, v.geography])
      if (value) requireValue(value);
    if (![v.contactName, v.email, v.phone, v.geography].some(Boolean))
      throw new HttpError(422, "No published business details were stated.");
    if (
      [v.email, v.phone, v.contactName].some(Boolean) &&
      !citations.some(
        (c) =>
          containsValue([c], v.organization) &&
          [v.email, v.phone, v.contactName]
            .filter((s): s is string => s !== null)
            .every((value) => containsValue([c], value)),
      )
    )
      throw new HttpError(
        422,
        "Quote the organization and its published contact details together; unrelated directory or publisher contacts cannot be used.",
      );
  }
  if (action.type === "lead") {
    const v = action.values;
    if (!citations.every((c) => c.sourceId === action.sourceId))
      throw new HttpError(
        422,
        "Every lead citation must come from its inspected publisher source.",
      );
    if (!v.organization && !v.aircraftModel)
      throw new HttpError(422, "A lead needs a stated organization or aircraft model.");
    if (v.side === "Buyer" && (!v.organization || v.basis === "Aircraft listing"))
      throw new HttpError(
        422,
        "Buyer leads need a stated organization and a buyer-side evidence basis.",
      );
    if (v.side === "Seller" && !["Aircraft listing", "Business profile"].includes(v.basis))
      throw new HttpError(
        422,
        "Seller leads need an aircraft listing or a business profile basis.",
      );
    const unsupported = (
      ["organization", "aircraftModel", "geography", "contactName", "email", "phone"] as const
    )
      .filter((field) => v[field] && !containsValue(citations, v[field]))
      .map((field) => `${field}: ${v[field]}`);
    if (unsupported.length)
      throw new HttpError(
        422,
        `Values not stated in YOUR cited passages: ${unsupported.join("; ")}. Use literal names without role annotations. Add exact quotes containing each value, including organization names in other paragraphs, or set unsupported nullable fields to null. Search settings are not facts.`,
      );
    if (
      (v.email || v.phone || v.contactName) &&
      (!v.organization ||
        !citations.some(
          (c) =>
            containsValue([c], v.organization ?? "") &&
            [v.email, v.phone, v.contactName]
              .filter((item): item is string => item !== null)
              .every((item) => containsValue([c], item)),
        ))
    )
      throw new HttpError(
        422,
        "Published contact details must be attributed to the organization in the same quoted passage. Leave unrelated contacts null.",
      );
    const text = normalize(citations.map((c) => c.quote).join(" "));
    if (v.basis === "Aircraft listing" && !listingAvailability.test(text))
      throw new HttpError(
        422,
        "An aircraft listing needs an explicit quoted sale or lease availability statement.",
      );
    if (
      v.basis === "Stated demand" &&
      !/seek(?:s|ing)?|wanted|looking (?:to|for)|requir(?:es|ement|ed|ing)|request for proposal|tender/i.test(
        text,
      )
    )
      throw new HttpError(
        422,
        "Stated demand needs an explicit quoted procurement or buying request. Fleet activity is a research signal.",
      );
  }
  if (action.type === "requirement") {
    const v = action.values;
    const commercialQuotes = citations.map((citation) => {
      const page = sources
        ?.find((source) => source.id === citation.sourceId)
        ?.pages.find((page) => page.page === citation.page);
      return page ? retainedCommercialContext(page.text, citation.quote) : citation.quote;
    });
    const commercialText = commercialQuotes.join("\n");
    const citedQuotes = citations.map((citation) => citation.quote);
    const citedText = citedQuotes.join("\n");
    for (const value of [
      v.client,
      v.aircraftModel,
      v.category,
      v.quantity,
      v.minYear,
      v.destination,
    ])
      requireValue(value);
    if (v.engine) requireValue(v.engine);
    if (v.budget !== null) {
      if (
        v.transactionKind === "Lease" ||
        !citedQuotes.some((quote) =>
          purchaseAmountSupported(quote, v.budget as number, { candidateText: citedText }),
        ) ||
        !commercialQuotes.some((quote) =>
          purchaseAmountSupported(quote, v.budget as number, { candidateText: commercialText }),
        )
      )
        throw new HttpError(
          422,
          "A purchase budget requires an explicit purchase amount in USD. Monthly/hourly lease budgets must use the separate lease fields.",
        );
    }
    if (v.transactionKind === undefined && (hasLeaseLanguage(commercialText) || v.budget == null))
      throw new HttpError(
        422,
        "State the source-supported transaction mode or Not supplied explicitly. Only a supported legacy purchase-USD budget can preserve omitted Sale semantics; a lease or ambiguous brief cannot default to purchase.",
      );
    if (
      v.transactionKind === "Sale" &&
      !hasSaleLanguage(citedText) &&
      (v.budget == null || hasLeaseLanguage(commercialText))
    )
      throw new HttpError(
        422,
        "The proposed sale transaction mode is not supported by the cited purchase terms.",
      );
    if (v.transactionKind === "Lease" && !hasLeaseLanguage(citedText))
      throw new HttpError(
        422,
        "The proposed lease transaction mode is not supported by its citations.",
      );
    if (
      v.leaseCurrency &&
      !citedQuotes.some((quote) => currencySupported(quote, v.leaseCurrency as string))
    )
      throw new HttpError(422, "Lease currency must be explicitly stated in the cited source.");
    if (
      v.leaseBasis &&
      !citedQuotes.some((quote) => leaseBasisSupported(quote, v.leaseBasis as string))
    )
      throw new HttpError(
        422,
        "Lease budget needs explicit monthly/hourly units in the cited source.",
      );
    if (v.leaseBudget != null) {
      if (
        v.transactionKind !== "Lease" ||
        !v.leaseCurrency ||
        !v.leaseBasis ||
        !citedQuotes.some((quote) =>
          leaseAmountSupported(
            quote,
            v.leaseBudget as number,
            v.leaseCurrency as string,
            v.leaseBasis as string,
          ),
        ) ||
        !commercialQuotes.some(
          (quote) =>
            hasLeaseLanguage(quote) &&
            leaseAmountSupported(
              quote,
              v.leaseBudget as number,
              v.leaseCurrency as string,
              v.leaseBasis as string,
            ),
        )
      )
        throw new HttpError(
          422,
          "A lease budget requires a cited lease amount, Lease transaction mode, explicit currency and monthly/hourly basis.",
        );
    }
    if (v.deadline) requireValue(v.deadline);
  }
  if (action.type === "contact") {
    for (const field of ["name", "role", "company", "email", "location", "type"] as const)
      requireValue(action.values[field]);
  }
  if (action.type === "interaction") {
    requireValue(action.occurredOn);
    requireValue(action.direction);
    if (!citations.some((c) => c.sourceId === action.sourceId))
      throw new HttpError(422, "The interaction must cite its retained message.");
  }
  if (action.type === "comparable") {
    for (const value of [
      action.manufacturer,
      action.model,
      action.year,
      action.amountUsd,
      action.basis,
      action.reportedOn,
      "USD",
    ])
      requireValue(value);
    if (!citations.some((c) => c.sourceId === action.sourceId))
      throw new HttpError(422, "Comparable evidence must cite its retained source.");
  }
}
export function validateReport(report: AgentReport, sources: Pick<SourceRecord, "id" | "pages">[]) {
  for (const f of report.findings) {
    try {
      validateCitations(f.citations, sources);
    } catch (error) {
      if (error instanceof HttpError)
        throw new HttpError(
          error.status,
          `Report finding ${JSON.stringify(f.title)}: ${error.message}`,
        );
      throw error;
    }
  }
  return report;
}
export async function validateDuplicateAction(
  db: PoolClient,
  scope: Scope,
  action: ProposalAction,
) {
  if (action.type === "deal") {
    const row = (
      await db.query("select data from aerion.workspaces where id=$1", [scope.workspaceId])
    ).rows[0];
    const data = workspaceSchema.parse(row?.data);
    if (
      data.deals.some(
        (deal) =>
          deal.requirementId === action.requirementId && deal.aircraftId === action.aircraftId,
      )
    )
      throw new HttpError(
        409,
        "This match already has an opportunity. Propose an execution add-action follow-up for the existing case instead of another deal.",
      );
  }
  if (
    action.type === "interaction" &&
    (
      await db.query(
        "select id from aerion.contact_interactions where workspace_id=$1 and contact_id=$2 and source_id=$3 and direction=$4",
        [scope.workspaceId, action.contactId, action.sourceId, action.direction],
      )
    ).rows.length
  )
    throw new HttpError(
      409,
      "This source interaction is already recorded. Review contact_history and propose only a new supported follow-up if needed.",
    );
}
/** A validation diagnostic, not a correction: the model must still submit and pass exact citations. */
export function leadCitationHints(
  action: Extract<ProposalAction, { type: "lead" }>,
  sources: Pick<SourceRecord, "id" | "pages">[],
): Citation[] {
  const source = sources.find((item) => item.id === action.sourceId);
  if (!source) return [];
  const needles: RegExp[] = [
    action.values.basis === "Aircraft listing"
      ? listingAvailability
      : /seek(?:s|ing)?|wanted|looking (?:to|for)|requirement/i,
  ];
  for (const value of [
    action.values.organization,
    action.values.aircraftModel,
    action.values.geography,
    action.values.contactName,
    action.values.email,
    action.values.phone,
  ])
    if (value)
      needles.push(
        new RegExp(
          value
            .split(/\s+/)
            .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("\\s+"),
          "i",
        ),
      );
  const hints: Citation[] = [];
  for (const needle of needles) {
    for (const page of source.pages) {
      const match = needle.exec(page.text);
      if (!match) continue;
      const quote = page.text.slice(
        Math.max(0, match.index - 160),
        match.index + match[0].length + 220,
      );
      if (!hints.some((item) => item.quote === quote))
        hints.push({ sourceId: source.id, page: page.page, quote });
      break;
    }
  }
  return hints.slice(0, 7);
}
/** Parent records that could change an action's meaning; unrelated agent actions do not invalidate a bundle. */
export async function proposalContext(db: PoolClient, scope: Scope, action: ProposalAction) {
  const result = await db.query("select data from aerion.workspaces where id=$1", [
    scope.workspaceId,
  ]);
  if (!result.rows[0]) throw new HttpError(404, "Workspace not found.");
  const data = workspaceSchema.parse(result.rows[0].data);
  const parent: Record<string, unknown> = { action };
  if ("leadId" in action && action.leadId) {
    const context = (
      await db.query(
        "select l.id,l.values,c.status,c.contact_id,c.requirement_id from aerion.discovery_leads l join aerion.lead_cases c on c.lead_id=l.id and c.workspace_id=l.workspace_id where l.workspace_id=$1 and l.id=$2",
        [scope.workspaceId, action.leadId],
      )
    ).rows[0];
    if (!context || context.status === "Dismissed")
      throw new HttpError(422, "The lead is unavailable for this action.");
    parent.lead = context;
    const assignmentVersion = await replyAssignmentVersion(db, scope, action.leadId);
    if (assignmentVersion) parent.replyAssignmentVersion = assignmentVersion;
    if (action.type === "lead-enrichment") {
      const page = (
        await db.query(
          "select r.url,s.sha256 from aerion.discovery_results r join aerion.sources s on s.id=r.source_id and s.workspace_id=r.workspace_id where r.workspace_id=$1 and r.id=$2 and r.source_id=$3 and r.status='retained'",
          [scope.workspaceId, action.resultId, action.sourceId],
        )
      ).rows[0];
      if (!page)
        throw new HttpError(422, "Contact evidence must come from an inspected publisher page.");
      parent.publisher = page;
      const { summary: _summary, ...facts } = action.values;
      parent.existing = (
        await db.query(
          "select id from aerion.lead_enrichments where workspace_id=$1 and dedupe_key=$2",
          [scope.workspaceId, fingerprint({ leadId: action.leadId, facts })],
        )
      ).rows;
    }
  }
  if (action.type === "lead") {
    const result = await db.query(
      "select r.url,r.source_id,s.sha256 from aerion.discovery_results r join aerion.sources s on s.id=r.source_id and s.workspace_id=r.workspace_id where r.workspace_id=$1 and r.id=$2 and r.source_id=$3 and r.status='retained'",
      [scope.workspaceId, action.resultId, action.sourceId],
    );
    if (!result.rows[0])
      throw new HttpError(422, "Lead evidence must be a retained publisher page.");
    parent.publisher = result.rows[0];
    parent.existing = (
      await db.query(
        "select id from aerion.discovery_leads where workspace_id=$1 and dedupe_key=$2",
        [scope.workspaceId, leadIdentity(result.rows[0].url, action.values)],
      )
    ).rows;
  }
  if ("requirementId" in action && action.requirementId) {
    parent.requirement = data.requirements.find((r) => r.id === action.requirementId);
    if (!parent.requirement) throw new HttpError(404, "Requirement not found.");
    const row = await db.query(
      "select confirmation from aerion.execution_cases where workspace_id=$1 and requirement_id=$2",
      [scope.workspaceId, action.requirementId],
    );
    parent.confirmation = row.rows[0]?.confirmation ?? null;
    if (await requirementNeedsRequalification(db, scope, action.requirementId))
      parent.requalificationRequired = true;
  }
  const aircraftId =
    action.type === "execution" && "aircraftId" in action.action
      ? action.action.aircraftId
      : "aircraftId" in action
        ? action.aircraftId
        : null;
  if (aircraftId) {
    parent.aircraft = data.aircraft.find((a) => a.id === aircraftId);
    if (!parent.aircraft) throw new HttpError(404, "Aircraft not found.");
  }
  const contactId =
    action.type === "execution" && "contactId" in action.action
      ? action.action.contactId
      : "contactId" in action
        ? action.contactId
        : null;
  if (contactId) {
    parent.contact = data.contacts.find((c) => c.id === contactId);
    if (!parent.contact) throw new HttpError(404, "Contact not found.");
  }
  if (action.type === "requirement")
    parent.existing = data.requirements.filter(
      (r) => r.client === action.values.client && r.aircraftModel === action.values.aircraftModel,
    );
  if (action.type === "contact")
    parent.existing = data.contacts.filter(
      (c) => c.email.toLowerCase() === action.values.email.toLowerCase(),
    );
  if (action.type === "interaction")
    parent.existing = (
      await db.query(
        "select id from aerion.contact_interactions where workspace_id=$1 and contact_id=$2 and source_id=$3 and direction=$4",
        [scope.workspaceId, action.contactId, action.sourceId, action.direction],
      )
    ).rows;
  if (action.type === "comparable")
    parent.existing = (
      await db.query(
        "select id from aerion.market_comparables where workspace_id=$1 and source_id=$2 and model=$3 and year=$4 and amount_usd=$5 and basis=$6 and reported_on=$7",
        [
          scope.workspaceId,
          action.sourceId,
          action.model,
          action.year,
          action.amountUsd,
          action.basis,
          action.reportedOn,
        ],
      )
    ).rows;
  if (action.type === "deal")
    parent.existing = data.deals.filter(
      (d) => d.requirementId === action.requirementId && d.aircraftId === action.aircraftId,
    );
  if (action.type === "execution") {
    const row = await db.query(
        "select id from aerion.execution_cases where workspace_id=$1 and requirement_id=$2",
        [scope.workspaceId, action.requirementId],
      ),
      caseId = row.rows[0]?.id ?? null;
    const change = action.action;
    if (change.type === "add-action") {
      const commercial = await commercialRevisionStateInTransaction(
        db,
        scope,
        action.requirementId,
      );
      if (
        commercial.transactions.length ||
        commercial.engagements.length ||
        commercial.requalificationRequired
      )
        parent.commercial = commercial;
      parent.existing = (
        await db.query(
          "select id from aerion.case_actions where case_id=$1 and kind=$2 and title=$3 and status='Open' order by id",
          [caseId, change.kind, change.title],
        )
      ).rows;
    }
    if (change.type === "shortlist" || change.type === "prepare-draft")
      parent.shortlist = (
        await db.query(
          "select decision,reason from aerion.shortlist_decisions where case_id=$1 and aircraft_id=$2",
          [caseId, change.aircraftId],
        )
      ).rows;
    if (change.type === "link-contact" || change.type === "prepare-draft")
      parent.linked = (
        await db.query(
          "select contact_id from aerion.case_contacts where case_id=$1 and contact_id=$2",
          [caseId, change.contactId],
        )
      ).rows;
    if (change.type === "prepare-draft")
      parent.drafts = (
        await db.query(
          "select id,status,context_hash from aerion.outreach_drafts where case_id=$1 and aircraft_id=$2 and contact_id=$3 and audience=$4 order by id",
          [caseId, change.aircraftId, change.contactId, change.audience],
        )
      ).rows;
  }
  return fingerprint(parent);
}
export function passagesForLabel(pages: SourcePage[], label: string) {
  const re = new RegExp(`^\\s*${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:\\s*(.+)$`, "i");
  return pages.flatMap((page) =>
    page.text.split(/\r?\n/).flatMap((line) => {
      const match = line.match(re);
      return match ? [{ value: match[1].trim(), page: page.page, quote: line.trim() }] : [];
    }),
  );
}

export async function validateInteractionParty(
  db: PoolClient,
  scope: Scope,
  action: ProposalAction,
  citations: Citation[],
) {
  if (action.type !== "interaction") return;
  const row = await db.query(
    "select c->>'email' as email from aerion.workspaces w cross join lateral jsonb_array_elements(w.data->'contacts') c where w.id=$1 and c->>'id'=$2",
    [scope.workspaceId, action.contactId],
  );
  if (!row.rows[0] || !containsValue(citations, row.rows[0].email))
    throw new HttpError(
      422,
      "The interaction evidence must explicitly identify this saved contact's email address.",
    );
}
