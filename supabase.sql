-- Meteran Rumah: shared household log.
-- Run once in Supabase → SQL Editor. Replace __HOUSEHOLD_CODE__ with your own long secret code
-- (at least 16 characters). Anyone with that code can read and edit the log, so share it only with your family.

create table if not exists public.households (
  code text primary key check (length(code) >= 16),
  created_at timestamptz not null default now()
);

create table if not exists public.records (
  household text not null references public.households(code) on delete cascade,
  id text not null,
  kind text not null check (kind in ('usage', 'charge', 'settings', 'active')),
  data jsonb,
  deleted boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (household, id)
);
create index if not exists records_household_updated on public.records (household, updated_at);

-- No policies: the public key cannot touch these tables directly. Only the two functions below can,
-- and only for a household code that exists.
alter table public.households enable row level security;
alter table public.records enable row level security;

create or replace function public.pull(p_code text, p_since timestamptz default null)
returns setof public.records
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from households where code = p_code) then
    raise exception 'Unknown household code';
  end if;
  return query
    select * from records r
    where r.household = p_code and (p_since is null or r.updated_at > p_since)
    order by r.updated_at;
end $$;

create or replace function public.push(p_code text, p_rows jsonb)
returns timestamptz
language plpgsql security definer set search_path = public as $$
declare t timestamptz;
begin
  if not exists (select 1 from households where code = p_code) then
    raise exception 'Unknown household code';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 2000 then
    raise exception 'Bad rows';
  end if;
  insert into records (household, id, kind, data, deleted, updated_at)
  select p_code, r->>'id', r->>'kind', r->'data', coalesce((r->>'deleted')::boolean, false), clock_timestamp()
  from jsonb_array_elements(p_rows) r
  on conflict (household, id) do update
    set kind = excluded.kind, data = excluded.data, deleted = excluded.deleted, updated_at = clock_timestamp();
  select max(updated_at) into t from records where household = p_code;
  return t;
end $$;

revoke all on function public.pull(text, timestamptz) from public;
revoke all on function public.push(text, jsonb) from public;
grant execute on function public.pull(text, timestamptz) to anon, authenticated;
grant execute on function public.push(text, jsonb) to anon, authenticated;

insert into public.households (code) values ('__HOUSEHOLD_CODE__') on conflict do nothing;
