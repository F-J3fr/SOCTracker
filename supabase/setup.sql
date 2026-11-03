-- SOC Tracker database setup
-- Run once in Supabase: SQL Editor > New query > paste this whole file > Run.
-- Safe to run again later (it updates functions and keeps your data).
--
-- Design
--   * All tables live in the private "soc" schema, which the public API cannot reach.
--   * The browser encrypts every record (cases, notes, names, schedules) before upload.
--     This database only ever stores ciphertext plus the minimum needed to enforce access:
--     record type, version, timestamps, user ids and roles.
--   * Sign-in uses a key derived from the password in the browser. Only a bcrypt hash of that
--     derived key is stored here, never the password.
--   * The only way in is the soc_* functions below. Each one checks the session and the role.

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

create schema if not exists soc;
revoke all on schema soc from public;

create table if not exists soc.config (
  key   text primary key,
  value text not null
);

create table if not exists soc.users (
  id              uuid primary key default gen_random_uuid(),
  lookup_id       text not null unique,
  role            text not null check (role in ('analyst', 'teamlead', 'admin')),
  auth_hash       text not null,
  key_slot        jsonb not null,
  enc_profile     jsonb not null,
  must_change     boolean not null default true,
  disabled        boolean not null default false,
  failed_attempts integer not null default 0,
  locked_until    timestamptz,
  created_by      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  last_login_at   timestamptz
);

create table if not exists soc.sessions (
  token_hash text primary key,
  user_id    uuid not null references soc.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists soc.records (
  id         uuid primary key,
  kind       text not null check (kind in ('case', 'incident', 'handover', 'notice', 'template', 'schedule', 'settings')),
  enc        jsonb not null,
  version    integer not null default 1,
  deleted    boolean not null default false,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists records_updated_at_idx on soc.records (updated_at);

create table if not exists soc.audit (
  id      bigserial primary key,
  at      timestamptz not null default now(),
  user_id uuid,
  target  uuid,
  action  text not null,
  enc     jsonb
);

create table if not exists soc.counters (
  key text primary key,
  n   integer not null
);

alter table soc.config   enable row level security;
alter table soc.users    enable row level security;
alter table soc.sessions enable row level security;
alter table soc.records  enable row level security;
alter table soc.audit    enable row level security;
alter table soc.counters enable row level security;

insert into soc.config (key, value)
values ('app_salt', encode(extensions.gen_random_bytes(16), 'base64'))
on conflict (key) do nothing;

-- One-time code needed to create the first admin. Shown at the end of this script.
insert into soc.config (key, value)
select 'setup_code', upper(encode(extensions.gen_random_bytes(5), 'hex'))
where not exists (select 1 from soc.users)
on conflict (key) do nothing;

-- ---------------------------------------------------------------- helpers (private)

create or replace function soc.auth_user(p_token text, p_allow_must_change boolean default false)
returns soc.users
language plpgsql security definer
set search_path = soc, extensions, pg_temp
as $$
declare
  s soc.sessions;
  u soc.users;
begin
  if p_token is null or length(p_token) < 32 then
    raise exception 'unauthorized';
  end if;
  select * into s from soc.sessions where token_hash = encode(digest(p_token, 'sha256'), 'hex');
  if not found or s.expires_at < now() then
    raise exception 'unauthorized';
  end if;
  select * into u from soc.users where id = s.user_id;
  if not found or u.disabled then
    raise exception 'unauthorized';
  end if;
  if u.must_change and not p_allow_must_change then
    raise exception 'must_change';
  end if;
  update soc.sessions set expires_at = now() + interval '12 hours' where token_hash = s.token_hash;
  return u;
end $$;

create or replace function soc.can_manage(actor soc.users, target_role text)
returns boolean
language sql immutable
as $$
  select actor.role = 'admin' or (actor.role = 'teamlead' and target_role in ('analyst', 'teamlead'));
$$;

create or replace function soc.log(p_user uuid, p_action text, p_target uuid default null, p_enc jsonb default null)
returns void
language sql security definer
set search_path = soc, pg_temp
as $$
  insert into soc.audit (user_id, action, target, enc) values (p_user, p_action, p_target, p_enc);
$$;

revoke all on all tables in schema soc from public;
revoke all on all functions in schema soc from public;

-- ---------------------------------------------------------------- public API

create or replace function public.soc_config()
returns json
language sql security definer
set search_path = soc, pg_temp
as $$
  select json_build_object(
    'app_salt', (select value from soc.config where key = 'app_salt'),
    'initialized', exists (select 1 from soc.users),
    'server_time', now()
  );
$$;

create or replace function public.soc_setup(
  p_code text, p_lookup_id text, p_auth_key text, p_key_slot jsonb, p_enc_profile jsonb,
  p_settings_id uuid default null, p_settings jsonb default null)
returns json
language plpgsql security definer
set search_path = soc, extensions, pg_temp
as $$
declare
  v_code text;
  v_id uuid;
begin
  lock table soc.users in exclusive mode;
  if exists (select 1 from soc.users) then
    raise exception 'already_initialized';
  end if;
  select value into v_code from soc.config where key = 'setup_code';
  if v_code is null or upper(trim(coalesce(p_code, ''))) <> v_code then
    raise exception 'bad_setup_code';
  end if;
  insert into soc.users (lookup_id, role, auth_hash, key_slot, enc_profile, must_change)
  values (p_lookup_id, 'admin', crypt(p_auth_key, gen_salt('bf', 10)), p_key_slot, p_enc_profile, false)
  returning id into v_id;
  if p_settings is not null and p_settings_id is not null then
    insert into soc.records (id, kind, enc, created_by, updated_by)
    values (p_settings_id, 'settings', p_settings, v_id, v_id);
  end if;
  delete from soc.config where key = 'setup_code';
  perform soc.log(v_id, 'setup', v_id);
  return json_build_object('ok', true);
end $$;

create or replace function public.soc_login(p_lookup_id text, p_auth_key text)
returns json
language plpgsql security definer
set search_path = soc, extensions, pg_temp
as $$
declare
  u soc.users;
  v_token text;
begin
  select * into u from soc.users where lookup_id = p_lookup_id;
  if not found then
    perform crypt(coalesce(p_auth_key, ''), gen_salt('bf', 10)); -- same cost as a real check
    perform soc.log(null, 'login.failed');
    return json_build_object('error', 'invalid_credentials');
  end if;
  if u.locked_until is not null and u.locked_until > now() then
    return json_build_object('error', 'locked', 'minutes', ceil(extract(epoch from (u.locked_until - now())) / 60));
  end if;
  if u.disabled then
    return json_build_object('error', 'disabled');
  end if;
  if u.auth_hash <> crypt(coalesce(p_auth_key, ''), u.auth_hash) then
    update soc.users set
      failed_attempts = case when failed_attempts + 1 >= 5 then 0 else failed_attempts + 1 end,
      locked_until    = case when failed_attempts + 1 >= 5 then now() + interval '5 minutes' else locked_until end
    where id = u.id;
    perform soc.log(null, 'login.failed', u.id);
    return json_build_object('error', 'invalid_credentials');
  end if;
  update soc.users set failed_attempts = 0, locked_until = null, last_login_at = now() where id = u.id;
  delete from soc.sessions where expires_at < now();
  v_token := encode(gen_random_bytes(32), 'hex');
  insert into soc.sessions (token_hash, user_id, expires_at)
  values (encode(digest(v_token, 'sha256'), 'hex'), u.id, now() + interval '12 hours');
  perform soc.log(u.id, 'login', u.id);
  return json_build_object(
    'token', v_token,
    'user', json_build_object('id', u.id, 'role', u.role, 'must_change', u.must_change,
                              'key_slot', u.key_slot, 'enc_profile', u.enc_profile));
end $$;

create or replace function public.soc_logout(p_token text)
returns json
language sql security definer
set search_path = soc, extensions, pg_temp
as $$
  delete from soc.sessions where token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex');
  select json_build_object('ok', true);
$$;

create or replace function public.soc_change_password(p_token text, p_old_auth_key text, p_new_auth_key text, p_key_slot jsonb)
returns json
language plpgsql security definer
set search_path = soc, extensions, pg_temp
as $$
declare
  a soc.users := soc.auth_user(p_token, true);
begin
  if a.auth_hash <> crypt(coalesce(p_old_auth_key, ''), a.auth_hash) then
    raise exception 'wrong_password';
  end if;
  update soc.users set auth_hash = crypt(p_new_auth_key, gen_salt('bf', 10)), key_slot = p_key_slot,
    must_change = false, updated_at = now()
  where id = a.id;
  delete from soc.sessions where user_id = a.id and token_hash <> encode(digest(p_token, 'sha256'), 'hex');
  perform soc.log(a.id, 'user.password', a.id);
  return json_build_object('ok', true);
end $$;

create or replace function public.soc_users(p_token text)
returns json
language plpgsql security definer
set search_path = soc, extensions, pg_temp
as $$
declare
  a soc.users := soc.auth_user(p_token, true);
begin
  return coalesce((
    select json_agg(json_build_object(
      'id', id, 'role', role, 'must_change', must_change, 'disabled', disabled,
      'enc_profile', enc_profile, 'created_by', created_by, 'created_at', created_at,
      'updated_at', updated_at, 'last_login_at', last_login_at) order by created_at)
    from soc.users), '[]'::json);
end $$;

create or replace function public.soc_create_user(p_token text, p_lookup_id text, p_role text, p_auth_key text, p_key_slot jsonb, p_enc_profile jsonb)
returns json
language plpgsql security definer
set search_path = soc, extensions, pg_temp
as $$
declare
  a soc.users := soc.auth_user(p_token);
  v_id uuid;
begin
  if p_role not in ('analyst', 'teamlead', 'admin') then raise exception 'bad_role'; end if;
  if not soc.can_manage(a, p_role) then raise exception 'forbidden'; end if;
  if exists (select 1 from soc.users where lookup_id = p_lookup_id) then raise exception 'username_taken'; end if;
  insert into soc.users (lookup_id, role, auth_hash, key_slot, enc_profile, must_change, created_by)
  values (p_lookup_id, p_role, crypt(p_auth_key, gen_salt('bf', 10)), p_key_slot, p_enc_profile, true, a.id)
  returning id into v_id;
  perform soc.log(a.id, 'user.create', v_id);
  return json_build_object('id', v_id);
end $$;

-- Reset a password. Also re-enables a disabled account (it needs a new password anyway).
create or replace function public.soc_reset_user(p_token text, p_user_id uuid, p_auth_key text, p_key_slot jsonb)
returns json
language plpgsql security definer
set search_path = soc, extensions, pg_temp
as $$
declare
  a soc.users := soc.auth_user(p_token);
  t soc.users;
begin
  select * into t from soc.users where id = p_user_id;
  if not found then raise exception 'not_found'; end if;
  if not soc.can_manage(a, t.role) then raise exception 'forbidden'; end if;
  update soc.users set auth_hash = crypt(p_auth_key, gen_salt('bf', 10)), key_slot = p_key_slot,
    must_change = (t.id <> a.id), disabled = false, failed_attempts = 0, locked_until = null, updated_at = now()
  where id = t.id;
  if t.id <> a.id then delete from soc.sessions where user_id = t.id; end if;
  perform soc.log(a.id, case when t.disabled then 'user.enable' else 'user.reset' end, t.id);
  return json_build_object('ok', true);
end $$;

create or replace function public.soc_update_user(p_token text, p_user_id uuid, p_role text default null, p_disabled boolean default null, p_enc_profile jsonb default null)
returns json
language plpgsql security definer
set search_path = soc, extensions, pg_temp
as $$
declare
  a soc.users := soc.auth_user(p_token);
  t soc.users;
  v_active_admins integer;
begin
  select * into t from soc.users where id = p_user_id;
  if not found then raise exception 'not_found'; end if;
  if not soc.can_manage(a, t.role) then raise exception 'forbidden'; end if;
  if p_role is not null and (p_role not in ('analyst', 'teamlead', 'admin') or not soc.can_manage(a, p_role)) then
    raise exception 'forbidden';
  end if;
  if t.id = a.id and ((p_role is not null and p_role <> t.role) or coalesce(p_disabled, false)) then
    raise exception 'self_change';
  end if;
  if p_disabled = false and t.disabled then raise exception 'use_reset'; end if;
  select count(*) into v_active_admins from soc.users where role = 'admin' and not disabled;
  if t.role = 'admin' and not t.disabled and v_active_admins <= 1
     and ((p_role is not null and p_role <> 'admin') or coalesce(p_disabled, false)) then
    raise exception 'last_admin';
  end if;
  update soc.users set
    role        = coalesce(p_role, role),
    enc_profile = coalesce(p_enc_profile, enc_profile),
    disabled    = coalesce(p_disabled, disabled),
    auth_hash   = case when p_disabled then '!' else auth_hash end,
    key_slot    = case when p_disabled then '{}'::jsonb else key_slot end,
    updated_at  = now()
  where id = t.id;
  if p_disabled then delete from soc.sessions where user_id = t.id; end if;
  perform soc.log(a.id, case when p_disabled then 'user.disable' else 'user.update' end, t.id);
  return json_build_object('ok', true);
end $$;

create or replace function public.soc_sync(p_token text, p_since timestamptz default null)
returns json
language plpgsql security definer
set search_path = soc, extensions, pg_temp
as $$
declare
  a soc.users := soc.auth_user(p_token);
begin
  return json_build_object(
    'now', now(),
    'me', json_build_object('id', a.id, 'role', a.role, 'must_change', a.must_change),
    'users_stamp', (select max(updated_at) from soc.users),
    'records', coalesce((
      select json_agg(json_build_object(
        'id', id, 'kind', kind, 'enc', enc, 'version', version, 'deleted', deleted,
        'created_by', created_by, 'updated_by', updated_by, 'created_at', created_at, 'updated_at', updated_at)
        order by updated_at)
      from soc.records
      where p_since is null or updated_at > p_since), '[]'::json));
end $$;

create or replace function public.soc_put(p_token text, p_id uuid, p_kind text, p_enc jsonb, p_expected integer)
returns json
language plpgsql security definer
set search_path = soc, extensions, pg_temp
as $$
declare
  a soc.users := soc.auth_user(p_token);
  r soc.records;
begin
  if p_kind not in ('case', 'incident', 'handover', 'notice', 'template', 'schedule', 'settings') then
    raise exception 'bad_kind';
  end if;
  if p_kind in ('notice', 'schedule', 'settings') and a.role = 'analyst' then
    raise exception 'forbidden';
  end if;
  if length(p_enc::text) > 1000000 then raise exception 'too_large'; end if;
  select * into r from soc.records where id = p_id for update;
  if found then
    if r.kind <> p_kind then raise exception 'forbidden'; end if;
    if r.deleted then raise exception 'deleted'; end if;
    if r.version <> p_expected then raise exception 'conflict'; end if;
    -- analysts can create case templates but only edit the ones they created
    if r.kind = 'template' and a.role = 'analyst' and r.created_by <> a.id then raise exception 'forbidden'; end if;
    update soc.records set enc = p_enc, version = version + 1, updated_by = a.id, updated_at = clock_timestamp()
    where id = p_id
    returning * into r;
  else
    if p_expected <> 0 then raise exception 'conflict'; end if;
    begin
      insert into soc.records (id, kind, enc, version, created_by, updated_by, created_at, updated_at)
      values (p_id, p_kind, p_enc, 1, a.id, a.id, clock_timestamp(), clock_timestamp())
      returning * into r;
    exception when unique_violation then
      raise exception 'conflict';
    end;
  end if;
  return json_build_object('version', r.version, 'updated_at', r.updated_at, 'created_at', r.created_at, 'created_by', r.created_by);
end $$;

create or replace function public.soc_delete(p_token text, p_id uuid)
returns json
language plpgsql security definer
set search_path = soc, extensions, pg_temp
as $$
declare
  a soc.users := soc.auth_user(p_token);
  r soc.records;
begin
  select * into r from soc.records where id = p_id for update;
  if not found or r.deleted then raise exception 'not_found'; end if;
  if r.kind = 'handover' then
    if r.created_by <> a.id and a.role = 'analyst' then raise exception 'forbidden'; end if;
  elsif a.role = 'analyst' then
    raise exception 'forbidden';
  end if;
  update soc.records set deleted = true, enc = '{}'::jsonb, version = version + 1, updated_by = a.id, updated_at = clock_timestamp()
  where id = p_id;
  return json_build_object('ok', true);
end $$;

create or replace function public.soc_next_ref(p_token text, p_key text)
returns integer
language plpgsql security definer
set search_path = soc, extensions, pg_temp
as $$
declare
  a soc.users := soc.auth_user(p_token);
  v integer;
begin
  if p_key !~ '^(SOC|INC)-[0-9]{6}$' then raise exception 'bad_key'; end if;
  insert into soc.counters (key, n) values (p_key, 1)
  on conflict (key) do update set n = soc.counters.n + 1
  returning n into v;
  return v;
end $$;

create or replace function public.soc_audit_add(p_token text, p_action text, p_enc jsonb)
returns json
language plpgsql security definer
set search_path = soc, extensions, pg_temp
as $$
declare
  a soc.users := soc.auth_user(p_token);
begin
  if p_action !~ '^[a-z]+(\.[a-z]+)?$' or length(p_action) > 40 then raise exception 'bad_action'; end if;
  if length(coalesce(p_enc::text, '')) > 20000 then raise exception 'too_large'; end if;
  perform soc.log(a.id, p_action, null, p_enc);
  return json_build_object('ok', true);
end $$;

create or replace function public.soc_audit_list(p_token text, p_limit integer default 1000)
returns json
language plpgsql security definer
set search_path = soc, extensions, pg_temp
as $$
declare
  a soc.users := soc.auth_user(p_token);
begin
  if a.role = 'analyst' then raise exception 'forbidden'; end if;
  return coalesce((
    select json_agg(x) from (
      select id, at, user_id, target, action, enc from soc.audit
      order by id desc limit least(greatest(coalesce(p_limit, 1000), 1), 5000)) x), '[]'::json);
end $$;

-- Only the soc_* functions are callable through the API.
revoke all on function public.soc_config() from public;
revoke all on function public.soc_setup(text, text, text, jsonb, jsonb, uuid, jsonb) from public;
revoke all on function public.soc_login(text, text) from public;
revoke all on function public.soc_logout(text) from public;
revoke all on function public.soc_change_password(text, text, text, jsonb) from public;
revoke all on function public.soc_users(text) from public;
revoke all on function public.soc_create_user(text, text, text, text, jsonb, jsonb) from public;
revoke all on function public.soc_reset_user(text, uuid, text, jsonb) from public;
revoke all on function public.soc_update_user(text, uuid, text, boolean, jsonb) from public;
revoke all on function public.soc_sync(text, timestamptz) from public;
revoke all on function public.soc_put(text, uuid, text, jsonb, integer) from public;
revoke all on function public.soc_delete(text, uuid) from public;
revoke all on function public.soc_next_ref(text, text) from public;
revoke all on function public.soc_audit_add(text, text, jsonb) from public;
revoke all on function public.soc_audit_list(text, integer) from public;

grant execute on function public.soc_config() to anon, authenticated;
grant execute on function public.soc_setup(text, text, text, jsonb, jsonb, uuid, jsonb) to anon, authenticated;
grant execute on function public.soc_login(text, text) to anon, authenticated;
grant execute on function public.soc_logout(text) to anon, authenticated;
grant execute on function public.soc_change_password(text, text, text, jsonb) to anon, authenticated;
grant execute on function public.soc_users(text) to anon, authenticated;
grant execute on function public.soc_create_user(text, text, text, text, jsonb, jsonb) to anon, authenticated;
grant execute on function public.soc_reset_user(text, uuid, text, jsonb) to anon, authenticated;
grant execute on function public.soc_update_user(text, uuid, text, boolean, jsonb) to anon, authenticated;
grant execute on function public.soc_sync(text, timestamptz) to anon, authenticated;
grant execute on function public.soc_put(text, uuid, text, jsonb, integer) to anon, authenticated;
grant execute on function public.soc_delete(text, uuid) to anon, authenticated;
grant execute on function public.soc_next_ref(text, text) to anon, authenticated;
grant execute on function public.soc_audit_add(text, text, jsonb) to anon, authenticated;
grant execute on function public.soc_audit_list(text, integer) to anon, authenticated;

notify pgrst, 'reload schema';

-- Your one-time setup code (empty once the first admin exists):
select coalesce((select value from soc.config where key = 'setup_code'), 'already set up') as setup_code;
