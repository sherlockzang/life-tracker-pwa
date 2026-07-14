# Supabase setup

1. Open the Supabase project SQL Editor.
2. Run `migrations/20260714000000_initial_schema.sql` once.
3. In Authentication → URL Configuration, set the production Site URL to:
   `https://sherlockzang.github.io/life-tracker-pwa/`
4. Add these redirect URLs:
   - `https://sherlockzang.github.io/life-tracker-pwa/`
   - `http://localhost:3000/life-tracker-pwa/`

The migration creates `user_settings`, `trips`, `records`, and
`exchange_rates`, enables RLS on every table, and adds private Storage policies
for the optional `record-images` bucket.
