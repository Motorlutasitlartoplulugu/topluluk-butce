create or replace function app_private.reset_ledger_settings_password(p_password text)
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
  insert into app_private.ledger_settings (singleton_id, password_hash, failed_attempts, locked_until)
  values (1, extensions.crypt(p_password, extensions.gen_salt('bf')), 0, null)
  on conflict (singleton_id) do update
    set password_hash = excluded.password_hash, failed_attempts = 0, locked_until = null;
end;
$$;

revoke all on function app_private.reset_ledger_settings_password(text) from public, anon, authenticated;
grant execute on function app_private.reset_ledger_settings_password(text) to authenticated;

create or replace function public.reset_ledger_settings_password(p_password text)
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
  perform app_private.reset_ledger_settings_password(p_password);
end;
$$;

revoke all on function public.reset_ledger_settings_password(text) from public, anon;
grant execute on function public.reset_ledger_settings_password(text) to authenticated;

