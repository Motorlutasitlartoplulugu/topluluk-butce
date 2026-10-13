alter table public.ledger_entries
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by_name text;

alter table public.ledger_entries
  drop constraint if exists ledger_entries_deleted_by_name_check;
alter table public.ledger_entries
  add constraint ledger_entries_deleted_by_name_check
  check (deleted_by_name is null or char_length(btrim(deleted_by_name)) between 1 and 80);

create index if not exists ledger_entries_active_date_created_idx
  on public.ledger_entries (entry_date desc, created_at desc)
  where deleted_at is null;

create or replace function public.log_ledger_entry_change()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  audit_actor text;
  audit_action text;
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

  if old.deleted_at is null and new.deleted_at is not null then
    audit_actor := coalesce(nullif(btrim(new.deleted_by_name), ''), nullif(btrim(new.updated_by_name), ''));
    audit_action := 'deleted';
  else
    audit_actor := nullif(btrim(new.updated_by_name), '');
    audit_action := 'updated';
  end if;
  if audit_actor is null or char_length(audit_actor) > 80 then
    raise exception 'A valid editor name is required';
  end if;
  insert into public.ledger_entry_audit (
    ledger_entry_id, action, actor_name, actor_user_id, old_values, new_values
  ) values (
    new.id, audit_action, audit_actor, auth.uid(),
    jsonb_build_object(
      'entry_type', old.entry_type, 'amount', old.amount,
      'category', old.category, 'entered_by_name', old.entered_by_name,
      'updated_by_name', old.updated_by_name, 'note', old.note,
      'entry_date', old.entry_date, 'receipt_path', old.receipt_path,
      'deleted_at', old.deleted_at, 'deleted_by_name', old.deleted_by_name
    ),
    jsonb_build_object(
      'entry_type', new.entry_type, 'amount', new.amount,
      'category', new.category, 'entered_by_name', new.entered_by_name,
      'updated_by_name', new.updated_by_name, 'note', new.note,
      'entry_date', new.entry_date, 'receipt_path', new.receipt_path,
      'deleted_at', new.deleted_at, 'deleted_by_name', new.deleted_by_name
    )
  );
  return new;
end;
$$;

revoke all on function public.log_ledger_entry_change() from public, anon, authenticated;

create or replace function app_private.delete_all_ledger_entries(p_actor_name text, p_password text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_count integer;
begin
  if auth.uid() is null or lower(coalesce(auth.jwt() ->> 'email', '')) <> 'akumtt03@gmail.com'
    or not exists (select 1 from public.ledger_members where user_id = auth.uid() and can_record) then
    raise exception 'Not authorized to delete ledger entries';
  end if;
  if p_actor_name is null or char_length(btrim(p_actor_name)) not between 1 and 80 then
    raise exception 'A valid actor name is required';
  end if;
  if not app_private.verify_ledger_settings_password(p_password) then
    raise exception 'Invalid settings password';
  end if;
  update public.ledger_entries
    set deleted_at = pg_catalog.now(),
        deleted_by_name = btrim(p_actor_name),
        updated_by_name = btrim(p_actor_name)
    where deleted_at is null;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function app_private.delete_all_ledger_entries(text, text) from public, anon, authenticated;
grant execute on function app_private.delete_all_ledger_entries(text, text) to authenticated;

