import type { AgentReport } from "../../lib/agents/schema";
import { revenueMoney } from "../../lib/revenue/money";
import { isTerminal, nextTransactionStage, transactionGaps } from "../../lib/transactions/schema";
import type { CommercialContext } from "./commercial-context";

type FollowUp = { title: string; detail: string; dueDate: string | null };
type Role = "due-diligence" | "deal-coordination";

/** Deterministic observations of saved records; never an approval, earning decision or message. */
export function commercialInsights(context: CommercialContext, today: string, role: Role) {
  const findings: AgentReport["findings"] = [],
    tasks: FollowUp[] = [];
  const add = (title: string, detail: string, severity: "info" | "review" | "missing" = "review") =>
    findings.push({
      title: title.slice(0, 300),
      detail: detail.slice(0, 4000),
      severity,
      citations: [],
    });
  const task = (title: string, detail: string, dueDate: string | null = null) => {
    if (!tasks.some((item) => item.title === title))
      tasks.push({ title: title.slice(0, 300), detail: detail.slice(0, 2000), dueDate });
  };
  for (const deal of context.transactions.filter((item) => item.managed)) {
    const status = deal.status;
    if (!status) continue;
    const label = `${deal.title.slice(0, 90)} · ${deal.dealId}`;
    add(
      `Transaction: ${deal.title}`,
      `Recorded ${deal.status}, cycle ${deal.cycle}. ${deal.completedOn ? `Completion dated ${deal.completedOn}. ` : ""}The recorded transaction state is separate from fee earning and payment.`,
      "info",
    );
    if (deal.contextChanged || deal.supersededRequirement) {
      add(
        `Requalification required: ${deal.title}`,
        "The transaction's linked scope or buyer context changed. Historical records remain retained; they cannot establish current completion or a new closing fee.",
        "missing",
      );
      if (!isTerminal(status))
        task(
          `Review transaction context: ${label}`,
          "Review the current buyer brief and serial-specific opportunity before further commercial work. Use the transaction workspace to resolve the context; do not infer approval or completion.",
        );
      continue;
    }
    if (
      !["Lost", "Cancelled"].includes(status) &&
      !context.revisionState.engagements.some((item) => item.dealId === deal.dealId)
    ) {
      add(
        `Fee agreement not linked: ${deal.title}`,
        "No client engagement is linked to this serial-specific opportunity. Review any actual agreement with the client and fee payer before treating a potential fee as entitlement.",
        "missing",
      );
      if (role === "deal-coordination")
        task(
          `Review fee engagement: ${label}`,
          "Review actual fee terms, the payer and earning/payment conditions. Retain the signed source and record its review in Revenue. Do not backdate an agreement or infer entitlement from aircraft value or completion.",
        );
    }
    if (isTerminal(status)) continue;
    if (role === "deal-coordination" && deal.nextAction)
      task(`Transaction follow-up: ${label}`, deal.nextAction, deal.dueOn);
    const target = nextTransactionStage(status);
    if (target && deal.cycle !== null) {
      const cycle = deal.cycle;
      const gaps = transactionGaps(
        {
          cycle,
          contextChanged: false,
          offers: deal.offers.map((offer) => ({ ...offer, cycle })),
          evidence: deal.milestones.map((item) => ({ ...item, cycle, current: true })),
          findings: deal.findings.map((item) => ({ ...item, cycle })),
        },
        target,
      ).filter((gap) => !deal.coverage.offers.truncated || !/offer/i.test(gap));
      for (const gap of gaps) add(`Before ${target}: ${deal.title}`, gap, "missing");
      if (gaps.length && role === "due-diligence")
        task(`Review ${target} prerequisites: ${label}`, gaps.join("\n"));
    }
    for (const finding of deal.findings) {
      add(
        `${finding.severity} finding: ${finding.title}`,
        `${deal.title} · ${finding.category}. ${finding.detail}${finding.dueOn ? ` Due ${finding.dueOn}.` : ""}`,
        finding.severity === "Blocking" ? "missing" : "review",
      );
      task(
        `Resolve finding: ${finding.title.slice(0, 90)} · ${finding.id}`,
        `Review the recorded ${finding.category} issue in ${deal.title}, retain the response and record the accountable resolution. ${finding.detail}`,
        finding.dueOn,
      );
    }
    for (const offer of deal.offers.filter(
      (item) => item.status === "Recorded" && item.expiresOn,
    )) {
      const due = offer.expiresOn;
      if (!due) continue;
      const label =
        due < today ? "Expired offer" : due === today ? "Offer expires today" : "Offer expiry";
      add(
        `${label}: ${deal.title}`,
        `${offer.side} ${offer.offerKind.toLowerCase()} ${offer.id}, ${offer.currency} ${offer.amount} per aircraft (${offer.basis}), expires ${due}. Recorded terms are not an acceptance.`,
        "review",
      );
      if (role === "deal-coordination")
        task(
          `Review offer expiry: ${offer.id}`,
          `Check the recorded offer and its expiry in ${deal.title}. Obtain a retained response or replacement version; do not assume the expired offer remains open.`,
          due,
        );
    }
  }
  for (const engagement of context.engagements) {
    add(
      `Engagement: ${engagement.title}`,
      `Recorded ${engagement.effectiveStatus}; trigger ${engagement.earningTrigger}. Recorded earned fees ${revenueMoney(engagement.totals.earnedMinor, engagement.currency)}; allocated receipts ${revenueMoney(engagement.totals.receivedMinor, engagement.currency)}. These are separate recorded events.`,
      "info",
    );
    if (engagement.status === "Draft") {
      add(
        `Unsigned engagement: ${engagement.title}`,
        "The engagement is still Draft. A proposed fee and draft terms do not establish a signed agreement or entitlement.",
        "missing",
      );
      if (role === "deal-coordination")
        task(
          `Review engagement activation: ${engagement.id}`,
          "Review the actual client/payer agreement, retain the signed document and confirm the supplied terms before activating it. Do not manufacture a signatory or signature.",
        );
      continue;
    }
    if (role !== "deal-coordination") continue;
    const transaction = context.transactions.find((item) => item.dealId === engagement.dealId);
    if (BigInt(engagement.totals.earnedMinor) === 0n && engagement.earningTrigger === "Closing") {
      const current =
        transaction?.status === "Completed" &&
        !transaction.contextChanged &&
        !transaction.supersededRequirement &&
        transaction.completionSourceId;
      add(
        `Closing fee condition: ${engagement.title}`,
        current
          ? "Current completion evidence is recorded, but no earned fee has been recorded. Review the actual agreement and event evidence before deciding whether the fee was earned."
          : "No current eligible completion is established in the returned transaction context. A closing fee must not be inferred from the legacy opportunity stage.",
        current ? "review" : "missing",
      );
      if (current)
        task(
          `Review earning evidence: ${engagement.id}`,
          `Inspect the signed earning condition and retained completion source for ${engagement.title}. Record an earning only if the actual agreed event occurred.`,
        );
    }
    if (BigInt(engagement.totals.earnedMinor) > BigInt(engagement.totals.invoicedMinor))
      task(
        `Review invoice eligibility: ${engagement.id}`,
        `A recorded earning exceeds active invoiced fee subtotals for ${engagement.title}. Check current agreement dates, transaction cycle and evidence before issuing an invoice.`,
      );
    for (const invoice of engagement.invoices.filter(
      (item) => item.status === "Issued" && BigInt(item.outstandingMinor) > 0n,
    )) {
      const due =
        invoice.dueOn < today
          ? "Overdue invoice"
          : invoice.dueOn === today
            ? "Invoice due today"
            : "Outstanding invoice";
      add(
        `${due}: ${invoice.number}`,
        `${engagement.title}: ${revenueMoney(invoice.outstandingMinor, engagement.currency)} outstanding; due ${invoice.dueOn}. An issued invoice is not a received payment.`,
        "review",
      );
      task(
        `Review invoice payment: ${invoice.id}`,
        `Review ${invoice.number}, its due date and actual payment evidence. Confirm any follow-up content before sending; allocate a receipt only after funds actually arrive.`,
        invoice.dueOn,
      );
    }
  }
  const omitted =
    context.coverage.transactions.truncated +
    context.coverage.engagements.truncated +
    context.transactions.reduce(
      (sum, item) => sum + item.coverage.offers.truncated + item.coverage.findings.truncated,
      0,
    ) +
    context.engagements.reduce(
      (sum, item) => sum + item.coverage.invoices.truncated + item.coverage.earnings.truncated,
      0,
    );
  if (omitted || tasks.length > 8 || findings.length > 35)
    findings.unshift({
      title: "Commercial review is bounded",
      detail: `${omitted} linked records exceed this context's display limits. This report shows at most 35 commercial findings and prepares at most 8 follow-up proposals. Inspect the full transaction and Revenue workspaces before concluding that no other work is needed.`,
      severity: "review",
      citations: [],
    });
  return { findings: findings.slice(0, 35), tasks: tasks.slice(0, 8) };
}
