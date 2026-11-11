-- A quota day remains Asia/Shanghai; a summary's business day belongs to each
-- active trip. Legacy Shanghai-only summaries must not masquerade as new ones.
alter table public.daily_summaries add column if not exists context_key text not null default 'legacy-shanghai';
alter table public.daily_summaries drop constraint if exists daily_summaries_user_id_summary_date_key;
-- Retain old content without treating Shanghai-only rows as a trip-local cache.
update public.daily_summaries set context_key = 'legacy-shanghai:' || summary_date::text where context_key = 'legacy-shanghai';
-- If an earlier local candidate stored the same business context on two quota
-- dates, retain older content under an archival key, rather than deleting it.
with ranked as (
  select id, row_number() over(partition by user_id, context_key order by generated_at desc, id desc) as position
  from public.daily_summaries
) update public.daily_summaries s set context_key = 'legacy-duplicate:' || s.id::text
from ranked r where s.id = r.id and r.position > 1;
drop index if exists public.daily_summaries_user_date_context_key;
create unique index if not exists daily_summaries_user_context_key on public.daily_summaries(user_id, context_key);

-- This RPC is reached only after JWT authentication plus HMAC token validation
-- in the Edge function. It cannot be executed using a publishable/user key.
-- Cache storage and successful usage completion commit in one transaction.
create or replace function public.store_ai_result(
  p_user_id uuid,
  p_request_id uuid,
  p_feature text,
  p_content text,
  p_generated_at timestamptz,
  p_trip_id uuid default null,
  p_summary_date date default null,
  p_context_key text default null,
  p_snapshot_hash text default null,
  p_response_meta jsonb default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_usage public.api_usage_events;
  v_saved_at timestamptz;
begin
  if p_user_id is null or p_request_id is null or p_content is null or char_length(p_content) > 16000
    or p_generated_at is null or p_generated_at > now() + interval '1 minute'
    or p_feature not in ('route', 'expense_parse', 'note_polish', 'trip_recap', 'daily_summary') then
    raise exception 'invalid AI result' using errcode = '22023';
  end if;
  select * into v_usage from public.api_usage_events where request_id = p_request_id for update;
  if not found or v_usage.user_id is distinct from p_user_id or v_usage.service <> 'deepseek' or v_usage.feature <> p_feature then
    raise exception 'AI request does not belong to this user or feature' using errcode = '42501';
  end if;

  if p_feature = 'trip_recap' then
    if p_trip_id is null or p_snapshot_hash is null or char_length(p_snapshot_hash) <> 64
      or not exists (select 1 from public.trips where id = p_trip_id and user_id = p_user_id) then
      raise exception 'invalid recap target' using errcode = '42501';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('ai-recap:' || p_user_id::text || ':' || p_trip_id::text, 0));
    insert into public.trip_recaps(user_id, trip_id, content, source_snapshot_hash, generated_at, updated_at)
    values (p_user_id, p_trip_id, p_content, p_snapshot_hash, p_generated_at, now())
    on conflict(user_id, trip_id) do update set content = excluded.content,
      source_snapshot_hash = excluded.source_snapshot_hash, generated_at = excluded.generated_at, updated_at = now()
    where public.trip_recaps.generated_at <= excluded.generated_at;
    select generated_at into v_saved_at from public.trip_recaps where user_id = p_user_id and trip_id = p_trip_id;
  elsif p_feature = 'daily_summary' then
    if p_summary_date is null or p_context_key is null or p_context_key !~ '^[0-9a-f]{64}$' then
      raise exception 'invalid summary context' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtextextended('ai-summary:' || p_user_id::text || ':' || p_context_key, 0));
    insert into public.daily_summaries(user_id, summary_date, context_key, content, generated_at)
    values (p_user_id, p_summary_date, p_context_key, p_content, p_generated_at)
    on conflict(user_id, context_key) do update set content = excluded.content, generated_at = excluded.generated_at, summary_date = excluded.summary_date
    where public.daily_summaries.generated_at <= excluded.generated_at;
    select generated_at into v_saved_at from public.daily_summaries
      where user_id = p_user_id and context_key = p_context_key;
  else
    v_saved_at := p_generated_at;
  end if;

  perform public.complete_api_usage(p_request_id, 'completed', p_response_meta);
  return jsonb_build_object('saved', true, 'generatedAt', v_saved_at, 'newerPreserved', v_saved_at > p_generated_at);
end;
$$;
revoke all on function public.store_ai_result(uuid, uuid, text, text, timestamptz, uuid, date, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.store_ai_result(uuid, uuid, text, text, timestamptz, uuid, date, text, text, jsonb) to service_role;
