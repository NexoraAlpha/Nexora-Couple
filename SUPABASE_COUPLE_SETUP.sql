-- Nexora Couple Tracker — jalankan di project Supabase KHUSUS Couple Tracker.
create table if not exists public.couples (id uuid primary key default gen_random_uuid(), pair_code text unique not null, user_a uuid references auth.users(id) on delete cascade, user_b uuid references auth.users(id) on delete cascade, created_at timestamptz not null default now());
create table if not exists public.couple_locations (user_id uuid primary key references auth.users(id) on delete cascade, latitude double precision not null, longitude double precision not null, speed_kmh double precision default 0, updated_at timestamptz not null default now());
create table if not exists public.couple_presence (user_id uuid primary key references auth.users(id) on delete cascade, is_online boolean not null default false, last_seen timestamptz not null default now());
alter table public.couples enable row level security; alter table public.couple_locations enable row level security; alter table public.couple_presence enable row level security;
-- NOTE: Production pairing policies should be tightened around membership in couples.
create policy "users can read own pair" on public.couples for select using (auth.uid()=user_a or auth.uid()=user_b);
create policy "users can create pair" on public.couples for insert with check (auth.uid()=user_a);
create policy "users can update own pair" on public.couples for update using (auth.uid()=user_a or auth.uid()=user_b);
create policy "own location write" on public.couple_locations for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
create policy "own presence write" on public.couple_presence for all using (auth.uid()=user_id) with check (auth.uid()=user_id);
-- For partner reads, add a secure RPC/view after the pairing flow is implemented; do not expose all users' locations.
