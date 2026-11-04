-- Retained mail headers provide routing hints, never sender authentication.
create table aerion.communication_messages (
 id uuid primary key,workspace_id uuid not null,source_id uuid not null,
 message_id text,sender text not null,recipients jsonb not null,subject text not null,
 in_reply_to jsonb not null,reference_ids jsonb not null,direction text not null check(direction in ('Inbound','Outbound','Unknown')),
 classification text not null check(classification in ('Message','Auto reply','Delivery report')),
 suggested_lead_ids jsonb not null,matched_delivery_ids jsonb not null,routing_basis text not null,
 state text not null check(state in ('Unassigned','Suggested','Ambiguous','Linked','Dismissed')),
 lead_id uuid,revision integer not null default 0,reviewer uuid,review_note text not null default '',
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,source_id),
 foreign key(workspace_id,source_id) references aerion.sources(workspace_id,id) on delete cascade,
 foreign key(workspace_id,lead_id) references aerion.discovery_leads(workspace_id,id),
 check((state='Linked')=(lead_id is not null))
);
create index communication_inbox on aerion.communication_messages(workspace_id,state,created_at desc);
create table aerion.communication_analyses (
 workspace_id uuid not null,message_id uuid not null,run_id uuid not null,lead_id uuid not null,
 prior_requirement_id text,kind text not null check(kind in ('Initial brief','Revised brief','Communication')),
 created_at timestamptz not null default now(),primary key(workspace_id,message_id,run_id),unique(workspace_id,run_id),
 foreign key(workspace_id,message_id) references aerion.communication_messages(workspace_id,id) on delete cascade,
 foreign key(workspace_id,run_id) references aerion.agent_runs(workspace_id,id) on delete cascade,
 foreign key(workspace_id,lead_id) references aerion.discovery_leads(workspace_id,id)
);
create table aerion.communication_brief_revisions (
 id uuid primary key,workspace_id uuid not null,message_id uuid not null,run_id uuid not null,lead_id uuid not null,
 prior_requirement_id text not null,requirement_id text not null,reviewer uuid not null,review_note text not null,
 created_at timestamptz not null default now(),unique(workspace_id,run_id),
 foreign key(workspace_id,message_id,run_id) references aerion.communication_analyses(workspace_id,message_id,run_id) on delete cascade,
 foreign key(workspace_id,lead_id) references aerion.discovery_leads(workspace_id,id)
);
create table aerion.communication_suppressions (
 workspace_id uuid not null,email text not null,source_id uuid not null,reason text not null,
 active boolean not null default true,revision integer not null default 0,reviewer uuid not null,
 review_note text not null,created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 primary key(workspace_id,email),
 foreign key(workspace_id,source_id) references aerion.sources(workspace_id,id) on delete cascade
);
do $$ declare t text; begin
 foreach t in array array['communication_messages','communication_analyses','communication_brief_revisions','communication_suppressions'] loop
  execute format('alter table aerion.%I enable row level security',t);
  execute format('alter table aerion.%I force row level security',t);
  execute format('create policy workspace_scope on aerion.%I to aerion_runtime using (workspace_id=nullif(current_setting(''aerion.workspace_id'',true),'''')::uuid and exists(select 1 from aerion.workspaces w where w.id=workspace_id)) with check (workspace_id=nullif(current_setting(''aerion.workspace_id'',true),'''')::uuid and exists(select 1 from aerion.workspaces w where w.id=workspace_id))',t);
 end loop;
end $$;
grant select,insert on aerion.communication_messages,aerion.communication_analyses,aerion.communication_brief_revisions,aerion.communication_suppressions to aerion_runtime;
grant update(state,lead_id,revision,reviewer,review_note,updated_at) on aerion.communication_messages to aerion_runtime;
grant update(active,revision,reviewer,review_note,updated_at) on aerion.communication_suppressions to aerion_runtime;
