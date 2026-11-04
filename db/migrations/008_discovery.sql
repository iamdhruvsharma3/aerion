-- Search metadata never substitutes for a retained publisher page.
create table aerion.discovery_searches (
 id uuid primary key, workspace_id uuid not null, run_id uuid not null,
 provider text not null check(provider in ('brave','urls')), query text not null,
 status text not null default 'pending' check(status in ('pending','completed','failed')),
 original bytea, error text, created_at timestamptz not null default now(),
 unique(workspace_id,id), unique(workspace_id,run_id),
 foreign key(workspace_id,run_id) references aerion.agent_runs(workspace_id,id)
);
create table aerion.discovery_results (
 id uuid primary key, workspace_id uuid not null, search_id uuid not null,
 rank integer not null check(rank between 1 and 6), url text not null, title text not null, snippet text not null,
 status text not null default 'unread' check(status in ('unread','collecting','retained','failed')),
 source_id uuid, error text, created_at timestamptz not null default now(),
 unique(workspace_id,id), unique(search_id,url),
 foreign key(workspace_id,search_id) references aerion.discovery_searches(workspace_id,id),
 foreign key(workspace_id,source_id) references aerion.sources(workspace_id,id),
 check((status='retained')=(source_id is not null))
);
create table aerion.discovery_leads (
 id uuid primary key, workspace_id uuid not null, run_id uuid not null, result_id uuid not null, source_id uuid not null,
 url text not null, values jsonb not null, citations jsonb not null, dedupe_key text not null,
 reviewer uuid not null, created_at timestamptz not null default now(),
 unique(workspace_id,dedupe_key),
 foreign key(workspace_id,run_id) references aerion.agent_runs(workspace_id,id),
 foreign key(workspace_id,result_id) references aerion.discovery_results(workspace_id,id),
 foreign key(workspace_id,source_id) references aerion.sources(workspace_id,id)
);
create index discovery_history on aerion.discovery_searches(workspace_id,created_at desc);
create index discovery_lead_history on aerion.discovery_leads(workspace_id,created_at desc);
do $$ declare t text; begin
 foreach t in array array['discovery_searches','discovery_results','discovery_leads'] loop
  execute format('alter table aerion.%I enable row level security',t);
  execute format('alter table aerion.%I force row level security',t);
  execute format('create policy workspace_scope on aerion.%I to aerion_runtime using (workspace_id = nullif(current_setting(''aerion.workspace_id'',true),'''')::uuid and exists (select 1 from aerion.workspaces w where w.id=workspace_id)) with check (workspace_id = nullif(current_setting(''aerion.workspace_id'',true),'''')::uuid and exists (select 1 from aerion.workspaces w where w.id=workspace_id))',t);
 end loop;
end $$;
grant select,insert on aerion.discovery_searches,aerion.discovery_results,aerion.discovery_leads to aerion_runtime;
grant update(status,original,error) on aerion.discovery_searches to aerion_runtime;
grant update(status,source_id,error) on aerion.discovery_results to aerion_runtime;
-- Lead evidence is immutable. Qualification happens through the existing buyer/seller workflows.
