import { createClient } from "@supabase/supabase-js";

const defaultUrl = "https://ihqkgtmikwdakhyglels.supabase.co";
const defaultKey = "sb_publishable_dSuoed9lLUOklE0Mgf7r7A_5Bd8IRrb";

export const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || defaultUrl;
export const supabaseKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || defaultKey;

export const supabase = createClient(supabaseUrl, supabaseKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: "pkce"
  }
});

export const magicLinkRedirect = () => new URL(import.meta.env.BASE_URL, window.location.origin).toString();
