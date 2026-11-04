alter table aerion.discovery_leads add unique(workspace_id,id);
create table aerion.lead_cases (
 workspace_id uuid not null,lead_id uuid not null,revision integer not null default 0,
 status text not null default 'Research' check(status in ('Research','Qualifying','Dismissed')),
 contact_id text,requirement_id text,next_action text not null default '',due_on date,
 updated_at timestamptz not null default now(),primary key(workspace_id,lead_id),
 foreign key(workspace_id,lead_id) references aerion.discovery_leads(workspace_id,id)
);
insert into aerion.lead_cases(workspace_id,lead_id) select workspace_id,id from aerion.discovery_leads;
create table aerion.lead_sources (
 workspace_id uuid not null,lead_id uuid not null,source_id uuid not null,purpose text not null check(purpose in ('Original','Contact','Buyer brief','Other')),
 created_at timestamptz not null default now(),primary key(workspace_id,lead_id,source_id,purpose),
 foreign key(workspace_id,lead_id) references aerion.discovery_leads(workspace_id,id),
 foreign key(workspace_id,source_id) references aerion.sources(workspace_id,id)
);
insert into aerion.lead_sources(workspace_id,lead_id,source_id,purpose) select workspace_id,id,source_id,'Original' from aerion.discovery_leads;
create table aerion.lead_enrichments (
 id uuid primary key,workspace_id uuid not null,lead_id uuid not null,run_id uuid not null,result_id uuid not null,source_id uuid not null,
 values jsonb not null,citations jsonb not null,dedupe_key text not null,reviewer uuid not null,created_at timestamptz not null default now(),
 unique(workspace_id,dedupe_key),
 foreign key(workspace_id,lead_id) references aerion.discovery_leads(workspace_id,id),
 foreign key(workspace_id,run_id) references aerion.agent_runs(workspace_id,id),
 foreign key(workspace_id,result_id) references aerion.discovery_results(workspace_id,id),
 foreign key(workspace_id,source_id) references aerion.sources(workspace_id,id)
);
create table aerion.lead_drafts (
 id uuid primary key,workspace_id uuid not null,lead_id uuid not null,contact_id text not null,recipient text not null,
 subject text not null,body text not null,context_hash text not null,draft_key text not null,
 status text not null default 'Prepared' check(status in ('Prepared','Reviewed','Archived')),
 review_note text not null default '',reviewer uuid,created_at timestamptz not null default now(),reviewed_at timestamptz,
 unique(workspace_id,id),unique(workspace_id,lead_id,draft_key),
 foreign key(workspace_id,lead_id) references aerion.discovery_leads(workspace_id,id)
);
do $$ declare t text; begin
 foreach t in array array['lead_cases','lead_sources','lead_enrichments','lead_drafts'] loop
  execute format('alter table aerion.%I enable row level security',t);
  execute format('alter table aerion.%I force row level security',t);
  execute format('create policy workspace_scope on aerion.%I to aerion_runtime using (workspace_id = nullif(current_setting(''aerion.workspace_id'',true),'''')::uuid and exists (select 1 from aerion.workspaces w where w.id=workspace_id)) with check (workspace_id = nullif(current_setting(''aerion.workspace_id'',true),'''')::uuid and exists (select 1 from aerion.workspaces w where w.id=workspace_id))',t);
 end loop;
end $$;
grant select,insert on aerion.lead_cases,aerion.lead_sources,aerion.lead_enrichments,aerion.lead_drafts to aerion_runtime;
grant update(revision,status,contact_id,requirement_id,next_action,due_on,updated_at) on aerion.lead_cases to aerion_runtime;
grant update(status,review_note,reviewer,reviewed_at) on aerion.lead_drafts to aerion_runtime;
alter table aerion.mail_deliveries alter column draft_id drop not null;
alter table aerion.mail_deliveries alter column requirement_id drop not null;
alter table aerion.mail_deliveries add column lead_draft_id uuid;
alter table aerion.mail_deliveries add foreign key(workspace_id,lead_draft_id) references aerion.lead_drafts(workspace_id,id);
alter table aerion.mail_deliveries add check((draft_id is null)<>(lead_draft_id is null));
alter table aerion.mail_deliveries add unique(workspace_id,lead_draft_id);
