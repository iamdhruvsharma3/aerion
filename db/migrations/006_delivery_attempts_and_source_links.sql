alter table aerion.mail_deliveries add column attempts integer not null default 0;
alter table aerion.mail_deliveries add column revision integer not null default 0;
grant update(attempts,revision) on aerion.mail_deliveries to aerion_runtime;
create table aerion.source_links (
 workspace_id uuid not null,parent_id uuid not null,child_id uuid not null,relation text not null check(relation in ('attachment','ocr-transcript')),
 created_at timestamptz not null default now(),primary key(parent_id,child_id,relation),
 foreign key(workspace_id,parent_id) references aerion.sources(workspace_id,id),foreign key(workspace_id,child_id) references aerion.sources(workspace_id,id),check(parent_id<>child_id)
);
alter table aerion.source_links enable row level security;
alter table aerion.source_links force row level security;
create policy workspace_scope on aerion.source_links to aerion_runtime using (workspace_id=nullif(current_setting('aerion.workspace_id',true),'')::uuid and exists(select 1 from aerion.workspaces w where w.id=workspace_id)) with check (workspace_id=nullif(current_setting('aerion.workspace_id',true),'')::uuid and exists(select 1 from aerion.workspaces w where w.id=workspace_id));
grant select,insert on aerion.source_links to aerion_runtime;
