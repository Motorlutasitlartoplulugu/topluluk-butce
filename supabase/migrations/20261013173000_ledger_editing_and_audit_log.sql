alter table public.ledger_entries
  add column if not exists updated_by_name text
  check (updated_by_name is null or char_length(btrim(updated_by_name)) between 1 and 80);

create table if not exists public.ledger_entry_audit (
  id bigint generated always as identity primary key,
  ledger_entry_id uuid not null,
  action text not null check (action in ('created', 'updated')),
  actor_name text not null check (char_length(btrim(actor_name)) between 1 and 80),
  actor_user_id uuid not null references auth.users(id),
  changed_at timestamptz not null default now(),
  old_values jsonb,
  new_values jsonb not null
);

create index if not exists ledger_entry_audit_changed_at_idx
  on public.ledger_entry_audit (changed_at desc);
create index if not exists ledger_entry_audit_entry_id_idx
  on public.ledger_entry_audit (ledger_entry_id, changed_at desc);
create index if not exists ledger_entry_audit_actor_user_id_idx
  on public.ledger_entry_audit (actor_user_id);

alter table public.ledger_entry_audit enable row level security;
revoke all on public.ledger_entry_audit from anon, authenticated;
grant select on public.ledger_entry_audit to authenticated;
grant usage, select on sequence public.ledger_entry_audit_id_seq to authenticated;

drop policy if exists ledger_entries_member_update on public.ledger_entries;
create policy ledger_entries_member_update
  on public.ledger_entries
  for update to authenticated
  using (
    exists (
      select 1 from public.ledger_members m
      where m.user_id = (select auth.uid()) and m.can_record
    )
  )
  with check (
    exists (
      select 1 from public.ledger_members m
      where m.user_id = (select auth.uid()) and m.can_record
    )
  );
grant update (entry_type, amount, category, updated_by_name, note, entry_date, receipt_path)
  on public.ledger_entries to authenticated;

drop policy if exists ledger_entry_audit_member_read on public.ledger_entry_audit;
create policy ledger_entry_audit_member_read
  on public.ledger_entry_audit
  for select to authenticated
  using (
    exists (
      select 1 from public.ledger_members m
      where m.user_id = (select auth.uid()) and m.can_record
    )
  );

create or replace function public.log_ledger_entry_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  audit_actor text;
begin
  if tg_op = 'INSERT' then
    audit_actor := coalesce(nullif(btrim(new.entered_by_name), ''), 'Belirtilmemiş');
    insert into public.ledger_entry_audit (
      ledger_entry_id, action, actor_name, actor_user_id, new_values
    ) values (
      new.id, 'created', audit_actor, new.created_by,
      jsonb_build_object(
        'entry_type', new.entry_type,
        'amount', new.amount,
        'category', new.category,
        'entered_by_name', new.entered_by_name,
        'note', new.note,
        'entry_date', new.entry_date,
        'receipt_path', new.receipt_path
      )
    );
    return new;
  end if;

  audit_actor := nullif(btrim(new.updated_by_name), '');
  if audit_actor is null or char_length(audit_actor) > 80 then
    raise exception 'A valid editor name is required';
  end if;

  insert into public.ledger_entry_audit (
    ledger_entry_id, action, actor_name, actor_user_id, old_values, new_values
  ) values (
    new.id, 'updated', audit_actor, auth.uid(),
    jsonb_build_object(
      'entry_type', old.entry_type,
      'amount', old.amount,
      'category', old.category,
      'entered_by_name', old.entered_by_name,
      'updated_by_name', old.updated_by_name,
      'note', old.note,
      'entry_date', old.entry_date,
      'receipt_path', old.receipt_path
    ),
    jsonb_build_object(
      'entry_type', new.entry_type,
      'amount', new.amount,
      'category', new.category,
      'entered_by_name', new.entered_by_name,
      'updated_by_name', new.updated_by_name,
      'note', new.note,
      'entry_date', new.entry_date,
      'receipt_path', new.receipt_path
    )
  );
  return new;
end;
$$;

revoke all on function public.log_ledger_entry_change() from public, anon, authenticated;
drop trigger if exists ledger_entries_audit_insert on public.ledger_entries;
create trigger ledger_entries_audit_insert
  after insert on public.ledger_entries
  for each row execute function public.log_ledger_entry_change();
drop trigger if exists ledger_entries_audit_update on public.ledger_entries;
create trigger ledger_entries_audit_update
  after update on public.ledger_entries
  for each row execute function public.log_ledger_entry_change();

