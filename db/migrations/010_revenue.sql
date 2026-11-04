-- Recorded client engagements and accounting evidence. This does not move funds or establish legal authority.
create table aerion.revenue_engagements (
 id uuid primary key, workspace_id uuid not null references aerion.workspaces(id),
 revision integer not null default 0, status text not null default 'Draft' check(status in ('Draft','Active','Ended')),
 terms jsonb not null, parties jsonb not null, signed_source_id uuid,
 reviewer uuid, activated_at timestamptz, activation_note text not null default '',
 ended_on date, ended_note text not null default '',ended_source_id uuid,
 idempotency_key uuid not null,request_hash text not null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,idempotency_key),
 foreign key(workspace_id,signed_source_id) references aerion.sources(workspace_id,id),
 foreign key(workspace_id,ended_source_id) references aerion.sources(workspace_id,id),
 check((status='Draft')=(activated_at is null)),
 check(status='Draft' or (signed_source_id is not null and reviewer is not null)),
 check(status<>'Ended' or (ended_on is not null and ended_source_id is not null))
);
create table aerion.revenue_earnings (
 id uuid primary key,workspace_id uuid not null,engagement_id uuid not null,
 earned_on date not null,amount_minor bigint not null check(amount_minor between 1 and 9999999999999999),
 basis_minor bigint check(basis_minor between 1 and 9999999999999999),source_id uuid not null,note text not null,
 transaction_snapshot jsonb,status text not null default 'Recorded' check(status in ('Recorded','Voided')),
 void_note text not null default '',void_source_id uuid,actor_id uuid not null,created_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,engagement_id,id),
 foreign key(workspace_id,engagement_id) references aerion.revenue_engagements(workspace_id,id),
 foreign key(workspace_id,source_id) references aerion.sources(workspace_id,id),
 foreign key(workspace_id,void_source_id) references aerion.sources(workspace_id,id),
 check(status<>'Voided' or void_source_id is not null)
);
create unique index one_recorded_earning_per_engagement on aerion.revenue_earnings(workspace_id,engagement_id) where status='Recorded';
create table aerion.revenue_invoices (
 id uuid primary key,workspace_id uuid not null,engagement_id uuid not null,earning_id uuid not null,
 invoice_number text not null,currency text not null check(currency in ('USD','INR','EUR','GBP','AED','CHF','CAD','AUD','SGD','JPY','KWD')),issued_on date not null,due_on date not null,
 subtotal_minor bigint not null check(subtotal_minor between 1 and 9999999999999999),
 tax_minor bigint not null check(tax_minor between 0 and 9999999999999999),
 total_minor bigint not null check(total_minor between 1 and 9999999999999999 and total_minor=subtotal_minor+tax_minor),
 snapshot jsonb not null,status text not null default 'Issued' check(status in ('Issued','Voided')),
 void_note text not null default '',void_source_id uuid,actor_id uuid not null,created_at timestamptz not null default now(),
 unique(workspace_id,id),unique(workspace_id,engagement_id,id),unique(workspace_id,invoice_number),
 foreign key(workspace_id,engagement_id) references aerion.revenue_engagements(workspace_id,id),
 foreign key(workspace_id,engagement_id,earning_id) references aerion.revenue_earnings(workspace_id,engagement_id,id),
 foreign key(workspace_id,void_source_id) references aerion.sources(workspace_id,id),
 check(due_on>=issued_on),check(status<>'Voided' or void_source_id is not null)
);
create table aerion.revenue_receipts (
 id uuid primary key,workspace_id uuid not null,engagement_id uuid not null,invoice_id uuid not null,
 amount_minor bigint not null check(amount_minor between 1 and 9999999999999999),received_on date not null,
 reference text not null,reference_key text not null,source_id uuid not null,note text not null,
 status text not null default 'Recorded' check(status in ('Recorded','Reversed')),
 reversal_note text not null default '',reversal_source_id uuid,actor_id uuid not null,created_at timestamptz not null default now(),
 unique(workspace_id,id),
 foreign key(workspace_id,engagement_id) references aerion.revenue_engagements(workspace_id,id),
 foreign key(workspace_id,engagement_id,invoice_id) references aerion.revenue_invoices(workspace_id,engagement_id,id),
 foreign key(workspace_id,source_id) references aerion.sources(workspace_id,id),
 foreign key(workspace_id,reversal_source_id) references aerion.sources(workspace_id,id),
 check(status<>'Reversed' or reversal_source_id is not null)
);
create unique index unique_active_invoice_receipt_reference on aerion.revenue_receipts(workspace_id,invoice_id,reference_key) where status='Recorded';
create table aerion.revenue_expenses (
 id uuid primary key,workspace_id uuid not null,engagement_id uuid not null,
 amount_minor bigint not null check(amount_minor between 1 and 9999999999999999),incurred_on date not null,
 category text not null check(category in ('Research','Travel','Professional services','Technology','Other')),
 description text not null,reference text not null,reference_key text not null,source_id uuid not null,note text not null,
 status text not null default 'Recorded' check(status in ('Recorded','Reversed')),
 reversal_note text not null default '',reversal_source_id uuid,actor_id uuid not null,created_at timestamptz not null default now(),
 unique(workspace_id,id),
 foreign key(workspace_id,engagement_id) references aerion.revenue_engagements(workspace_id,id),
 foreign key(workspace_id,source_id) references aerion.sources(workspace_id,id),
 foreign key(workspace_id,reversal_source_id) references aerion.sources(workspace_id,id),
 check(status<>'Reversed' or reversal_source_id is not null)
);
create unique index unique_active_engagement_expense_reference on aerion.revenue_expenses(workspace_id,engagement_id,reference_key) where status='Recorded';
create table aerion.revenue_operations (
 workspace_id uuid not null,engagement_id uuid not null,idempotency_key uuid not null,request_hash text not null,
 created_at timestamptz not null default now(),primary key(workspace_id,idempotency_key),
 foreign key(workspace_id,engagement_id) references aerion.revenue_engagements(workspace_id,id)
);
create index revenue_engagement_history on aerion.revenue_engagements(workspace_id,created_at desc);
create index revenue_invoice_due on aerion.revenue_invoices(workspace_id,due_on) where status='Issued';
create index revenue_earning_engagement on aerion.revenue_earnings(workspace_id,engagement_id);
create index revenue_invoice_engagement on aerion.revenue_invoices(workspace_id,engagement_id);
create index revenue_receipt_invoice on aerion.revenue_receipts(workspace_id,engagement_id,invoice_id);
create index revenue_expense_engagement on aerion.revenue_expenses(workspace_id,engagement_id);

create function aerion.protect_active_engagement_terms() returns trigger language plpgsql as $$ begin
 if old.status<>'Draft' and (new.terms is distinct from old.terms or new.parties is distinct from old.parties or new.signed_source_id is distinct from old.signed_source_id) then
  raise exception 'Activated engagement terms and parties are immutable; retain a new agreement record for an amendment.';
 end if;
 if old.status='Ended' and new.status<>'Ended' then raise exception 'Ended engagement cannot be reopened.'; end if;
 if old.status='Active' and new.status='Draft' then raise exception 'Activated engagement cannot return to Draft.'; end if;
 return new;
end $$;
create trigger protect_active_engagement_terms before update on aerion.revenue_engagements for each row execute function aerion.protect_active_engagement_terms();
create function aerion.protect_reversed_revenue_record() returns trigger language plpgsql as $$ begin
 if old.status in ('Voided','Reversed') then raise exception 'A voided or reversed revenue record is immutable.'; end if;
 return new;
end $$;
create trigger protect_voided_earning before update on aerion.revenue_earnings for each row execute function aerion.protect_reversed_revenue_record();
create trigger protect_voided_invoice before update on aerion.revenue_invoices for each row execute function aerion.protect_reversed_revenue_record();
create trigger protect_reversed_receipt before update on aerion.revenue_receipts for each row execute function aerion.protect_reversed_revenue_record();
create trigger protect_reversed_expense before update on aerion.revenue_expenses for each row execute function aerion.protect_reversed_revenue_record();
do $$ declare t text; begin
 foreach t in array array['revenue_engagements','revenue_earnings','revenue_invoices','revenue_receipts','revenue_expenses','revenue_operations'] loop
  execute format('alter table aerion.%I enable row level security',t);
  execute format('alter table aerion.%I force row level security',t);
  execute format('create policy workspace_scope on aerion.%I to aerion_runtime using (workspace_id = nullif(current_setting(''aerion.workspace_id'',true),'''')::uuid and exists (select 1 from aerion.workspaces w where w.id=workspace_id)) with check (workspace_id = nullif(current_setting(''aerion.workspace_id'',true),'''')::uuid and exists (select 1 from aerion.workspaces w where w.id=workspace_id))',t);
  execute format('grant select,insert on aerion.%I to aerion_runtime',t);
 end loop;
end $$;
grant update(revision,status,terms,parties,signed_source_id,reviewer,activated_at,activation_note,ended_on,ended_note,ended_source_id,updated_at) on aerion.revenue_engagements to aerion_runtime;
grant update(status,void_note,void_source_id) on aerion.revenue_earnings,aerion.revenue_invoices to aerion_runtime;
grant update(status,reversal_note,reversal_source_id) on aerion.revenue_receipts,aerion.revenue_expenses to aerion_runtime;
-- Issued invoice snapshots, earned amounts, recorded receipt/expense facts and activity are immutable.
