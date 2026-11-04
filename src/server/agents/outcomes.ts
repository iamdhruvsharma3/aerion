import type { AgentReport } from "../../lib/agents/schema";
import { HttpError } from "../http";

/** Reject an explicit first-person/tool-action claim when the validated proposal ledger is empty. */
export function validateActionClaim(report: AgentReport, stagedCount: number) {
  if (stagedCount > 0) return report;
  if (
    /^(?:(?:I|We|The agent)\s+(?:(?:have|has)\s+)?)?(?:successfully\s+)?(?:proposed|staged|created)\s+.{0,90}\b(?:record|action|proposal|draft|contact|requirement|comparable|follow-up)\b/i.test(
      report.summary.trim(),
    )
  )
    throw new HttpError(
      422,
      "The report claims a business action was proposed or created, but no validated proposal is staged. Call propose_action first when supported, or state explicitly that no action was staged and explain the missing evidence. A report sentence does not execute a tool.",
    );
  return report;
}
