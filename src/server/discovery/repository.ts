import type { DiscoveryCenter } from "../../lib/discovery/schema";
import { agentProviderIds } from "../../lib/agents/providers";
import { runInputSchema } from "../../lib/agents/schema";
import { transaction, type Scope } from "../db";
import { providerConfiguration } from "../agents/providers";
import { searchConfiguration } from "./search";

export async function readDiscoveryCenter(scope: Scope): Promise<DiscoveryCenter> {
  return transaction(scope.actorId, scope.workspaceId, async (db) => {
    const runs = await db.query(
      `select r.id,r.agent_id as "agentId",r.provider,r.model,r.status,r.input,r.attempts,r.revision,r.report,r.error,r.usage,r.created_at as "createdAt",r.finished_at as "finishedAt",s.id as "searchId",s.status as "searchStatus",s.created_at as "searchedAt",s.error as "searchError" from aerion.agent_runs r left join aerion.discovery_searches s on s.run_id=r.id and s.workspace_id=r.workspace_id where r.workspace_id=$1 and r.input ? 'discovery' order by r.created_at desc,r.id desc limit 40`,
      [scope.workspaceId],
    );
    const results = await db.query(
      `select r.id,r.search_id as "searchId",r.rank,r.url,r.title,r.snippet,r.status,r.source_id as "sourceId",r.error from aerion.discovery_results r where r.workspace_id=$1 and r.search_id=any($2::uuid[]) order by r.rank`,
      [scope.workspaceId, runs.rows.map((row) => row.searchId).filter(Boolean)],
    );
    const proposals = await db.query(
      `select p.id,p.run_id as "runId",p.title,p.reason,p.action,p.citations,p.status,p.resolution_note as "resolutionNote",p.applied_ref as "appliedRef",r.revision as "runRevision",d.url as "sourceUrl" from aerion.agent_proposals p join aerion.agent_runs r on r.id=p.run_id and r.workspace_id=p.workspace_id join aerion.discovery_results d on d.id=(p.action->>'resultId')::uuid and d.workspace_id=p.workspace_id where p.workspace_id=$1 and p.action->>'type'='lead' and p.status='proposed' order by r.created_at desc,p.id limit 100`,
      [scope.workspaceId],
    );
    const leads = await db.query(
      'select id,run_id as "runId",source_id as "sourceId",url,values,citations,created_at as "createdAt" from aerion.discovery_leads where workspace_id=$1 order by created_at desc,id desc limit 100',
      [scope.workspaceId],
    );
    const counts = (
      await db.query(
        `select (select count(*)::int from aerion.agent_runs where workspace_id=$1 and input ? 'discovery') as runs,(select count(*)::int from aerion.agent_proposals where workspace_id=$1 and action->>'type'='lead' and status='proposed') as pending,(select count(*)::int from aerion.discovery_leads where workspace_id=$1) as saved,(select count(distinct source_id)::int from aerion.discovery_results where workspace_id=$1 and status='retained') as pages`,
        [scope.workspaceId],
      )
    ).rows[0];
    return {
      search: searchConfiguration(),
      providers: agentProviderIds.map((id) => ({ id, ...providerConfiguration(id) })),
      sessions: runs.rows.map(({ searchId, searchStatus, searchedAt, searchError, ...run }) => ({
        run: { ...run, input: runInputSchema.parse(run.input) },
        searchStatus,
        searchedAt,
        error: searchError,
        results: results.rows
          .filter((result) => result.searchId === searchId)
          .map(({ searchId: _id, ...result }) => result),
      })),
      proposals: proposals.rows,
      leads: leads.rows,
      counts,
    };
  });
}
