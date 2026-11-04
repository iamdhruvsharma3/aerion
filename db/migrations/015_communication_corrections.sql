-- Corrections change routing prospectively; prior source links, briefs and commercial history remain retained.
create table aerion.communication_assignment_corrections (
 id uuid primary key,workspace_id uuid not null,message_id uuid not null,
 prior_lead_id uuid not null,lead_id uuid not null,prior_requirement_id text,
 source_ids jsonb not null,reviewer uuid not null,review_note text not null,
 created_at timestamptz not null default now(),unique(workspace_id,id),
 foreign key(workspace_id,message_id) references aerion.communication_messages(workspace_id,id) on delete cascade,
 foreign key(workspace_id,prior_lead_id) references aerion.discovery_leads(workspace_id,id),
 foreign key(workspace_id,lead_id) references aerion.discovery_leads(workspace_id,id),
 check(prior_lead_id<>lead_id)
);
create index communication_assignment_history on aerion.communication_assignment_corrections(workspace_id,message_id,created_at desc);
create index communication_assignment_prior_brief on aerion.communication_assignment_corrections(workspace_id,prior_requirement_id);
alter table aerion.communication_assignment_corrections enable row level security;
alter table aerion.communication_assignment_corrections force row level security;
create policy workspace_scope on aerion.communication_assignment_corrections to aerion_runtime
 using(workspace_id=nullif(current_setting('aerion.workspace_id',true),'')::uuid and exists(select 1 from aerion.workspaces w where w.id=workspace_id))
 with check(workspace_id=nullif(current_setting('aerion.workspace_id',true),'')::uuid and exists(select 1 from aerion.workspaces w where w.id=workspace_id));
grant select,insert on aerion.communication_assignment_corrections to aerion_runtime;
