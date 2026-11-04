import type { PoolClient } from "pg";
import type { ProposalAction, RunInput } from "../../lib/agents/schema";
import type { Scope } from "../db";
import { HttpError } from "../http";
import { retiredReplySourceIds } from "../communication/context";

export async function validateLeadAction(
  db: PoolClient,
  scope: Scope,
  runId: string,
  input: RunInput,
  action: ProposalAction,
) {
  if (input.leadId) {
    const retired = await retiredReplySourceIds(db, scope, input.leadId);
    if (input.sourceIds.some((id) => retired.has(id))) throw new HttpError(422, "This run includes a reply corrected to another lead. Review current assignment and start a new analysis.");
  }
  if (action.type === "lead" && input.discovery?.side === "Buyer") {
    const required = {
      Demand: "Stated demand",
      Fleet: "Fleet activity",
      Profiles: "Business profile",
    }[input.discovery.buyerIntent ?? "Demand"];
    if (action.values.basis !== required)
      throw new HttpError(
        422,
        `This buyer run requires ${required} evidence. Do not relabel a seller listing or invent demand; report missing results instead.`,
      );
  }
  if (action.type === "requirement" && (input.leadId || action.leadId)) {
    if (!input.leadId || action.leadId !== input.leadId)
      throw new HttpError(422, "Bind the requirement to the selected lead ID.");
    const row = (
      await db.query(
        "select c.status,c.requirement_id,l.values from aerion.lead_cases c join aerion.discovery_leads l on l.id=c.lead_id and l.workspace_id=c.workspace_id where c.workspace_id=$1 and c.lead_id=$2",
        [scope.workspaceId, input.leadId],
      )
    ).rows[0];
    if (!row || row.status === "Dismissed" || row.values.side !== "Buyer")
      throw new HttpError(422, "This lead is not available for a buyer brief.");
    if (row.requirement_id) throw new HttpError(409, "This lead already has a buyer brief.");
  }
  if (action.type !== "lead-enrichment") return;
  if (
    input.leadId !== action.leadId ||
    input.discovery?.purpose !== "contacts" ||
    input.agentId !== "crm"
  )
    throw new HttpError(
      422,
      "Contact enrichment belongs to this lead's authorized CRM research run.",
    );
  const row = (
    await db.query(
      "select l.values,c.status from aerion.discovery_leads l join aerion.lead_cases c on c.lead_id=l.id and c.workspace_id=l.workspace_id where l.workspace_id=$1 and l.id=$2",
      [scope.workspaceId, action.leadId],
    )
  ).rows[0];
  if (!row || row.status === "Dismissed")
    throw new HttpError(422, "This lead is not available for contact research.");
  const normalize = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  if (
    !row.values.organization ||
    normalize(row.values.organization) !== normalize(action.values.organization)
  )
    throw new HttpError(
      422,
      "Research must retain the selected organization's name. Do not substitute a publisher, directory or unrelated company.",
    );
  const result = await db.query(
    "select r.id from aerion.discovery_results r join aerion.discovery_searches s on s.id=r.search_id and s.workspace_id=r.workspace_id where r.workspace_id=$1 and r.id=$2 and r.source_id=$3 and r.status='retained' and s.run_id=$4",
    [scope.workspaceId, action.resultId, action.sourceId, runId],
  );
  if (!result.rows.length)
    throw new HttpError(
      422,
      "Enrichment must cite a publisher page inspected by this research run.",
    );
}
