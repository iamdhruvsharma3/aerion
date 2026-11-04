create table aerion.execution_cases (
  id uuid primary key,
  workspace_id uuid not null references aerion.workspaces(id),
  requirement_id text not null,
  revision integer not null default 0,
  confirmation jsonb,
  created_at timestamptz not null default now(),
  unique(workspace_id,requirement_id),
  unique(workspace_id,id)
);
create table aerion.case_contacts (
  workspace_id uuid not null,
  case_id uuid not null,
  contact_id text not null,
  created_at timestamptz not null default now(),
  primary key(case_id,contact_id),
  foreign key(workspace_id,case_id) references aerion.execution_cases(workspace_id,id)
);
create table aerion.shortlist_decisions (
  workspace_id uuid not null,
  case_id uuid not null,
  aircraft_id text not null,
  decision text not null check(decision in ('Shortlisted','Rejected','Undecided')),
  reason text not null,
  actor_id uuid not null,
  updated_at timestamptz not null default now(),
  primary key(case_id,aircraft_id),
  foreign key(workspace_id,case_id) references aerion.execution_cases(workspace_id,id)
);
create table aerion.outreach_drafts (
  id uuid primary key,
  workspace_id uuid not null,
  case_id uuid not null,
  aircraft_id text not null,
  contact_id text not null,
  audience text not null check(audience in ('Buyer','Seller')),
  subject text not null,
  body text not null,
  claims jsonb not null,
  context_hash text not null,
  status text not null default 'Prepared' check(status in ('Prepared','Reviewed','Archived')),
  review_note text not null default '',
  reviewer uuid,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key(workspace_id,case_id) references aerion.execution_cases(workspace_id,id),
  unique(case_id,aircraft_id,contact_id,audience,context_hash),
  unique(workspace_id,id)
);
create table aerion.case_actions (
  id uuid primary key,
  workspace_id uuid not null,
  case_id uuid not null,
  kind text not null check(kind in ('Follow-up','Question')),
  title text not null,
  detail text not null default '',
  due_date date,
  status text not null default 'Open' check(status in ('Open','Done')),
  seed_key text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(workspace_id,case_id) references aerion.execution_cases(workspace_id,id),
  unique(case_id,seed_key)
);
create table aerion.readiness_items (
  workspace_id uuid not null,
  case_id uuid not null,
  item_key text not null,
  status text not null check(status in ('Missing','Received','Reviewed','Verified')),
  source_id uuid not null,
  note text not null,
  verified_by text,
  verified_on date,
  reviewer uuid not null,
  updated_at timestamptz not null default now(),
  primary key(case_id,item_key),
  foreign key(workspace_id,case_id) references aerion.execution_cases(workspace_id,id),
  foreign key(workspace_id,source_id) references aerion.sources(workspace_id,id),
  check(status <> 'Verified' or (verified_by is not null and verified_on is not null))
);
create index case_actions_due on aerion.case_actions(workspace_id,status,due_date);
create index draft_case on aerion.outreach_drafts(case_id,created_at desc);
do $$ declare t text; begin
 foreach t in array array['execution_cases','case_contacts','shortlist_decisions','outreach_drafts','case_actions','readiness_items'] loop
   execute format('alter table aerion.%I enable row level security',t);
   execute format('alter table aerion.%I force row level security',t);
   execute format('create policy workspace_scope on aerion.%I to aerion_runtime using (workspace_id = nullif(current_setting(''aerion.workspace_id'',true),'''')::uuid and exists (select 1 from aerion.workspaces w where w.id=workspace_id)) with check (workspace_id = nullif(current_setting(''aerion.workspace_id'',true),'''')::uuid and exists (select 1 from aerion.workspaces w where w.id=workspace_id))',t);
 end loop;
end $$;
grant select,insert on aerion.execution_cases,aerion.case_contacts,aerion.shortlist_decisions,aerion.outreach_drafts,aerion.case_actions,aerion.readiness_items to aerion_runtime;
grant update(revision,confirmation) on aerion.execution_cases to aerion_runtime;
grant update(decision,reason,actor_id,updated_at) on aerion.shortlist_decisions to aerion_runtime;
grant update(status,review_note,reviewer,reviewed_at) on aerion.outreach_drafts to aerion_runtime;
grant update(status,updated_at) on aerion.case_actions to aerion_runtime;
grant update(status,source_id,note,verified_by,verified_on,reviewer,updated_at) on aerion.readiness_items to aerion_runtime;
-- Original draft text/claims and prior activity are immutable to the runtime role.
