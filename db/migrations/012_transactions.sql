create table aerion.transaction_cases (
 workspace_id uuid not null references aerion.workspaces(id),deal_id text not null,revision integer not null default 0,cycle integer not null default 1 check(cycle>0),
 status text not null default 'Sourcing' check(status in ('Sourcing','Offer','LOI','Agreement','Inspection','Closing','Completed','Lost','Cancelled')),
 transaction_kind text not null default 'Sale' check(transaction_kind in ('Sale','Lease')),context_hash text not null,
 next_action text not null default '',due_on date,completed_on date,completion_source_id uuid,
 updated_at timestamptz not null default now(),primary key(workspace_id,deal_id),
 foreign key(workspace_id,completion_source_id) references aerion.sources(workspace_id,id),
 check((status='Completed')=(completed_on is not null and completion_source_id is not null))
);
create table aerion.transaction_offers (
 id uuid primary key,workspace_id uuid not null,deal_id text not null,cycle integer not null check(cycle>0),side text not null check(side in ('Buyer','Seller')),
 contact_id text not null,contact_name text not null,contact_email text not null,offer_kind text not null check(offer_kind in ('Offer','Counteroffer')),parent_id uuid,
 amount numeric(14,2) not null check(amount>0),currency text not null check(currency~'^[A-Z]{3}$'),basis text not null check(basis in ('Purchase price','Monthly rent','Hourly rate')),quantity integer not null check(quantity between 1 and 50),
 offered_on date not null,expires_on date,terms text not null,source_id uuid not null,note text not null,actor_id uuid not null,created_at timestamptz not null default now(),
 unique(workspace_id,id),foreign key(workspace_id,deal_id) references aerion.transaction_cases(workspace_id,deal_id),foreign key(workspace_id,source_id) references aerion.sources(workspace_id,id),foreign key(workspace_id,parent_id) references aerion.transaction_offers(workspace_id,id),
 check((offer_kind='Counteroffer')=(parent_id is not null)),check(expires_on is null or expires_on>=offered_on)
);
create table aerion.transaction_offer_decisions (
 id uuid primary key,workspace_id uuid not null,deal_id text not null,cycle integer not null,offer_id uuid not null,
 decision text not null check(decision in ('Accepted','Rejected','Withdrawn')),source_id uuid not null,decided_on date not null,recorded_by text not null,note text not null,actor_id uuid not null,created_at timestamptz not null default now(),
 foreign key(workspace_id,deal_id) references aerion.transaction_cases(workspace_id,deal_id),foreign key(workspace_id,offer_id) references aerion.transaction_offers(workspace_id,id),foreign key(workspace_id,source_id) references aerion.sources(workspace_id,id)
);
create table aerion.transaction_evidence (
 id uuid primary key,workspace_id uuid not null,deal_id text not null,cycle integer not null,key text not null check(key in ('Representation','Availability','Letter of intent','Executed agreement','Technical records','Pre-purchase inspection','Title','Settlement','Delivery acceptance')),
 source_id uuid not null,occurred_on date not null,party text not null,detail text not null,note text not null,actor_id uuid not null,
 state text not null default 'Received' check(state in ('Received','Reviewed','Verification recorded','Waiver recorded')),
 reviewer text,review_note text not null default '',reviewed_on date,created_at timestamptz not null default now(),
 unique(workspace_id,id),foreign key(workspace_id,deal_id) references aerion.transaction_cases(workspace_id,deal_id),foreign key(workspace_id,source_id) references aerion.sources(workspace_id,id)
);
create table aerion.transaction_findings (
 id uuid primary key,workspace_id uuid not null,deal_id text not null,cycle integer not null,category text not null check(category in ('Technical','Title','Commercial','Other')),severity text not null check(severity in ('Blocking','Question')),
 title text not null,detail text not null,source_id uuid,due_on date,note text not null,actor_id uuid not null,status text not null default 'Open' check(status in ('Open','Resolved')),
 resolution text check(resolution in ('Remedied','Accepted','Waived')),resolution_source_id uuid,resolved_by text,resolved_on date,resolution_note text not null default '',created_at timestamptz not null default now(),
 unique(workspace_id,id),foreign key(workspace_id,deal_id) references aerion.transaction_cases(workspace_id,deal_id),foreign key(workspace_id,source_id) references aerion.sources(workspace_id,id),foreign key(workspace_id,resolution_source_id) references aerion.sources(workspace_id,id)
);
create table aerion.transaction_requests (
 workspace_id uuid not null,deal_id text not null,idempotency_key uuid not null,payload_hash text not null,created_at timestamptz not null default now(),
 primary key(workspace_id,idempotency_key),foreign key(workspace_id,deal_id) references aerion.transaction_cases(workspace_id,deal_id)
);
create index transaction_offer_history on aerion.transaction_offers(workspace_id,deal_id,cycle,created_at);
create index transaction_evidence_history on aerion.transaction_evidence(workspace_id,deal_id,cycle,key,created_at);
do $$ declare t text; begin
 foreach t in array array['transaction_cases','transaction_offers','transaction_offer_decisions','transaction_evidence','transaction_findings','transaction_requests'] loop
  execute format('alter table aerion.%I enable row level security',t);
  execute format('alter table aerion.%I force row level security',t);
  execute format('create policy workspace_scope on aerion.%I to aerion_runtime using (workspace_id = nullif(current_setting(''aerion.workspace_id'',true),'''')::uuid and exists (select 1 from aerion.workspaces w where w.id=workspace_id)) with check (workspace_id = nullif(current_setting(''aerion.workspace_id'',true),'''')::uuid and exists (select 1 from aerion.workspaces w where w.id=workspace_id))',t);
 end loop;
end $$;
grant select,insert on aerion.transaction_cases,aerion.transaction_offers,aerion.transaction_offer_decisions,aerion.transaction_evidence,aerion.transaction_findings,aerion.transaction_requests to aerion_runtime;
grant update(revision,cycle,status,transaction_kind,context_hash,next_action,due_on,completed_on,completion_source_id,updated_at) on aerion.transaction_cases to aerion_runtime;
grant update(state,reviewer,review_note,reviewed_on) on aerion.transaction_evidence to aerion_runtime;
grant update(status,resolution,resolution_source_id,resolved_by,resolved_on,resolution_note) on aerion.transaction_findings to aerion_runtime;
