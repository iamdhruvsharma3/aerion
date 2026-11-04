create table aerion.agent_runs (
 id uuid primary key,workspace_id uuid not null references aerion.workspaces(id),agent_id text not null,
 provider text not null check(provider in ('rules','openai','ollama')),model text,prompt_version text not null,
 status text not null default 'queued' check(status in ('queued','running','review','completed','needs-input','failed','cancelled')),
 input jsonb not null,idempotency_key uuid not null,dedupe_key text not null,
 attempts integer not null default 0,revision integer not null default 0,lease_token uuid,leased_at timestamptz,
 report jsonb,error text,usage jsonb,created_at timestamptz not null default now(),finished_at timestamptz,
 unique(workspace_id,id),unique(workspace_id,idempotency_key)
);
create unique index active_agent_run on aerion.agent_runs(workspace_id,agent_id,dedupe_key) where status in ('queued','running');
create index agent_run_history on aerion.agent_runs(workspace_id,created_at desc);
create table aerion.agent_steps (
 id uuid primary key,workspace_id uuid not null,run_id uuid not null,tool text not null,input jsonb not null,output jsonb not null,created_at timestamptz not null default now(),
 foreign key(workspace_id,run_id) references aerion.agent_runs(workspace_id,id)
);
create table aerion.agent_proposals (
 id uuid primary key,workspace_id uuid not null,run_id uuid not null,title text not null,reason text not null,action jsonb not null,citations jsonb not null,
 context_hash text not null,fingerprint text not null,status text not null default 'proposed' check(status in ('proposed','accepted','rejected','obsolete')),
 resolution_note text not null default '',reviewer uuid,resolved_at timestamptz,applied_ref text,
 foreign key(workspace_id,run_id) references aerion.agent_runs(workspace_id,id),unique(run_id,fingerprint)
);
create table aerion.source_connectors (
 id uuid primary key,workspace_id uuid not null references aerion.workspaces(id),name text not null,url text not null,
 format text not null check(format in ('page','feed','json','text')),purpose text not null check(purpose in ('aircraft','market')),
 enabled boolean not null default true,last_collected_at timestamptz,created_at timestamptz not null default now(),unique(workspace_id,url),unique(workspace_id,id)
);
create table aerion.agent_schedules (
 workspace_id uuid not null references aerion.workspaces(id),agent_id text not null,enabled boolean not null default false,
 provider text not null check(provider in ('rules','openai','ollama')),interval_hours integer not null check(interval_hours between 1 and 168),input jsonb not null,
 next_run_at timestamptz,updated_at timestamptz not null default now(),primary key(workspace_id,agent_id)
);
create table aerion.contact_interactions (
 id uuid primary key,workspace_id uuid not null references aerion.workspaces(id),contact_id text not null,requirement_id text,
 source_id uuid not null,occurred_on date not null,direction text not null check(direction in ('Inbound','Outbound')),summary text not null,
 reviewer uuid not null,created_at timestamptz not null default now(),foreign key(workspace_id,source_id) references aerion.sources(workspace_id,id),
 unique(workspace_id,contact_id,source_id,direction)
);
create table aerion.market_comparables (
 id uuid primary key,workspace_id uuid not null references aerion.workspaces(id),source_id uuid not null,
 manufacturer text not null,model text not null,year integer not null,amount_usd numeric not null check(amount_usd>0),
 basis text not null check(basis in ('Asking price','Sold price','Monthly lease')),reported_on date not null,notes text not null,
 citations jsonb not null,reviewer uuid not null,created_at timestamptz not null default now(),
 foreign key(workspace_id,source_id) references aerion.sources(workspace_id,id),unique(workspace_id,source_id,model,year,amount_usd,basis,reported_on)
);
do $$ declare t text; begin
 foreach t in array array['agent_runs','agent_steps','agent_proposals','source_connectors','agent_schedules','contact_interactions','market_comparables'] loop
  execute format('alter table aerion.%I enable row level security',t);
  execute format('alter table aerion.%I force row level security',t);
  execute format('create policy workspace_scope on aerion.%I to aerion_runtime using (workspace_id = nullif(current_setting(''aerion.workspace_id'',true),'''')::uuid and exists (select 1 from aerion.workspaces w where w.id=workspace_id)) with check (workspace_id = nullif(current_setting(''aerion.workspace_id'',true),'''')::uuid and exists (select 1 from aerion.workspaces w where w.id=workspace_id))',t);
 end loop;
end $$;
grant select,insert on aerion.agent_runs,aerion.agent_steps,aerion.agent_proposals,aerion.source_connectors,aerion.agent_schedules,aerion.contact_interactions,aerion.market_comparables to aerion_runtime;
grant update(status,attempts,revision,lease_token,leased_at,report,error,usage,finished_at) on aerion.agent_runs to aerion_runtime;
grant update(status,resolution_note,reviewer,resolved_at,applied_ref) on aerion.agent_proposals to aerion_runtime;
grant update(name,enabled,last_collected_at) on aerion.source_connectors to aerion_runtime;
grant update(enabled,provider,interval_hours,input,next_run_at,updated_at) on aerion.agent_schedules to aerion_runtime;
-- Retained inputs, proposal bodies, tool traces, interactions and comparable observations cannot be edited by the runtime.
