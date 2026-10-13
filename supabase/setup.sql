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
