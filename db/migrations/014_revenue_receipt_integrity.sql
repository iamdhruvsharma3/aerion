-- One retained transfer may be allocated across invoices, but its money is counted only once.
-- Legacy duplicates need evidence-backed reconciliation rather than an inferred transfer total.
do $$ begin
 if exists(select 1 from aerion.revenue_receipts where status='Recorded' group by workspace_id,reference_key having count(*)>1) then
  raise exception 'Revenue migration needs reconciliation: duplicate active payment references exist across invoices. Reverse incorrect allocations with retained evidence before retrying migration014.';
 end if;
 if exists(select 1 from aerion.revenue_expenses where status='Recorded' group by workspace_id,reference_key having count(*)>1) then
  raise exception 'Revenue migration needs reconciliation: duplicate active expense references exist across engagements. Reverse incorrect expense records before retrying migration014.';
 end if;
end $$;
create table aerion.revenue_payments (
 id uuid primary key,workspace_id uuid not null references aerion.workspaces(id),
 payer_contact_id text not null,payer_snapshot jsonb not null,
 reference text not null,reference_key text not null,currency text not null check(currency in ('USD','INR','EUR','GBP','AED','CHF','CAD','AUD','SGD','JPY','KWD')),
 amount_minor bigint not null check(amount_minor between 1 and 9999999999999999),received_on date not null,
 source_id uuid not null,note text not null,legacy_amount boolean not null default false,
 status text not null default 'Recorded' check(status in ('Recorded','Voided')),
 void_note text not null default '',void_source_id uuid,actor_id uuid not null,created_at timestamptz not null default now(),
 unique(workspace_id,id),
 foreign key(workspace_id,source_id) references aerion.sources(workspace_id,id),
 foreign key(workspace_id,void_source_id) references aerion.sources(workspace_id,id),
 check(status<>'Voided' or void_source_id is not null)
);
create unique index unique_active_revenue_payment_reference on aerion.revenue_payments(workspace_id,reference_key) where status='Recorded';
create index revenue_payment_payer on aerion.revenue_payments(workspace_id,payer_contact_id,created_at desc);
alter table aerion.revenue_receipts add column payment_id uuid;
-- Legacy receipt amounts are the known recorded amount, not an inferred full bank transfer.
insert into aerion.revenue_payments(id,workspace_id,payer_contact_id,payer_snapshot,reference,reference_key,currency,amount_minor,received_on,source_id,note,legacy_amount,status,void_note,void_source_id,actor_id,created_at)
 select r.id,r.workspace_id,e.parties->'payer'->>'id',e.parties->'payer',r.reference,r.reference_key,e.terms->>'currency',r.amount_minor,r.received_on,r.source_id,
 'Legacy receipt allocation retained at its recorded amount. Review original transfer evidence before changing or reallocating its amount. '||r.note,true,
 case when r.status='Recorded' then 'Recorded' else 'Voided' end,
 case when r.status='Reversed' then r.reversal_note else '' end,
 case when r.status='Reversed' then coalesce(r.reversal_source_id,r.source_id) else null end,r.actor_id,r.created_at
 from aerion.revenue_receipts r join aerion.revenue_engagements e on e.workspace_id=r.workspace_id and e.id=r.engagement_id;
-- Backfill only the new relationship column; original receipt/reversal facts are untouched.
alter table aerion.revenue_receipts disable trigger protect_reversed_receipt;
update aerion.revenue_receipts set payment_id=id;
alter table aerion.revenue_receipts enable trigger protect_reversed_receipt;
alter table aerion.revenue_receipts alter column payment_id set not null;
alter table aerion.revenue_receipts add foreign key(workspace_id,payment_id) references aerion.revenue_payments(workspace_id,id);
create index revenue_receipt_payment on aerion.revenue_receipts(workspace_id,payment_id) where status='Recorded';
create unique index unique_active_workspace_expense_reference on aerion.revenue_expenses(workspace_id,reference_key) where status='Recorded';
alter table aerion.revenue_payments enable row level security;
alter table aerion.revenue_payments force row level security;
create policy workspace_scope on aerion.revenue_payments to aerion_runtime
 using (workspace_id=nullif(current_setting('aerion.workspace_id',true),'')::uuid and exists(select 1 from aerion.workspaces w where w.id=workspace_id))
 with check (workspace_id=nullif(current_setting('aerion.workspace_id',true),'')::uuid and exists(select 1 from aerion.workspaces w where w.id=workspace_id));
grant select,insert on aerion.revenue_payments to aerion_runtime;
grant update(status,void_note,void_source_id) on aerion.revenue_payments to aerion_runtime;
create trigger protect_voided_payment before update on aerion.revenue_payments for each row execute function aerion.protect_reversed_revenue_record();
create function aerion.check_revenue_payment_void() returns trigger language plpgsql as $$ begin
 if new.status='Voided' and exists(select 1 from aerion.revenue_receipts r where r.workspace_id=old.workspace_id and r.payment_id=old.id and r.status='Recorded') then
  raise exception 'Reverse all recorded allocations before voiding a payment record.';
 end if;
 return new;
end $$;
create trigger check_revenue_payment_void before update of status on aerion.revenue_payments for each row execute function aerion.check_revenue_payment_void();
create function aerion.check_revenue_receipt_allocation() returns trigger language plpgsql as $$
declare p aerion.revenue_payments; v_currency text; v_payer text; allocated numeric;
begin
 if new.status<>'Recorded' then return new; end if;
 select * into p from aerion.revenue_payments where workspace_id=new.workspace_id and id=new.payment_id for update;
 if not found or p.status<>'Recorded' then raise exception 'Allocate only a recorded payment from this workspace.'; end if;
 select i.currency,e.parties->'payer'->>'id' into v_currency,v_payer from aerion.revenue_invoices i join aerion.revenue_engagements e on e.workspace_id=i.workspace_id and e.id=i.engagement_id where i.workspace_id=new.workspace_id and i.id=new.invoice_id and i.status='Issued';
 if not found or v_currency<>p.currency or v_payer<>p.payer_contact_id then raise exception 'Payment payer/currency must match the issued invoice.'; end if;
 if new.source_id<>p.source_id or new.received_on<>p.received_on or new.reference_key<>p.reference_key then raise exception 'Allocation must retain the original transfer reference, date and evidence.'; end if;
 select coalesce(sum(amount_minor),0) into allocated from aerion.revenue_receipts where workspace_id=new.workspace_id and payment_id=new.payment_id and status='Recorded' and id<>new.id;
 if allocated+new.amount_minor>p.amount_minor then raise exception 'Receipt allocations exceed the retained transfer total.'; end if;
 return new;
end $$;
create trigger check_revenue_receipt_allocation before insert or update on aerion.revenue_receipts for each row execute function aerion.check_revenue_receipt_allocation();
