import { useEffect, useState } from "react";
import { supabase } from "../lib/supabase";

export function RecordImage({ path, ownerId, isDemo }: { path: string | null; ownerId: string; isDemo: boolean }) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setUrl(""); setError(false);
    if (!path || isDemo || !path.startsWith(`${ownerId}/`)) return;
    void (async () => {
      const { data: session } = await supabase.auth.getSession();
      if (session.session?.user.id !== ownerId) throw new Error("Account changed");
      const result = await supabase.storage.from("record-images").createSignedUrl(path, 60);
      if (result.error || !result.data?.signedUrl) throw result.error || new Error("Image unavailable");
      if (!cancelled) setUrl(result.data.signedUrl);
    })().catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [path, ownerId, isDemo]);
  if (!path) return null;
  if (error || !path.startsWith(`${ownerId}/`)) return <small className="record-image-error">图片暂不可用</small>;
  return url ? <img className="record-image" src={url} alt="记录图片" onError={() => setError(true)} /> : <small className="record-image-error">正在加载图片…</small>;
}
