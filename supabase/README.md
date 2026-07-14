# Supabase setup

1. Open the Supabase project SQL Editor.
2. Run every SQL file in `migrations/` in filename order.
3. In Authentication → URL Configuration, set the production Site URL to:
   `https://sherlockzang.github.io/life-tracker-pwa/`
4. Add these redirect URLs:
   - `https://sherlockzang.github.io/life-tracker-pwa/`
   - `http://localhost:3000/life-tracker-pwa/`

The migrations create the record tables plus `profiles` and `changelogs`,
enable RLS, add the private `record-images` bucket, and add a public avatar
bucket with owner-only write policies and a 2MB upload limit.
