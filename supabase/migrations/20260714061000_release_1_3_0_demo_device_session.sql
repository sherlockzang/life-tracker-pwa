-- Keep one stable server-side demo session id per device. Rotating the raw
-- token on re-entry must not reset that device's daily AI allowance.
delete from public.demo_sessions older
using public.demo_sessions newer
where older.device_hash = newer.device_hash and older.created_at < newer.created_at;

create unique index if not exists demo_sessions_device_unique_idx on public.demo_sessions(device_hash);

