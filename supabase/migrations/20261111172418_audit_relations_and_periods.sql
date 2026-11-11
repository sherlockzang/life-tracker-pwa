-- Preserve children and CAS versions: reject incompatible parent changes
-- rather than silently moving actual records to a different trip.
create or replace function public.validate_record_relations()
returns trigger language plpgsql security definer set search_path = public
as $$
declare parent_row public.records%rowtype;
begin
  if new.trip_id is not null and not exists (
    select 1 from public.trips t where t.id = new.trip_id and t.user_id = new.user_id
  ) then raise exception 'trip must belong to the same user'; end if;

  if new.parent_plan_id is not null then
    -- SHARE, not KEY SHARE: serialize a child insert with changes to the
    -- parent's non-key trip/type fields. Recheck the row after a lock wait.
    select * into parent_row from public.records r where r.id = new.parent_plan_id for share;
    if parent_row.id is null or parent_row.user_id <> new.user_id or parent_row.record_type <> 'trip' then
      raise exception 'parent plan must be a trip record owned by the same user';
    end if;
    if new.trip_id is distinct from parent_row.trip_id then
      raise exception 'actual record and parent plan must belong to the same trip';
    end if;
  end if;

  if tg_op = 'UPDATE' and (
    new.trip_id is distinct from old.trip_id or new.record_type is distinct from old.record_type or new.user_id is distinct from old.user_id
  ) and exists (
    select 1 from public.records child where child.parent_plan_id = new.id and (
      new.record_type <> 'trip' or child.user_id <> new.user_id or child.trip_id is distinct from new.trip_id
    )
  ) then raise exception 'parent change would invalidate existing actual records'; end if;
  return new;
end;
$$;
drop trigger if exists records_validate_relations on public.records;
create trigger records_validate_relations before insert or update of user_id, trip_id, parent_plan_id, record_type on public.records
for each row execute function public.validate_record_relations();
revoke all on function public.validate_record_relations() from public, anon, authenticated;

-- Correct previously stored reset metadata from its Shanghai local start.
-- Bucket keys, limits, counters and usage events are deliberately untouched.
update public.api_quota_buckets
set period_end = (date_trunc('month', period_start at time zone 'Asia/Shanghai') + interval '1 month') at time zone 'Asia/Shanghai'
where bucket_key ~ ':[0-9]{4}-[0-9]{2}$';
update public.api_quota_buckets
set period_end = (date_trunc('day', period_start at time zone 'Asia/Shanghai') + interval '1 day') at time zone 'Asia/Shanghai'
where bucket_key ~ ':[0-9]{4}-[0-9]{2}-[0-9]{2}$';
