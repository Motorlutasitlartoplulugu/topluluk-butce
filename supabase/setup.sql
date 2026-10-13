-- Topluluk Bütçesi başlangıç şeması.
-- Bu şema seçili Supabase projesine uygulanmıştır.

create table if not exists public.ledger_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  can_record boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.ledger_entries (
  id uuid primary key default gen_random_uuid(),
  entry_type text not null check (entry_type in ('income', 'expense')),
  amount numeric(14,2) not null check (amount > 0),
  category text not null check (char_length(btrim(category)) between 1 and 80),
  entered_by_name text check (
    entered_by_name is null or char_length(btrim(entered_by_name)) between 1 and 80
  ),
  note text check (note is null or char_length(note) <= 500),
  entry_date date not null default current_date,
  receipt_path text,
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  constraint ledger_entries_receipt_owned_path check (
    receipt_path is null or split_part(receipt_path, '/', 1) = created_by::text
  )
);

create index if not exists ledger_entries_date_created_idx
  on public.ledger_entries (entry_date desc, created_at desc);
create index if not exists ledger_entries_created_by_idx
  on public.ledger_entries (created_by);

alter table public.ledger_members enable row level security;
alter table public.ledger_entries enable row level security;

revoke all on public.ledger_members from anon, authenticated;
grant select on public.ledger_members to authenticated;
revoke all on public.ledger_entries from anon, authenticated;
grant select, insert on public.ledger_entries to authenticated;

drop policy if exists ledger_members_read_self on public.ledger_members;
create policy ledger_members_read_self
  on public.ledger_members
  for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists ledger_entries_member_read on public.ledger_entries;
create policy ledger_entries_member_read
  on public.ledger_entries
  for select to authenticated
  using (
    exists (
      select 1 from public.ledger_members m
      where m.user_id = (select auth.uid()) and m.can_record
    )
  );

drop policy if exists ledger_entries_member_insert on public.ledger_entries;
create policy ledger_entries_member_insert
  on public.ledger_entries
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and exists (
      select 1 from public.ledger_members m
      where m.user_id = (select auth.uid()) and m.can_record
    )
  );

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'community-receipts',
  'community-receipts',
  false,
  8388608,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

drop policy if exists community_receipts_member_read on storage.objects;
create policy community_receipts_member_read
  on storage.objects
  for select to authenticated
  using (
    bucket_id = 'community-receipts'
    and exists (
      select 1 from public.ledger_members m
      where m.user_id = (select auth.uid()) and m.can_record
    )
  );

drop policy if exists community_receipts_member_upload_own_folder on storage.objects;
create policy community_receipts_member_upload_own_folder
  on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'community-receipts'
    and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (
      select 1 from public.ledger_members m
      where m.user_id = (select auth.uid()) and m.can_record
    )
  );
drop policy if exists community_receipts_member_delete on storage.objects;
create policy community_receipts_member_delete
  on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'community-receipts'
    and exists (
      select 1 from public.ledger_members m
      where m.user_id = (select auth.uid()) and m.can_record
    )
  );
alter table public.ledger_entries
  add column if not exists updated_by_name text
  check (updated_by_name is null or char_length(btrim(updated_by_name)) between 1 and 80);

create table if not exists public.ledger_entry_audit (
  id bigint generated always as identity primary key,
  ledger_entry_id uuid not null,
  action text not null check (action in ('created', 'updated', 'deleted')),
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

  if tg_op = 'DELETE' then
    audit_actor := nullif(btrim(current_setting('app.ledger_actor', true)), '');
    if audit_actor is null or char_length(audit_actor) > 80 then
      raise exception 'A valid actor name is required to delete ledger entries';
    end if;
    insert into public.ledger_entry_audit (
      ledger_entry_id, action, actor_name, actor_user_id, old_values, new_values
    ) values (
      old.id, 'deleted', audit_actor, auth.uid(),
      jsonb_build_object(
        'entry_type', old.entry_type,
        'amount', old.amount,
        'category', old.category,
        'entered_by_name', old.entered_by_name,
        'note', old.note,
        'entry_date', old.entry_date,
        'receipt_path', old.receipt_path
      ), '{}'::jsonb
    );
    return old;
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
drop trigger if exists ledger_entries_audit_delete on public.ledger_entries;
create trigger ledger_entries_audit_delete
  before delete on public.ledger_entries
  for each row execute function public.log_ledger_entry_change();

grant delete on public.ledger_entries to authenticated;
drop policy if exists ledger_entries_member_delete on public.ledger_entries;
create policy ledger_entries_member_delete
  on public.ledger_entries
  for delete to authenticated
  using (
    exists (
      select 1 from public.ledger_members m
      where m.user_id = (select auth.uid()) and m.can_record
    )
  );

create or replace function public.delete_all_ledger_entries(p_actor_name text)
returns integer
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  deleted_count integer;
begin
  if auth.uid() is null or not exists (
    select 1 from public.ledger_members m
    where m.user_id = auth.uid() and m.can_record
  ) then
    raise exception 'Not authorized to delete ledger entries';
  end if;
  if p_actor_name is null or char_length(btrim(p_actor_name)) not between 1 and 80 then
    raise exception 'A valid actor name is required';
  end if;

  perform set_config('app.ledger_actor', btrim(p_actor_name), true);
  delete from public.ledger_entries;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;
revoke all on function public.delete_all_ledger_entries(text) from public, anon;
grant execute on function public.delete_all_ledger_entries(text) to authenticated;

