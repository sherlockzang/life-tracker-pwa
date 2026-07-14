-- Life Tracker initial schema
-- Run in the Supabase SQL editor or with `supabase db push`.

create extension if not exists pgcrypto;

create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create table if not exists public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  base_currency text not null default 'USD' check (base_currency in ('USD','JPY','EUR','GBP','CNY','HKD','SGD','KRW','AUD','NZD','CHF','CAD','THB')),
  theme text not null default 'system' check (theme in ('system','dark','light')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null check (char_length(trim(name)) between 1 and 120),
  destination text not null default '',
  start_date date not null,
  end_date date not null,
  timezone text not null default 'UTC',
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint trips_date_order check (end_date >= start_date),
  constraint trips_owner_pair unique (id, user_id)
);

create table if not exists public.records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  record_type text not null check (record_type in ('expense','trip','note')),
  content text not null check (char_length(trim(content)) between 1 and 4000),
  notes text,
  amount numeric(18,4),
  currency text check (currency is null or currency in ('USD','JPY','EUR','GBP','CNY','HKD','SGD','KRW','AUD','NZD','CHF','CAD','THB')),
  expense_category text check (expense_category is null or expense_category in ('food','transport','shopping','stay','entertainment','other')),
  location text,
  event_at timestamptz not null default now(),
  trip_id uuid references public.trips(id) on delete restrict,
  plan_status text check (plan_status is null or plan_status in ('planned','completed','cancelled')),
  sort_order numeric(18,4),
  parent_plan_id uuid references public.records(id) on delete set null,
  image_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint records_owner_pair unique (id, user_id),
  constraint records_not_own_parent check (parent_plan_id is null or parent_plan_id <> id),
  constraint records_expense_fields check (
    (record_type = 'expense' and amount is not null and amount >= 0 and currency is not null and expense_category is not null)
    or
    (record_type <> 'expense' and amount is null and currency is null and expense_category is null)
  ),
  constraint records_plan_fields check (
    record_type = 'trip'
    or (plan_status is null and sort_order is null)
  ),
  constraint records_plan_requires_status check (
    not (record_type = 'trip' and trip_id is not null) or plan_status is not null
  ),
  constraint records_parent_is_actual check (
    parent_plan_id is null or record_type in ('expense','note')
  ),
  constraint records_image_note_only check (
    image_path is null or record_type = 'note'
  )
);

create table if not exists public.exchange_rates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  base_currency text not null check (base_currency in ('USD','JPY','EUR','GBP','CNY','HKD','SGD','KRW','AUD','NZD','CHF','CAD','THB')),
  quote_currency text not null check (quote_currency in ('USD','JPY','EUR','GBP','CNY','HKD','SGD','KRW','AUD','NZD','CHF','CAD','THB')),
  rate numeric(20,10) not null check (rate > 0),
  rate_date date not null,
  source text not null default 'api' check (source in ('api','manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint exchange_rates_pair check (base_currency <> quote_currency)
);

create index if not exists trips_owner_dates_idx on public.trips(user_id, start_date, end_date);
create index if not exists records_owner_timeline_idx on public.records(user_id, event_at desc);
create index if not exists records_owner_type_timeline_idx on public.records(user_id, record_type, event_at desc);
create index if not exists records_trip_day_order_idx on public.records(user_id, trip_id, event_at, sort_order) where trip_id is not null;
create index if not exists records_parent_idx on public.records(user_id, parent_plan_id, event_at) where parent_plan_id is not null;
create index if not exists exchange_rates_lookup_idx on public.exchange_rates(user_id, base_currency, quote_currency, rate_date desc);

create or replace function public.validate_record_relations()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent_row public.records%rowtype;
begin
  if new.trip_id is not null and not exists (
    select 1 from public.trips t where t.id = new.trip_id and t.user_id = new.user_id
  ) then
    raise exception 'trip must belong to the same user';
  end if;

  if new.parent_plan_id is not null then
    select * into parent_row from public.records r where r.id = new.parent_plan_id;
    if parent_row.id is null or parent_row.user_id <> new.user_id or parent_row.record_type <> 'trip' then
      raise exception 'parent plan must be a trip record owned by the same user';
    end if;
    if new.trip_id is distinct from parent_row.trip_id then
      raise exception 'actual record and parent plan must belong to the same trip';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists records_validate_relations on public.records;
create trigger records_validate_relations before insert or update of user_id, trip_id, parent_plan_id on public.records
for each row execute function public.validate_record_relations();

drop trigger if exists user_settings_updated_at on public.user_settings;
create trigger user_settings_updated_at before update on public.user_settings for each row execute function public.set_updated_at();
drop trigger if exists trips_updated_at on public.trips;
create trigger trips_updated_at before update on public.trips for each row execute function public.set_updated_at();
drop trigger if exists records_updated_at on public.records;
create trigger records_updated_at before update on public.records for each row execute function public.set_updated_at();
drop trigger if exists exchange_rates_updated_at on public.exchange_rates;
create trigger exchange_rates_updated_at before update on public.exchange_rates for each row execute function public.set_updated_at();

alter table public.user_settings enable row level security;
alter table public.trips enable row level security;
alter table public.records enable row level security;
alter table public.exchange_rates enable row level security;

drop policy if exists "settings_select_own" on public.user_settings;
create policy "settings_select_own" on public.user_settings for select using (auth.uid() = user_id);
drop policy if exists "settings_insert_own" on public.user_settings;
create policy "settings_insert_own" on public.user_settings for insert with check (auth.uid() = user_id);
drop policy if exists "settings_update_own" on public.user_settings;
create policy "settings_update_own" on public.user_settings for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "settings_delete_own" on public.user_settings;
create policy "settings_delete_own" on public.user_settings for delete using (auth.uid() = user_id);

drop policy if exists "trips_select_own" on public.trips;
create policy "trips_select_own" on public.trips for select using (auth.uid() = user_id);
drop policy if exists "trips_insert_own" on public.trips;
create policy "trips_insert_own" on public.trips for insert with check (auth.uid() = user_id);
drop policy if exists "trips_update_own" on public.trips;
create policy "trips_update_own" on public.trips for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "trips_delete_own" on public.trips;
create policy "trips_delete_own" on public.trips for delete using (auth.uid() = user_id);

drop policy if exists "records_select_own" on public.records;
create policy "records_select_own" on public.records for select using (auth.uid() = user_id);
drop policy if exists "records_insert_own" on public.records;
create policy "records_insert_own" on public.records for insert with check (auth.uid() = user_id);
drop policy if exists "records_update_own" on public.records;
create policy "records_update_own" on public.records for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "records_delete_own" on public.records;
create policy "records_delete_own" on public.records for delete using (auth.uid() = user_id);

drop policy if exists "rates_select_own" on public.exchange_rates;
create policy "rates_select_own" on public.exchange_rates for select using (auth.uid() = user_id);
drop policy if exists "rates_insert_own" on public.exchange_rates;
create policy "rates_insert_own" on public.exchange_rates for insert with check (auth.uid() = user_id);
drop policy if exists "rates_update_own" on public.exchange_rates;
create policy "rates_update_own" on public.exchange_rates for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
drop policy if exists "rates_delete_own" on public.exchange_rates;
create policy "rates_delete_own" on public.exchange_rates for delete using (auth.uid() = user_id);

grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on public.user_settings, public.trips, public.records, public.exchange_rates to authenticated;
revoke all on public.user_settings, public.trips, public.records, public.exchange_rates from anon;

-- Phase 2 private image bucket. The app stores only object paths in records.image_path.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('record-images', 'record-images', false, 10485760, array['image/jpeg','image/png','image/webp','image/heic'])
on conflict (id) do update set public = excluded.public, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "record_images_select_own" on storage.objects;
create policy "record_images_select_own" on storage.objects for select to authenticated
using (bucket_id = 'record-images' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "record_images_insert_own" on storage.objects;
create policy "record_images_insert_own" on storage.objects for insert to authenticated
with check (bucket_id = 'record-images' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "record_images_update_own" on storage.objects;
create policy "record_images_update_own" on storage.objects for update to authenticated
using (bucket_id = 'record-images' and (storage.foldername(name))[1] = auth.uid()::text)
with check (bucket_id = 'record-images' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "record_images_delete_own" on storage.objects;
create policy "record_images_delete_own" on storage.objects for delete to authenticated
using (bucket_id = 'record-images' and (storage.foldername(name))[1] = auth.uid()::text);
