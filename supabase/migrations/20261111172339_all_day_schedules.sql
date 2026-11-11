-- Prepared only: apply before releasing the V2 frontend. Existing records remain NULL.
-- Uses the existing records RLS policies; no account, quota or API changes.
alter table public.records add column if not exists schedule_details jsonb;

alter table public.records drop constraint if exists records_schedule_details_check;
alter table public.records add constraint records_schedule_details_check check (
  schedule_details is null or (
    record_type = 'trip'
    and trip_id is not null
    and parent_plan_id is null
    and transport_type is null
    and jsonb_typeof(schedule_details) = 'object'
    and coalesce(schedule_details ->> 'kind', '') in ('all_day', 'hotel')
    and coalesce(schedule_details ->> 'start_date', '') ~ '^\d{4}-\d{2}-\d{2}$'
    and coalesce(schedule_details ->> 'end_date', '') ~ '^\d{4}-\d{2}-\d{2}$'
    and case when schedule_details ->> 'kind' = 'hotel'
      then (schedule_details ->> 'end_date')::date > (schedule_details ->> 'start_date')::date
      else (schedule_details ->> 'end_date')::date >= (schedule_details ->> 'start_date')::date
    end
  )
);

comment on column public.records.schedule_details is
  'Optional all-day or hotel date range in the parent trip timezone. Hotel end_date is checkout; overnight interval excludes end_date. One record is projected across days by the frontend.';
