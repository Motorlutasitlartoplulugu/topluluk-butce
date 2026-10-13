create policy ledger_settings_reject_api_access
  on app_private.ledger_settings
  for all to anon, authenticated
  using (false)
  with check (false);

create or replace function app_private.ledger_settings_password_is_configured()
returns boolean
language sql
security definer
set search_path = ''
as $$
  select exists (select 1 from app_private.ledger_settings where singleton_id = 1)
$$;

create or replace function app_private.initialize_ledger_settings_password(p_password text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or lower(coalesce(auth.jwt() ->> 'email', '')) <> 'akumtt03@gmail.com'
    or not exists (select 1 from public.ledger_members where user_id = auth.uid() and can_record) then
    raise exception 'Not authorized to manage ledger settings';
  end if;
  if p_password is null or char_length(p_password) < 12 or char_length(p_password) > 128 then
    raise exception 'Settings password must be 12 to 128 characters';
  end if;
  insert into app_private.ledger_settings (singleton_id, password_hash)
  values (1, extensions.crypt(p_password, extensions.gen_salt('bf')))
  on conflict (singleton_id) do nothing;
  if not found then raise exception 'Settings password has already been configured'; end if;
end;
$$;

create or replace function app_private.verify_ledger_settings_password(p_password text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  settings_row app_private.ledger_settings%rowtype;
begin
  if auth.uid() is null or lower(coalesce(auth.jwt() ->> 'email', '')) <> 'akumtt03@gmail.com'
    or not exists (select 1 from public.ledger_members where user_id = auth.uid() and can_record) then
    raise exception 'Not authorized to manage ledger settings';
  end if;
  select * into settings_row
  from app_private.ledger_settings where singleton_id = 1 for update;
  if not found then return false; end if;
  if settings_row.locked_until is not null and settings_row.locked_until > pg_catalog.now() then return false; end if;
  if p_password is null or extensions.crypt(p_password, settings_row.password_hash) <> settings_row.password_hash then
    update app_private.ledger_settings
    set failed_attempts = failed_attempts + 1,
        locked_until = case when failed_attempts + 1 >= 5 then pg_catalog.now() + interval '15 minutes' else null end
    where singleton_id = 1;
    return false;
  end if;
  update app_private.ledger_settings set failed_attempts = 0, locked_until = null where singleton_id = 1;
  return true;
end;
$$;

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
  perform pg_catalog.set_config('app.ledger_actor', btrim(p_actor_name), true);
  delete from public.ledger_entries;
  get diagnostics deleted_count = row_count;
  return deleted_count;
end;
$$;

revoke all on function app_private.ledger_settings_password_is_configured() from public, anon, authenticated;
revoke all on function app_private.initialize_ledger_settings_password(text) from public, anon, authenticated;
revoke all on function app_private.verify_ledger_settings_password(text) from public, anon, authenticated;
revoke all on function app_private.delete_all_ledger_entries(text, text) from public, anon, authenticated;
grant usage on schema app_private to authenticated;
grant execute on function app_private.ledger_settings_password_is_configured() to authenticated;
grant execute on function app_private.initialize_ledger_settings_password(text) to authenticated;
grant execute on function app_private.verify_ledger_settings_password(text) to authenticated;
grant execute on function app_private.delete_all_ledger_entries(text, text) to authenticated;

create or replace function public.ledger_settings_password_configured()
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null or lower(coalesce(auth.jwt() ->> 'email', '')) <> 'akumtt03@gmail.com'
    or not exists (select 1 from public.ledger_members where user_id = auth.uid() and can_record) then
    raise exception 'Not authorized to manage ledger settings';
  end if;
  return app_private.ledger_settings_password_is_configured();
end;
$$;

create or replace function public.set_ledger_settings_password(p_password text)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null or lower(coalesce(auth.jwt() ->> 'email', '')) <> 'akumtt03@gmail.com'
    or not exists (select 1 from public.ledger_members where user_id = auth.uid() and can_record) then
    raise exception 'Not authorized to manage ledger settings';
  end if;
  perform app_private.initialize_ledger_settings_password(p_password);
end;
$$;

create or replace function public.verify_ledger_settings_password(p_password text)
returns boolean
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null or lower(coalesce(auth.jwt() ->> 'email', '')) <> 'akumtt03@gmail.com'
    or not exists (select 1 from public.ledger_members where user_id = auth.uid() and can_record) then
    raise exception 'Not authorized to manage ledger settings';
  end if;
  return app_private.verify_ledger_settings_password(p_password);
end;
$$;

create or replace function public.delete_all_ledger_entries(p_actor_name text, p_password text)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null or lower(coalesce(auth.jwt() ->> 'email', '')) <> 'akumtt03@gmail.com'
    or not exists (select 1 from public.ledger_members where user_id = auth.uid() and can_record) then
    raise exception 'Not authorized to delete ledger entries';
  end if;
  return app_private.delete_all_ledger_entries(p_actor_name, p_password);
end;
$$;

revoke all on function public.ledger_settings_password_configured() from public, anon;
revoke all on function public.set_ledger_settings_password(text) from public, anon;
revoke all on function public.verify_ledger_settings_password(text) from public, anon;
revoke all on function public.delete_all_ledger_entries(text, text) from public, anon;
grant execute on function public.ledger_settings_password_configured() to authenticated;
grant execute on function public.set_ledger_settings_password(text) to authenticated;
grant execute on function public.verify_ledger_settings_password(text) to authenticated;
grant execute on function public.delete_all_ledger_entries(text, text) to authenticated;

