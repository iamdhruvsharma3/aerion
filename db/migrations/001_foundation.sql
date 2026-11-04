create schema if not exists aerion;
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'aerion_runtime') then
    create role aerion_runtime nologin nosuperuser nobypassrls;
  end if;
end $$;
grant aerion_runtime to current_user;
grant usage on schema aerion to aerion_runtime;

create table aerion.workspaces (
  id uuid primary key,
  owner_id uuid not null unique,
  name text not null default 'Aerion workspace',
  data jsonb not null,
  revision integer not null default 0,
  created_at timestamptz not null default now()
);
create table aerion.sources (
  id uuid primary key,
  workspace_id uuid not null references aerion.workspaces(id),
  title text not null check (length(title) between 1 and 300),
  kind text not null check (kind in ('text','csv','pdf')),
  source_url text,
  filename text not null,
  content_type text not null,
  sha256 text not null,
  original bytea not null check (octet_length(original) <= 10000000),
  pages jsonb not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, sha256),
  unique (workspace_id, id)
);
create table aerion.extractions (
  id uuid primary key,
  workspace_id uuid not null references aerion.workspaces(id),
  source_id uuid not null,
  provider text not null check (provider in ('local','openai')),
  model text,
  prompt_version text not null default 'aircraft-v1',
  status text not null default 'queued' check (status in ('queued','running','completed','failed')),
  attempts integer not null default 0,
  lease_token uuid,
  leased_at timestamptz,
  output jsonb,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  foreign key (workspace_id, source_id) references aerion.sources(workspace_id,id),
  unique (workspace_id,id)
);
create unique index one_active_extraction on aerion.extractions(source_id) where status in ('queued','running');
create table aerion.reviews (
  id uuid primary key,
  workspace_id uuid not null references aerion.workspaces(id),
  source_id uuid not null,
  extraction_id uuid not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected')),
  facts jsonb not null,
  proposed jsonb not null,
  warnings jsonb not null,
  reviewed_at timestamptz,
  reviewer uuid,
  aircraft_id text,
  final_values jsonb,
  note text not null default '',
  created_at timestamptz not null default now(),
  foreign key (workspace_id, source_id) references aerion.sources(workspace_id,id),
  foreign key (workspace_id, extraction_id) references aerion.extractions(workspace_id,id)
);
create table aerion.activity (
  id uuid primary key,
  workspace_id uuid not null references aerion.workspaces(id),
  actor_id uuid not null,
  action text not null,
  record_id text,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index sources_workspace on aerion.sources(workspace_id,created_at desc);
create index extractions_workspace on aerion.extractions(workspace_id,created_at desc);
create index reviews_workspace on aerion.reviews(workspace_id,status);

alter table aerion.workspaces enable row level security;
alter table aerion.workspaces force row level security;
create policy owner_workspace on aerion.workspaces to aerion_runtime
  using (owner_id = nullif(current_setting('aerion.actor_id',true),'')::uuid)
  with check (owner_id = nullif(current_setting('aerion.actor_id',true),'')::uuid);
do $$ declare t text; begin
  foreach t in array array['sources','extractions','reviews','activity'] loop
    execute format('alter table aerion.%I enable row level security',t);
    execute format('alter table aerion.%I force row level security',t);
    execute format('create policy workspace_scope on aerion.%I to aerion_runtime using (workspace_id = nullif(current_setting(''aerion.workspace_id'',true),'''')::uuid and exists (select 1 from aerion.workspaces w where w.id = workspace_id)) with check (workspace_id = nullif(current_setting(''aerion.workspace_id'',true),'''')::uuid and exists (select 1 from aerion.workspaces w where w.id = workspace_id))',t);
  end loop;
end $$;
grant select, insert, update on aerion.workspaces,aerion.extractions,aerion.reviews to aerion_runtime;
grant select,insert on aerion.sources,aerion.activity to aerion_runtime;
-- No runtime DELETE, schema DDL, or activity/source mutation grants.
