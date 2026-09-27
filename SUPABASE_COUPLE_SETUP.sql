-- NEXORA COUPLE — Supabase setup
-- Jalankan di Supabase project KHUSUS Nexora Couple.
-- Anonymous Sign-Ins harus diaktifkan di Authentication > Sign In / Providers.

create extension if not exists pgcrypto;

create table if not exists public.couple_profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default 'You',
  avatar_data text not null default '',
  email text,
  updated_at timestamptz not null default now()
);


create table if not exists public.couples (
  id uuid primary key default gen_random_uuid(),
  pair_code text unique not null,
  user_a uuid references auth.users(id) on delete cascade,
  user_b uuid references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.couple_locations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  latitude double precision not null,
  longitude double precision not null,
  speed_kmh double precision not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.couple_presence (
  user_id uuid primary key references auth.users(id) on delete cascade,
  is_online boolean not null default false,
  last_seen timestamptz not null default now()
);

alter table public.couples enable row level security;
alter table public.couple_locations enable row level security;
alter table public.couple_presence enable row level security;
alter table public.couple_profiles enable row level security;

-- Users do not get direct SELECT access to partner data.
-- Pairing and partner reads happen through the security-definer RPCs below.

drop policy if exists "users can read own pair" on public.couples;
drop policy if exists "users can create pair" on public.couples;
drop policy if exists "users can update own pair" on public.couples;
drop policy if exists "own location write" on public.couple_locations;
drop policy if exists "own location select" on public.couple_locations;
drop policy if exists "own presence write" on public.couple_presence;
drop policy if exists "own presence select" on public.couple_presence;
drop policy if exists "own profile all" on public.couple_profiles;

create policy "own profile all"
on public.couple_profiles
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "own location write"
on public.couple_locations
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create policy "own presence write"
on public.couple_presence
for all
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

create or replace function public.create_pair(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_code text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  v_code := upper(trim(p_code));

  if v_code !~ '^[A-Z0-9]{6}$' then
    raise exception 'Invalid pairing code';
  end if;

  if exists (
    select 1
    from public.couples c
    where c.user_a = auth.uid() or c.user_b = auth.uid()
  ) then
    raise exception 'You are already paired';
  end if;

  insert into public.couples(pair_code, user_a)
  values (v_code, auth.uid())
  returning id into v_id;

  return v_id;
exception
  when unique_violation then
    raise exception 'Pairing code already exists. Try again.';
end;
$$;

create or replace function public.join_pair(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_a uuid;
  v_b uuid;
  v_code text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  v_code := upper(trim(p_code));

  select id, user_a, user_b
  into v_id, v_a, v_b
  from public.couples
  where pair_code = v_code
  limit 1;

  if v_id is null then
    raise exception 'Pairing code not found';
  end if;

  if v_a = auth.uid() then
    return v_id;
  end if;

  if v_b is not null and v_b <> auth.uid() then
    raise exception 'Pairing code already used';
  end if;

  if exists (
    select 1
    from public.couples c
    where c.user_a = auth.uid() or c.user_b = auth.uid()
  ) then
    raise exception 'You are already paired';
  end if;

  update public.couples
  set user_b = auth.uid()
  where id = v_id
    and user_b is null;

  return v_id;
end;
$$;

create or replace function public.my_pair()
returns table(
  id uuid,
  pair_code text,
  user_a uuid,
  user_b uuid
)
language sql
security definer
set search_path = public
as $$
  select c.id, c.pair_code, c.user_a, c.user_b
  from public.couples c
  where c.user_a = auth.uid() or c.user_b = auth.uid()
  order by c.created_at desc
  limit 1;
$$;

create or replace function public.partner_snapshot()
returns table(
  user_id uuid,
  display_name text,
  avatar_data text,
  is_online boolean,
  last_seen timestamptz,
  latitude double precision,
  longitude double precision,
  speed_kmh double precision,
  location_updated_at timestamptz
)
language sql
security definer
set search_path = public
as $$
  with p as (
    select case
      when c.user_a = auth.uid() then c.user_b
      else c.user_a
    end as partner_id
    from public.couples c
    where (c.user_a = auth.uid() or c.user_b = auth.uid())
      and c.user_a is not null
      and c.user_b is not null
    order by c.created_at desc
    limit 1
  )
  select
    p.partner_id,
    coalesce(pro.display_name, 'Partner')::text,
    coalesce(pro.avatar_data, '')::text,
    coalesce(
      cp.is_online
      and cp.last_seen >= now() - interval '45 seconds',
      false
    ),
    cp.last_seen,
    cl.latitude,
    cl.longitude,
    coalesce(cl.speed_kmh, 0),
    cl.updated_at
  from p
  left join public.couple_presence cp
    on cp.user_id = p.partner_id
  left join public.couple_profiles pro
    on pro.user_id = p.partner_id
  left join public.couple_locations cl
    on cl.user_id = p.partner_id;
$$;

create or replace function public.leave_pair()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted boolean := false;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  delete from public.couples
  where user_a = auth.uid() or user_b = auth.uid();

  v_deleted := found;

  delete from public.couple_locations where user_id = auth.uid();
  update public.couple_presence
  set is_online = false, last_seen = now()
  where user_id = auth.uid();

  return v_deleted;
end;
$$;

grant execute on function public.create_pair(text) to authenticated, anon;
grant execute on function public.join_pair(text) to authenticated, anon;
grant execute on function public.my_pair() to authenticated, anon;
grant execute on function public.partner_snapshot() to authenticated, anon;
grant execute on function public.leave_pair() to authenticated, anon;

-- Catatan:
-- 1. Anonymous Sign-Ins harus ON.
-- 2. Frontend mengirim heartbeat presence setiap 15 detik.
-- 3. Partner dianggap offline jika heartbeat terakhir >45 detik.
-- 4. Lokasi hanya ditulis setelah akun paired dan user mengaktifkan sharing.
