alter table public.ledger_entry_audit
  drop constraint if exists ledger_entry_audit_action_check;
alter table public.ledger_entry_audit
  add constraint ledger_entry_audit_action_check
  check (action in ('created', 'updated', 'deleted'));

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
        'entry_type', new.entry_type, 'amount', new.amount,
        'category', new.category, 'entered_by_name', new.entered_by_name,
        'note', new.note, 'entry_date', new.entry_date,
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
        'entry_type', old.entry_type, 'amount', old.amount,
        'category', old.category, 'entered_by_name', old.entered_by_name,
        'note', old.note, 'entry_date', old.entry_date,
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
      'entry_type', old.entry_type, 'amount', old.amount,
      'category', old.category, 'entered_by_name', old.entered_by_name,
      'updated_by_name', old.updated_by_name, 'note', old.note,
      'entry_date', old.entry_date, 'receipt_path', old.receipt_path
    ),
    jsonb_build_object(
      'entry_type', new.entry_type, 'amount', new.amount,
      'category', new.category, 'entered_by_name', new.entered_by_name,
      'updated_by_name', new.updated_by_name, 'note', new.note,
      'entry_date', new.entry_date, 'receipt_path', new.receipt_path
    )
  );
  return new;
end;
$$;

revoke all on function public.log_ledger_entry_change() from public, anon, authenticated;
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

