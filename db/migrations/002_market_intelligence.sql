alter table aerion.extractions add column purpose text not null default 'aircraft'
  check (purpose in ('aircraft','market'));
drop index aerion.one_active_extraction;
create unique index one_active_extraction on aerion.extractions(source_id,purpose)
  where status in ('queued','running');

create table aerion.signals (
  id uuid primary key,
  workspace_id uuid not null references aerion.workspaces(id),
  source_id uuid not null,
  extraction_id uuid not null,
  fingerprint text not null,
  facts jsonb not null,
  proposed jsonb not null,
  warnings jsonb not null,
  confidence text not null check (confidence in ('Stated','Incomplete','Conflicting')),
  stage text not null default 'Signal' check (stage in ('Signal','Lead','Potential requirement','Confirmed requirement','Dismissed')),
  final_values jsonb,
  revision integer not null default 0,
  note text not null default '',
  reviewer uuid,
  reviewed_at timestamptz,
  confirmation jsonb,
  requirement_id text,
  created_at timestamptz not null default now(),
  foreign key (workspace_id,source_id) references aerion.sources(workspace_id,id),
  foreign key (workspace_id,extraction_id) references aerion.extractions(workspace_id,id),
  unique(workspace_id,source_id,fingerprint),
  unique(workspace_id,requirement_id),
  check ((stage='Confirmed requirement') = (requirement_id is not null)),
  check (stage <> 'Confirmed requirement' or confirmation is not null)
);
create index signals_workspace on aerion.signals(workspace_id,stage,created_at desc);
alter table aerion.signals enable row level security;
alter table aerion.signals force row level security;
create policy workspace_scope on aerion.signals to aerion_runtime
 using (workspace_id = nullif(current_setting('aerion.workspace_id',true),'')::uuid
   and exists (select 1 from aerion.workspaces w where w.id=workspace_id))
 with check (workspace_id = nullif(current_setting('aerion.workspace_id',true),'')::uuid
   and exists (select 1 from aerion.workspaces w where w.id=workspace_id));
grant select,insert on aerion.signals to aerion_runtime;
-- Retain the original extracted observations; only review fields may change.
grant update(stage,final_values,revision,note,reviewer,reviewed_at,confirmation,requirement_id)
 on aerion.signals to aerion_runtime;
