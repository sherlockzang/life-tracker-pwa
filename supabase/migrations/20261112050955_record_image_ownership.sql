-- The private bucket's per-user RLS policies remain unchanged.
alter table public.records drop constraint if exists records_image_note_only;
