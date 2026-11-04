create table aerion.operations_settings (
 workspace_id uuid primary key references aerion.workspaces(id), revision integer not null default 0,
 paused boolean not null default false,
 max_model_jobs integer not null default 25 check(max_model_jobs between 1 and 500),
 max_agent_tokens integer not null default 1000000 check(max_agent_tokens between 1000 and 100000000),
 max_searches integer not null default 50 check(max_searches between 1 and 1000),
 max_mail integer not null default 25 check(max_mail between 1 and 500),
 note text not null default '', updated_at timestamptz not null default now()
);
create table aerion.worker_heartbeats (
 id uuid primary key, started_at timestamptz not null default now(),
 seen_at timestamptz not null default now(), stopped_at timestamptz
);
create table aerion.agent_validations (
 id uuid primary key, workspace_id uuid not null references aerion.workspaces(id),
 agent_id text not null check(agent_id in ('aircraft-discovery','aircraft-intelligence','buyer-discovery','buyer-requirements','matching','outreach','communication','documents','due-diligence','deal-coordination','negotiation','crm')),
 provider text not null, model text, source_run_id uuid not null,
 status text not null check(status in ('passed','failed')), origin text not null check(origin in ('live-fixture','operational-run')),
 report_hash text not null check(length(report_hash)=64), result jsonb not null,
 checked_at timestamptz not null default now(), unique(workspace_id,source_run_id)
);
create table aerion.backup_events (
 id uuid primary key, created_at timestamptz not null default now(), verified_at timestamptz,
 archive_path text not null, byte_size bigint not null check(byte_size>0), sha256 text not null check(length(sha256)=64),
 verification jsonb not null default '{}'::jsonb
);
do $$ declare t text; begin
 foreach t in array array['operations_settings','agent_validations'] loop
  execute format('alter table aerion.%I enable row level security',t);
  execute format('alter table aerion.%I force row level security',t);
  execute format('create policy workspace_scope on aerion.%I to aerion_runtime using (workspace_id=nullif(current_setting(''aerion.workspace_id'',true),'''')::uuid and exists(select 1 from aerion.workspaces w where w.id=workspace_id)) with check (workspace_id=nullif(current_setting(''aerion.workspace_id'',true),'''')::uuid and exists(select 1 from aerion.workspaces w where w.id=workspace_id))',t);
 end loop;
 foreach t in array array['worker_heartbeats','backup_events'] loop
  execute format('alter table aerion.%I enable row level security',t);
  execute format('alter table aerion.%I force row level security',t);
  execute format('create policy authenticated_health_read on aerion.%I for select to aerion_runtime using (exists(select 1 from aerion.workspaces w where w.id=nullif(current_setting(''aerion.workspace_id'',true),'''')::uuid))',t);
 end loop;
end $$;
grant select,insert on aerion.operations_settings,aerion.agent_validations to aerion_runtime;
grant update(revision,paused,max_model_jobs,max_agent_tokens,max_searches,max_mail,note,updated_at) on aerion.operations_settings to aerion_runtime;
grant select on aerion.worker_heartbeats to aerion_runtime;
grant select(id,created_at,verified_at,byte_size,sha256,verification) on aerion.backup_events to aerion_runtime;
create index agent_validation_history on aerion.agent_validations(workspace_id,agent_id,checked_at desc);
