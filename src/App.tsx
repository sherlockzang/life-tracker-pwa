import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { CalendarRange, ChevronRight, CircleUserRound, Cloud, CloudOff, ListFilter, LoaderCircle, MapPinned, NotebookPen, Plane, Plus, ReceiptText, Route, Settings, Sparkles, WifiOff } from "lucide-react";
import { supabase } from "./lib/supabase";
import { cachedAppData, defaultProfile, defaultSettings, fetchAppData, makeRecord, makeTrip, persistProfile, persistRecord, persistSettings, persistTrip, refreshRates, syncOutbox, updateCachedData, uploadAvatar, type AppData } from "./lib/data";
import type { Currency, LifeRecord, RecordDraft, RecordType, TripDraft, UserProfile, UserSettings } from "./types";
import { LoginScreen } from "./components/LoginScreen";
import { QuickComposer } from "./components/QuickComposer";
import { Timeline } from "./components/Timeline";
import { Planner } from "./components/Planner";
import { SettingsPanel } from "./components/SettingsPanel";
import { ProfileAvatar } from "./components/ProfileAvatar";
import { Onboarding, WhatsNew } from "./components/GuidanceOverlays";

const ExpenseStats = lazy(() => import("./components/ExpenseStats").then((module) => ({ default: module.ExpenseStats })));

type View = "timeline" | "planner" | "settings";
type Filter = "all" | RecordType;

const filters: { value: Filter; label: string; icon: typeof Sparkles }[] = [
  { value: "all", label: "全部", icon: Sparkles },
  { value: "expense", label: "消费", icon: ReceiptText },
  { value: "trip", label: "行程", icon: Route },
  { value: "note", label: "随记", icon: NotebookPen }
];

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [data, setData] = useState<AppData | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [view, setView] = useState<View>("timeline");
  const [filter, setFilter] = useState<Filter>("all");
  const [online, setOnline] = useState(navigator.onLine);
  const [refreshingRates, setRefreshingRates] = useState(false);
  const [toast, setToast] = useState("");
  const [composerOpen, setComposerOpen] = useState(false);
  const [plannerTripId, setPlannerTripId] = useState<string | undefined>();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: authData }) => { setSession(authData.session); setAuthReady(true); });
    const { data: subscription } = supabase.auth.onAuthStateChange((_event, nextSession) => { setSession(nextSession); setAuthReady(true); });
    return () => subscription.subscription.unsubscribe();
  }, []);

  const user = session?.user || null;

  useEffect(() => {
    if (!user) { setData(null); return; }
    let cancelled = false;
    setLoading(true); setLoadError("");
    void (async () => {
      const cached = await cachedAppData(user);
      if (cached && !cancelled) setData(cached);
      try {
        await syncOutbox();
        const fresh = await fetchAppData(user);
        if (!cancelled) setData(fresh);
      } catch (error) {
        if (!cached && !cancelled) setData({ records: [], trips: [], rates: [], settings: defaultSettings(user.id), profile: defaultProfile(user), changelogs: [] });
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "暂时无法读取云端数据");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user]);

  useEffect(() => {
    const onOnline = async () => {
      setOnline(true);
      const count = await syncOutbox();
      if (count) showToast(`${count} 条离线记录已同步`);
    };
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("focus", onOnline);
    return () => { window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline); window.removeEventListener("focus", onOnline); };
  }, []);

  useEffect(() => {
    const theme = data?.settings.theme || "system";
    const root = document.documentElement;
    root.dataset.theme = theme;
  }, [data?.settings.theme]);

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  };

  const updateData = useCallback((recipe: (current: AppData) => AppData) => {
    setData((current) => {
      if (!current || !user) return current;
      const next = recipe(current);
      void updateCachedData(user.id, next);
      return next;
    });
  }, [user]);

  async function saveRecord(draft: RecordDraft) {
    if (!user || !data) return;
    const record = makeRecord(user, draft);
    updateData((current) => ({ ...current, records: [record, ...current.records] }));
    await persistRecord(record);
    showToast(online ? "已记下来" : "已离线保存，联网后同步");
  }

  async function updateRecord(record: LifeRecord) {
    updateData((current) => ({ ...current, records: current.records.map((item) => item.id === record.id ? record : item) }));
    await persistRecord(record);
  }

  async function saveTrip(draft: TripDraft) {
    if (!user) throw new Error("尚未登录");
    const trip = makeTrip(user, draft);
    updateData((current) => ({ ...current, trips: [trip, ...current.trips] }));
    await persistTrip(trip);
    showToast("行程已创建");
    return trip;
  }

  async function updateSettings(settings: UserSettings) {
    updateData((current) => ({ ...current, settings }));
    await persistSettings(settings);
    showToast("设置已保存");
  }

  async function updateProfile(profile: UserProfile, avatar?: Blob, message = "资料已保存") {
    if (!user) return;
    const nextProfile = avatar ? { ...profile, avatar_url: await uploadAvatar(user, avatar), updated_at: new Date().toISOString() } : profile;
    updateData((current) => ({ ...current, profile: nextProfile }));
    await persistProfile(nextProfile);
    if (message) showToast(message);
  }

  async function handleRateRefresh() {
    if (!user || !data) return;
    const currencies = [...new Set(data.records.filter((record) => record.record_type === "expense" && record.currency).map((record) => record.currency as Currency))];
    if (!currencies.length) { showToast("先记一笔外币消费吧"); return; }
    setRefreshingRates(true);
    try {
      const fetched = await refreshRates(user, data.settings.base_currency, currencies);
      const keys = new Set(fetched.map((rate) => `${rate.base_currency}:${rate.quote_currency}`));
      updateData((current) => ({ ...current, rates: [...fetched, ...current.rates.filter((rate) => !keys.has(`${rate.base_currency}:${rate.quote_currency}`))] }));
      showToast("汇率已更新");
    } catch {
      showToast("汇率更新失败，已继续使用缓存");
    } finally {
      setRefreshingRates(false);
    }
  }

  const currentTrip = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    return data?.trips.find((trip) => trip.start_date <= today && trip.end_date >= today);
  }, [data?.trips]);

  const currentDay = currentTrip ? Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(`${currentTrip.start_date}T00:00:00`).getTime()) / 86_400_000) + 1 : 0;
  const pendingChangelog = data?.profile.has_seen_onboarding
    ? data.changelogs.find((item) => isVersionNewer(item.version, data.profile.last_seen_version))
    : undefined;

  if (!authReady) return <LoadingScreen label="正在打开你的记录空间" />;
  if (!user) return <LoginScreen />;
  if (!data) return <LoadingScreen label="正在整理你的时间线" />;

  return (
    <div className="app-shell">
      <header className="app-header">
        <button className="app-brand" onClick={() => setView("timeline")}><span><Sparkles size={17} /></span><b>Life Tracker</b></button>
        <nav className="desktop-nav" aria-label="主导航">
          <button className={view === "timeline" ? "active" : ""} onClick={() => setView("timeline")}><ListFilter size={17} />记录</button>
          <button className={view === "planner" ? "active" : ""} onClick={() => setView("planner")}><CalendarRange size={17} />行程规划</button>
        </nav>
        <div className="header-actions">
          <span className={`connection ${online ? "online" : "offline"}`}>{online ? <Cloud size={15} /> : <CloudOff size={15} />}{online ? "已同步" : "离线"}</span>
          <button className={`icon-button ${view === "settings" ? "active" : ""}`} aria-label="设置" onClick={() => setView("settings")}><Settings size={19} /></button>
          <ProfileAvatar profile={data.profile} className="mini-avatar" />
        </div>
      </header>

      {!online && <div className="offline-banner"><WifiOff size={15} />当前离线。你仍可查看缓存并记录，联网后会自动同步。</div>}
      {loadError && <div className="setup-banner"><b>云端数据表尚未就绪</b><span>当前可以预览界面；运行仓库中的 Supabase migration 后即可正常保存。</span></div>}

      <main className="app-main">
        {view === "timeline" && (
          <>
            {currentTrip && <button className="current-trip glass-card" onClick={() => { setPlannerTripId(currentTrip.id); setView("planner"); }}><span className="current-trip-icon"><Plane size={19} /></span><div><small>你正在进行</small><strong>{currentTrip.name} · Day {currentDay}</strong><p>{currentTrip.destination}，今天也去留下一点什么吧。</p></div><ChevronRight /></button>}
            <QuickComposer trips={data.trips} defaultCurrency={data.settings.base_currency} onSave={saveRecord} />
            <div className="filter-row">
              <div className="filter-tabs" role="tablist">{filters.map((item) => { const Icon = item.icon; return <button role="tab" aria-selected={filter === item.value} className={filter === item.value ? "active" : ""} onClick={() => setFilter(item.value)} key={item.value}><Icon size={15} />{item.label}<span>{item.value === "all" ? data.records.filter((record) => !record.parent_plan_id).length : data.records.filter((record) => record.record_type === item.value && !record.parent_plan_id).length}</span></button>; })}</div>
              <button className="planner-link" onClick={() => setView("planner")}><MapPinned size={16} />行程规划<ChevronRight size={15} /></button>
            </div>
            {filter === "expense" && <Suspense fallback={<div className="chart-loading glass-card"><LoaderCircle className="spin" />正在整理消费统计…</div>}><ExpenseStats records={data.records} rates={data.rates} baseCurrency={data.settings.base_currency} refreshing={refreshingRates} onRefresh={handleRateRefresh} /></Suspense>}
            <Timeline records={data.records} trips={data.trips} filter={filter} baseCurrency={data.settings.base_currency} onStatus={(record, status) => void updateRecord({ ...record, plan_status: status, updated_at: new Date().toISOString() })} />
          </>
        )}
        {view === "planner" && <Planner key={plannerTripId || "all"} trips={data.trips} records={data.records} initialTripId={plannerTripId} baseCurrency={data.settings.base_currency} onSaveTrip={saveTrip} onSaveRecord={saveRecord} onUpdateRecord={updateRecord} />}
        {view === "settings" && <SettingsPanel user={user} settings={data.settings} profile={data.profile} online={online} onUpdate={(settings) => void updateSettings(settings)} onUpdateProfile={(profile, avatar) => updateProfile(profile, avatar)} onSignOut={() => void supabase.auth.signOut()} />}
      </main>

      <button className="floating-add" aria-label="快速记录" onClick={() => setComposerOpen(true)}><Plus size={25} /></button>
      {composerOpen && <div className="composer-modal"><div className="composer-modal-inner"><QuickComposer compact trips={data.trips} defaultCurrency={data.settings.base_currency} onSave={saveRecord} onClose={() => setComposerOpen(false)} /></div></div>}

      <nav className="mobile-nav" aria-label="移动端导航"><button className={view === "timeline" ? "active" : ""} onClick={() => setView("timeline")}><Sparkles /><span>记录</span></button><button className={view === "planner" ? "active" : ""} onClick={() => setView("planner")}><Route /><span>行程</span></button><button className="mobile-add" onClick={() => setComposerOpen(true)}><Plus /></button><button className={filter === "expense" && view === "timeline" ? "active" : ""} onClick={() => { setView("timeline"); setFilter("expense"); }}><ReceiptText /><span>消费</span></button><button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}><CircleUserRound /><span>我的</span></button></nav>

      {toast && <div className="toast"><Sparkles size={15} />{toast}</div>}
      {loading && <div className="sync-loader"><LoaderCircle className="spin" size={14} />正在同步</div>}
      {!data.profile.has_seen_onboarding && <Onboarding onComplete={() => updateProfile({ ...data.profile, has_seen_onboarding: true, updated_at: new Date().toISOString() }, undefined, "")} />}
      {data.profile.has_seen_onboarding && pendingChangelog && <WhatsNew changelog={pendingChangelog} onDismiss={() => updateProfile({ ...data.profile, last_seen_version: pendingChangelog.version, updated_at: new Date().toISOString() }, undefined, "")} />}
    </div>
  );
}

function LoadingScreen({ label }: { label: string }) {
  return <div className="loading-screen"><span><Sparkles /></span><LoaderCircle className="spin" /><p>{label}</p></div>;
}

function isVersionNewer(version: string, lastSeen: string | null) {
  if (!lastSeen) return true;
  const current = version.split(".").map(Number);
  const previous = lastSeen.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if ((current[index] || 0) > (previous[index] || 0)) return true;
    if ((current[index] || 0) < (previous[index] || 0)) return false;
  }
  return false;
}
