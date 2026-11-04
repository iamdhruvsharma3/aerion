alter table aerion.extractions drop constraint extractions_provider_check;
alter table aerion.extractions add constraint extractions_provider_check check(provider in ('local','openai','ollama'));
grant update(format,purpose) on aerion.source_connectors to aerion_runtime;
create table aerion.mailbox_cursors (
 workspace_id uuid not null references aerion.workspaces(id),account_key text not null,uid_validity text not null,last_uid bigint not null default 0,
 lease_token uuid,leased_at timestamptz,updated_at timestamptz not null default now(),primary key(workspace_id,account_key)
);
create table aerion.mail_deliveries (
 id uuid primary key,workspace_id uuid not null,draft_id uuid not null,requirement_id text not null,contact_id text not null,
 sender text not null,recipient text not null,subject text not null,body text not null,context_hash text not null,
 status text not null default 'queued' check(status in ('queued','sending','accepted','failed','unknown','cancelled')),
 idempotency_key uuid not null,reviewer uuid not null,review_note text not null,message_id text not null,
 error text,server_response text,sending_at timestamptz,finished_at timestamptz,created_at timestamptz not null default now(),
 foreign key(workspace_id,draft_id) references aerion.outreach_drafts(workspace_id,id),unique(workspace_id,idempotency_key),unique(workspace_id,draft_id)
);
create index mail_delivery_queue on aerion.mail_deliveries(workspace_id,status,created_at);
do $$ declare t text; begin
 foreach t in array array['mailbox_cursors','mail_deliveries'] loop
  execute format('alter table aerion.%I enable row level security',t);
  execute format('alter table aerion.%I force row level security',t);
  execute format('create policy workspace_scope on aerion.%I to aerion_runtime using (workspace_id=nullif(current_setting(''aerion.workspace_id'',true),'''')::uuid and exists(select 1 from aerion.workspaces w where w.id=workspace_id)) with check (workspace_id=nullif(current_setting(''aerion.workspace_id'',true),'''')::uuid and exists(select 1 from aerion.workspaces w where w.id=workspace_id))',t);
 end loop;
end $$;
grant select,insert on aerion.mailbox_cursors,aerion.mail_deliveries to aerion_runtime;
grant update(uid_validity,last_uid,lease_token,leased_at,updated_at) on aerion.mailbox_cursors to aerion_runtime;
grant update(status,error,server_response,sending_at,finished_at) on aerion.mail_deliveries to aerion_runtime;
-- Mail content, recipient, original approval and message identity are immutable. An interrupted send is never retried automatically.
