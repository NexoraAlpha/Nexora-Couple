-- =========================================================
-- NOVERA COUPLE — SUPABASE SETUP + PAIR CODE 5 MINUTES
-- =========================================================
-- Jalankan di Supabase SQL Editor.
-- Script ini aman untuk schema yang sudah pernah dibuat:
-- kolom yang dibutuhkan ditambahkan dengan IF NOT EXISTS.

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
  created_at timestamptz not null default now(),
  pair_code_created_at timestamptz not null default now(),
  disconnect_requested_by uuid references auth.users(id) on delete set null,
  disconnect_requested_at timestamptz,
  disconnect_status text not null default 'none'
);

-- Penting untuk database lama yang tabel couples-nya sudah ada.
alter table public.couples
  add column if not exists pair_code_created_at timestamptz;

update public.couples
set pair_code_created_at = coalesce(created_at, now())
where pair_code_created_at is null;

alter table public.couples
  alter column pair_code_created_at set default now();

alter table public.couples
  add column if not exists disconnect_requested_by uuid references auth.users(id) on delete set null,
  add column if not exists disconnect_requested_at timestamptz,
  add column if not exists disconnect_status text not null default 'none';

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

create table if not exists public.couple_notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  title text not null,
  body text not null default '',
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists couple_notifications_user_created_idx
  on public.couple_notifications(user_id, created_at desc);

alter table public.couples enable row level security;
alter table public.couple_locations enable row level security;
alter table public.couple_presence enable row level security;
alter table public.couple_profiles enable row level security;
alter table public.couple_notifications enable row level security;

drop policy if exists "users can read own pair" on public.couples;
drop policy if exists "users can create pair" on public.couples;
drop policy if exists "users can update own pair" on public.couples;
drop policy if exists "own location write" on public.couple_locations;
drop policy if exists "own location select" on public.couple_locations;
drop policy if exists "own presence write" on public.couple_presence;
drop policy if exists "own presence select" on public.couple_presence;
drop policy if exists "own profile all" on public.couple_profiles;
drop policy if exists "own notifications select" on public.couple_notifications;
drop policy if exists "own notifications update" on public.couple_notifications;

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

create policy "own notifications select"
on public.couple_notifications
for select
using (auth.uid() = user_id);

create policy "own notifications update"
on public.couple_notifications
for update
using (auth.uid() = user_id)
with check (auth.uid() = user_id);

-- =========================================================
-- CREATE PAIR — kode berlaku 5 menit
-- =========================================================

drop function if exists public.create_pair(text);
create function public.create_pair(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_code text;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  v_code := upper(trim(p_code));
  if v_code !~ '^[A-Z0-9]{6}$' then raise exception 'Invalid pairing code'; end if;

  -- A real paired connection always wins.
  if exists (
    select 1 from public.couples c
    where (c.user_a = auth.uid() or c.user_b = auth.uid())
      and c.user_a is not null and c.user_b is not null
  ) then
    raise exception 'You are already paired';
  end if;

  -- Reuse the user's pending row instead of creating orphan rows.
  select id into v_id
  from public.couples
  where user_a = auth.uid()
    and user_b is null
  order by created_at desc
  limit 1;

  if v_id is not null then
    update public.couples
    set pair_code = v_code,
        pair_code_created_at = now(),
        created_at = now(),
        disconnect_status = 'none'
    where id = v_id;
    return v_id;
  end if;

  insert into public.couples(pair_code,user_a,pair_code_created_at,disconnect_status)
  values(v_code,auth.uid(),now(),'none')
  returning id into v_id;

  return v_id;
exception
  when unique_violation then
    raise exception 'Pairing code already exists. Try again.';
end;
$$;

-- =========================================================
-- JOIN PAIR — kode berlaku 5 menit
-- =========================================================

drop function if exists public.join_pair(text);
create function public.join_pair(p_code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_a uuid;
  v_b uuid;
  v_created timestamptz;
  v_code text;
begin
  if auth.uid() is null then raise exception 'Not authenticated'; end if;
  v_code := upper(trim(p_code));
  if v_code !~ '^[A-Z0-9]{6}$' then raise exception 'Invalid pairing code'; end if;

  select id,user_a,user_b,pair_code_created_at
  into v_id,v_a,v_b,v_created
  from public.couples
  where pair_code = v_code
  limit 1;

  if v_id is null then raise exception 'Pairing code not found'; end if;
  if v_created is null or v_created < now() - interval '5 minutes' then
    raise exception 'Pairing code has expired. Please create a new code.';
  end if;
  if v_a = auth.uid() then return v_id; end if;
  if v_b is not null and v_b <> auth.uid() then
    raise exception 'Pairing code already used';
  end if;

  -- Only an actually connected pair blocks joining.
  if exists (
    select 1 from public.couples c
    where (c.user_a = auth.uid() or c.user_b = auth.uid())
      and c.user_a is not null and c.user_b is not null
  ) then
    raise exception 'You are already paired';
  end if;

  update public.couples
  set user_b = auth.uid()
  where id = v_id and user_b is null;

  if not found then raise exception 'Pairing code already used'; end if;
  return v_id;
end;
$$;

-- =========================================================
-- MY PAIR
-- =========================================================

drop function if exists public.my_pair();
create function public.my_pair()
returns table(
  id uuid,
  pair_code text,
  user_a uuid,
  user_b uuid,
  pair_code_created_at timestamptz,
  disconnect_requested_by uuid,
  disconnect_requested_at timestamptz,
  disconnect_status text
)
language sql
security definer
set search_path = public
as $$
  select
    c.id,
    c.pair_code,
    c.user_a,
    c.user_b,
    c.pair_code_created_at,
    c.disconnect_requested_by,
    c.disconnect_requested_at,
    c.disconnect_status
  from public.couples c
  where (c.user_a = auth.uid() or c.user_b = auth.uid())
    and (
      c.user_b is not null
      or c.pair_code_created_at >= now() - interval '5 minutes'
    )
  order by c.created_at desc
  limit 1;
$$;

-- =========================================================
-- PARTNER SNAPSHOT
-- =========================================================

drop function if exists public.partner_snapshot();
create function public.partner_snapshot()
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
  left join public.couple_presence cp on cp.user_id = p.partner_id
  left join public.couple_profiles pro on pro.user_id = p.partner_id
  left join public.couple_locations cl on cl.user_id = p.partner_id;
$$;

-- =========================================================
-- DISCONNECT: HARUS DISETUJUI KEDUA PIHAK
-- =========================================================

drop function if exists public.leave_pair();
create function public.leave_pair()
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

create or replace function public.request_leave_pair()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.couples%rowtype;
  partner uuid;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  select * into c
  from public.couples
  where (user_a = auth.uid() or user_b = auth.uid())
    and user_b is not null
  order by created_at desc
  limit 1;

  if c.id is null then
    raise exception 'Belum ada pasangan yang terhubung';
  end if;

  partner := case when c.user_a = auth.uid() then c.user_b else c.user_a end;

  if c.disconnect_status = 'pending' then
    return jsonb_build_object('already_pending', true);
  end if;

  update public.couples
  set disconnect_requested_by = auth.uid(),
      disconnect_requested_at = now(),
      disconnect_status = 'pending'
  where id = c.id;

  insert into public.couple_notifications(user_id,type,title,body,data)
  values (
    partner,
    'disconnect_request',
    'Permintaan putus pasangan',
    'Pasanganmu mengajukan permintaan untuk mengakhiri pairing. Persetujuanmu diperlukan.',
    jsonb_build_object('pair_id', c.id)
  );

  return jsonb_build_object('already_pending', false);
end;
$$;

create or replace function public.cancel_leave_pair()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.couples%rowtype;
  partner uuid;
begin
  select * into c
  from public.couples
  where (user_a = auth.uid() or user_b = auth.uid())
    and disconnect_status = 'pending'
    and disconnect_requested_by = auth.uid()
  limit 1;

  if c.id is null then return false; end if;

  partner := case when c.user_a = auth.uid() then c.user_b else c.user_a end;

  update public.couples
  set disconnect_requested_by = null,
      disconnect_requested_at = null,
      disconnect_status = 'none'
  where id = c.id;

  insert into public.couple_notifications(user_id,type,title,body,data)
  values (
    partner,
    'disconnect_cancelled',
    'Permintaan putus dibatalkan',
    'Pasanganmu membatalkan permintaan untuk mengakhiri pairing.',
    jsonb_build_object('pair_id', c.id)
  );

  return true;
end;
$$;

create or replace function public.reject_leave_pair()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.couples%rowtype;
  requester uuid;
begin
  select * into c
  from public.couples
  where (user_a = auth.uid() or user_b = auth.uid())
    and disconnect_status = 'pending'
    and disconnect_requested_by <> auth.uid()
  limit 1;

  if c.id is null then return false; end if;

  requester := c.disconnect_requested_by;

  update public.couples
  set disconnect_requested_by = null,
      disconnect_requested_at = null,
      disconnect_status = 'none'
  where id = c.id;

  insert into public.couple_notifications(user_id,type,title,body,data)
  values (
    requester,
    'disconnect_rejected',
    'Permintaan putus ditolak',
    'Pasanganmu menolak permintaan untuk mengakhiri pairing.',
    jsonb_build_object('pair_id', c.id)
  );

  return true;
end;
$$;

create or replace function public.approve_leave_pair()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.couples%rowtype;
  requester uuid;
begin
  select * into c
  from public.couples
  where (user_a = auth.uid() or user_b = auth.uid())
    and disconnect_status = 'pending'
    and disconnect_requested_by <> auth.uid()
  limit 1;

  if c.id is null then return false; end if;

  requester := c.disconnect_requested_by;

  insert into public.couple_notifications(user_id,type,title,body,data)
  values (
    requester,
    'disconnect_approved',
    'Permintaan putus disetujui',
    'Pasanganmu menyetujui pengakhiran pairing. Koneksi telah diputus.',
    jsonb_build_object('pair_id', c.id)
  );

  delete from public.couple_locations where user_id in (c.user_a, c.user_b);
  update public.couple_presence
  set is_online = false, last_seen = now()
  where user_id in (c.user_a, c.user_b);
  delete from public.couples where id = c.id;

  return true;
end;
$$;

-- =========================================================
-- PERMISSIONS
-- =========================================================

grant execute on function public.create_pair(text) to authenticated;
grant execute on function public.join_pair(text) to authenticated;
grant execute on function public.my_pair() to authenticated;
grant execute on function public.partner_snapshot() to authenticated;
grant execute on function public.leave_pair() to authenticated;
grant execute on function public.request_leave_pair() to authenticated;
grant execute on function public.cancel_leave_pair() to authenticated;
grant execute on function public.reject_leave_pair() to authenticated;
grant execute on function public.approve_leave_pair() to authenticated;

-- Catatan:
-- 1. User wajib login dengan akun email sebelum fitur couple digunakan.
-- 2. Kode pairing berlaku 5 menit.
-- 3. Kode pending yang expired otomatis tidak lagi memblokir akun.
-- 4. Partner dianggap offline jika heartbeat terakhir >45 detik.
-- 5. Putus pasangan membutuhkan persetujuan kedua pihak.


-- =========================================================
-- NOVERA MOBILE COUPLE OVERHAUL — BATTERY + LOVE SIGNALS
-- =========================================================

alter table public.couple_presence
  add column if not exists battery_percent integer,
  add column if not exists charging boolean;

-- Partner snapshot with battery information.
drop function if exists public.partner_snapshot();
create function public.partner_snapshot()
returns table(
  user_id uuid,
  display_name text,
  avatar_data text,
  is_online boolean,
  last_seen timestamptz,
  latitude double precision,
  longitude double precision,
  speed_kmh double precision,
  location_updated_at timestamptz,
  battery_percent integer,
  charging boolean
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
    cl.updated_at,
    cp.battery_percent,
    cp.charging
  from p
  left join public.couple_presence cp on cp.user_id = p.partner_id
  left join public.couple_profiles pro on pro.user_id = p.partner_id
  left join public.couple_locations cl on cl.user_id = p.partner_id;
$$;

-- Send a small couple signal to the connected partner.
drop function if exists public.send_couple_signal(text);
create function public.send_couple_signal(p_signal text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  partner_id uuid;
  clean_signal text;
  signal_title text;
  signal_body text;
begin
  if auth.uid() is null then
    raise exception 'Not authenticated';
  end if;

  clean_signal := trim(p_signal);

  if clean_signal not in (
    'Miss You',
    'Love You',
    'Hug',
    'Kiss',
    'Thinking of You',
    'Good Night'
  ) then
    raise exception 'Invalid signal';
  end if;

  select case
    when user_a = auth.uid() then user_b
    else user_a
  end
  into partner_id
  from public.couples
  where (user_a = auth.uid() or user_b = auth.uid())
    and user_a is not null
    and user_b is not null
  order by created_at desc
  limit 1;

  if partner_id is null then
    raise exception 'Belum ada pasangan yang terhubung';
  end if;

  signal_title := '💗 ' || clean_signal;
  signal_body := case clean_signal
    when 'Miss You' then 'Pasanganmu mengirim sinyal: kangen kamu.'
    when 'Love You' then 'Pasanganmu mengirim sinyal: love you.'
    when 'Hug' then 'Pasanganmu mengirim pelukan untukmu.'
    when 'Kiss' then 'Pasanganmu mengirim kiss untukmu.'
    when 'Thinking of You' then 'Pasanganmu sedang memikirkanmu.'
    when 'Good Night' then 'Pasanganmu mengucapkan good night.'
  end;

  insert into public.couple_notifications(
    user_id, type, title, body, data
  )
  values (
    partner_id,
    'couple_signal',
    signal_title,
    signal_body,
    jsonb_build_object('signal', clean_signal, 'from', auth.uid())
  );

  return true;
end;
$$;

grant execute on function public.send_couple_signal(text) to authenticated;
grant execute on function public.partner_snapshot() to authenticated;
