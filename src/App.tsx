import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { CalendarRange, ChevronRight, CircleUserRound, Cloud, CloudOff, ListFilter, LoaderCircle, MapPinned, NotebookPen, Plane, Plus, ReceiptText, Route, Settings, Sparkles, WifiOff } from "lucide-react";
import { supabase } from "./lib/supabase";
import { cachedAppData, defaultProfile, defaultSettings, fetchAppData, makeRecord, makeTrip, normalizeRecord, persistProfile, persistRecord, persistSettings, persistTrip, refreshRates, syncOutbox, updateCachedData, uploadAvatar, type AppData } from "./lib/data";
import type { Currency, LifeRecord, RecordDraft, RecordType, TripDraft, UserProfile, UserSettings } from "./types";
import { LoginScreen } from "./components/LoginScreen";
import { QuickComposer } from "./components/QuickComposer";
import { Timeline } from "./components/Timeline";
import { Planner } from "./components/Planner";
import { SettingsPanel } from "./components/SettingsPanel";
import { ProfileAvatar } from "./components/ProfileAvatar";
import { BrandLogo } from "./components/BrandLogo";
import { Onboarding, WhatsNew } from "./components/GuidanceOverlays";
import { DEMO_USER, loadDemoData, resetDemoData, saveDemoData } from "./lib/demo";
import { startDemoSession } from "./lib/account";
import { AI_RECOVERY_CHANGED, generateDailySummary, pendingAiRecoveries, retryAiPersistence, type PendingAiRecovery } from "./lib/ai";
import { activeTrip, plansForDay, tripDayNumber, tripToday, validTimeZone } from "./lib/calendar";
import { claimAutomaticSummary, loadAutomaticSummary, saveAutomaticSummary, listMutations, OUTBOX_CHANGED, retryFailedMutations, type PendingMutation } from "./lib/offline";
import type { SaveResult } from "./lib/syncEngine";
import { HomeRouteSearch } from "./components/HomeRouteSearch";
import { SyncStatusDialog } from "./components/SyncStatusDialog";
import { RecordEditor } from "./components/RecordEditor";

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
  const [demoMode, setDemoMode] = useState(() => localStorage.getItem("life-tracker-demo-active") === "true");
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
  const [dailySummary, setDailySummary] = useState("");
  const [clockNow, setClockNow] = useState(() => new Date());
  const [syncItems, setSyncItems] = useState<PendingMutation[]>([]);
  const [cloudReady, setCloudReady] = useState(false);
  const [showSyncIssues, setShowSyncIssues] = useState(false);
  const [editingRecordId, setEditingRecordId] = useState<string | null>(null);
  const activeOwner = useRef<string | undefined>(undefined);
  const summaryRequests = useRef(new Map<string, ReturnType<typeof generateDailySummary>>());

  useEffect(() => {
    let mounted = true;
    const readSession = async () => {
      const { data: authData } = await supabase.auth.getSession();
      if (!mounted) return;
      setSession(authData.session);
      setAuthReady(true);
    };
    void readSession();
    const { data: subscription } = supabase.auth.onAuthStateChange((event, nextSession) => {
      setSession(nextSession);
      if (nextSession && (event === "SIGNED_IN" || event === "TOKEN_REFRESHED")) {
        localStorage.removeItem("life-tracker-demo-active");
        setDemoMode(false);
      }
      setAuthReady(true);
    });
    const onVisible = () => { if (document.visibilityState === "visible") void readSession(); };
    const onPageShow = () => void readSession();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      mounted = false;
      subscription.subscription.unsubscribe();
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, []);

  const user = demoMode ? DEMO_USER : session?.user || null;
  activeOwner.current = user?.id;
  const ownerSyncItems = syncItems.filter(item => item.ownerId === user?.id);
  const currentSyncItems = ownerSyncItems.filter(item => !item.supersededBy);
  const aiCopies: PendingAiRecovery[] = user && !demoMode ? pendingAiRecoveries(user.id) : [];

  useEffect(() => {
    setCloudReady(false);
    if (!user) { setData(null); return; }
    if (demoMode) { setData(loadDemoData()); setLoading(false); setLoadError(""); return; }
    let cancelled = false;
    setLoading(true); setLoadError("");
    void (async () => {
      let cached: AppData | null = null;
      try {
        cached = await cachedAppData(user);
        if (cached && !cancelled) setData(cached);
        await syncOutbox(user.id);
        const fresh = await fetchAppData(user);
        if (!cancelled) { setData(fresh); setCloudReady(true); }
      } catch (error) {
        if (!cached && !cancelled) setData({ records: [], trips: [], rates: [], settings: defaultSettings(user.id), profile: defaultProfile(user), changelogs: [] });
        if (!cancelled) setLoadError(error instanceof Error ? error.message : "暂时无法读取云端数据");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user, demoMode]);

  useEffect(() => {
    let cancelled = false;
    const onOnline = async () => {
      setOnline(navigator.onLine);
      setClockNow(new Date());
      if (!navigator.onLine || !user || demoMode) return;
      try {
        const count = await syncOutbox(user.id);
        const fresh = await fetchAppData(user);
        if (cancelled || activeOwner.current !== user.id) return;
        setData(fresh); setCloudReady(true); setLoadError("");
        if (count) showToast(`${count} 条本地记录已同步到云端`);
      } catch { if (!cancelled) setCloudReady(false); }
    };
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    window.addEventListener("focus", onOnline);
    const onVisible = () => { if (document.visibilityState === "visible") void onOnline(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline); window.removeEventListener("focus", onOnline); document.removeEventListener("visibilitychange", onVisible); };
  }, [user, demoMode]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => { const items = user && !demoMode ? await listMutations(user.id) : []; if (!cancelled) setSyncItems(items); };
    void refresh(); window.addEventListener(OUTBOX_CHANGED, refresh); window.addEventListener(AI_RECOVERY_CHANGED, refresh);
    return () => { cancelled = true; window.removeEventListener(OUTBOX_CHANGED, refresh); window.removeEventListener(AI_RECOVERY_CHANGED, refresh); };
  }, [user, demoMode]);
  useEffect(() => { const timer = window.setInterval(() => setClockNow(new Date()), 30_000); return () => window.clearInterval(timer); }, []);

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
      if (!current || !user || activeOwner.current !== user.id || current.profile.user_id !== user.id) return current;
      const next = recipe(current);
      if (demoMode) saveDemoData(next);
      else void updateCachedData(user.id, next).catch(() => showToast("设备缓存未写入，请勿关闭未同步草稿"));
      return next;
    });
  }, [user, demoMode]);

  function savedRow<T>(result: SaveResult, ownerId: string): T {
    if (activeOwner.current !== ownerId) throw new Error("账号已切换，请在原账号中查看保存结果");
    if (result.state === "failed" || result.state === "conflict") throw new Error(result.error);
    if (result.state === "pending") showToast("已保存在此设备，等待云端确认；请勿清理网站数据");
    return result.row as T;
  }

  async function saveRecord(draft: RecordDraft) {
    if (!user || !data) return;
    const record = makeRecord(user, draft);
    const result = demoMode ? null : await persistRecord(record);
    const saved = result ? savedRow<LifeRecord>(result, user.id) : record;
    updateData((current) => ({ ...current, records: [saved, ...current.records] }));
    if (!result || result.state === "confirmed") showToast(demoMode ? "已保存到本地演示" : "已保存到云端");
  }

  async function updateRecord(record: LifeRecord, serverConfirmed = false) {
    if (!user || record.user_id !== user.id) throw new Error("账号不匹配");
    try {
      const previous = data?.records.find((item) => item.id === record.id);
      const saved = demoMode || serverConfirmed ? normalizeRecord(record as unknown as Record<string, unknown>) : savedRow<LifeRecord>(await persistRecord(record, previous), user.id);
      if (activeOwner.current !== user.id) return;
      updateData((current) => ({ ...current, records: current.records.map((item) => item.id === record.id ? saved : item) }));
    } catch (error) { showToast(error instanceof Error ? error.message : "保存失败，本地副本已保留"); throw error; }
  }

  async function uploadRecordImage(file: File) {
    if (!user || demoMode || !navigator.onLine) throw new Error("图片上传需要登录并联网。");
    if (!["image/jpeg", "image/png", "image/webp", "image/heic"].includes(file.type) || file.size > 10 * 1024 * 1024 || file.size === 0) throw new Error("请选择不超过 10 MB 的 JPEG、PNG、WebP 或 HEIC 图片。");
    const ownerId = user.id;
    if ((await supabase.auth.getSession()).data.session?.user.id !== ownerId) throw new Error("账号已切换，请重新登录。");
    const path = `${ownerId}/${crypto.randomUUID()}`;
    const { error } = await supabase.storage.from("record-images").upload(path, file, { contentType: file.type, upsert: false });
    if (error) throw new Error("图片上传失败，请检查网络和存储权限。");
    if (activeOwner.current !== ownerId) throw new Error("账号已切换，图片未关联到记录。");
    return path;
  }

  async function saveEditedRecord(record: LifeRecord) {
    if (!user || record.user_id !== user.id || activeOwner.current !== user.id) throw new Error("账号已切换，请在原账号中保存。");
    const current = data?.records.find(item => item.id === record.id);
    if (!current || current.updated_at !== record.updated_at) throw new Error("记录已变化，请关闭编辑并核对最新内容。");
    const saved = demoMode ? normalizeRecord(record as unknown as Record<string, unknown>) : savedRow<LifeRecord>(await persistRecord(record, record), user.id);
    if (activeOwner.current !== user.id) throw new Error("账号已切换，请在原账号中查看结果。");
    updateData(currentData => ({ ...currentData, records: currentData.records.map(item => item.id === record.id ? saved : item) }));
  }

  async function attachRecordImage(record: LifeRecord, file: File) {
    const path = await uploadRecordImage(file);
    await saveEditedRecord({ ...record, image_path: path });
  }

  async function deleteRecord(record: LifeRecord) {
    if (!user || record.user_id !== user.id || record.record_type === "trip") throw new Error("无法删除此记录。");
    if (demoMode) { updateData(current => ({ ...current, records: current.records.filter(item => item.id !== record.id) })); return; }
    if (!navigator.onLine) throw new Error("删除需要联网，请先同步记录。");
    const ownerId = user.id;
    if ((await listMutations(ownerId)).some(item => item.table === "records" && item.entityId === record.id && !item.supersededBy)) throw new Error("这条记录还有待处理的同步内容，请先处理后再删除。");
    if ((await supabase.auth.getSession()).data.session?.user.id !== ownerId) throw new Error("账号已切换。");
    const { data: deleted, error } = await supabase.from("records").delete().eq("id", record.id).eq("user_id", ownerId).eq("updated_at", record.updated_at).select("id");
    if (error) throw new Error("删除未确认，请刷新并检查网络后重试。");
    if (!deleted?.length) throw new Error("记录可能已更改或删除，请刷新后核对。");
    if (activeOwner.current !== ownerId) return;
    updateData(current => ({ ...current, records: current.records.filter(item => item.id !== record.id) }));
    showToast(record.image_path ? "记录已删除；关联图片仍保留在私有存储中" : "记录已删除");
  }

  async function saveTrip(draft: TripDraft) {
    if (!user) throw new Error("尚未登录");
    const trip = makeTrip(user, draft);
    const saved = demoMode ? trip : savedRow<ReturnType<typeof makeTrip>>(await persistTrip(trip), user.id);
    updateData((current) => ({ ...current, trips: [saved, ...current.trips] }));
    return saved;
  }

  async function updateTrip(trip: ReturnType<typeof makeTrip>) {
    if (!user) throw new Error("尚未登录");
    const saved = demoMode ? trip : savedRow<ReturnType<typeof makeTrip>>(await persistTrip(trip, data?.trips.find((item) => item.id === trip.id)), user.id);
    updateData((current) => ({ ...current, trips: current.trips.map((item) => item.id === trip.id ? saved : item) }));
  }

  async function updateSettings(settings: UserSettings) {
    if (!user) return;
    try {
      const saved = demoMode ? settings : savedRow<UserSettings>(await persistSettings(settings, data?.settings), user.id);
      updateData((current) => ({ ...current, settings: saved }));
    } catch (error) { showToast(error instanceof Error ? error.message : "设置保存失败"); }
  }

  async function updateProfile(profile: UserProfile, avatar?: Blob, message = "资料已保存") {
    if (!user) return;
    const nextProfile = avatar && !demoMode ? { ...profile, avatar_url: await uploadAvatar(user, avatar), updated_at: new Date().toISOString() } : profile;
    const result = demoMode ? null : await persistProfile(nextProfile, data?.profile);
    const saved = result ? savedRow<UserProfile>(result, user.id) : nextProfile;
    updateData((current) => ({ ...current, profile: saved }));
    if (message && (!result || result.state === "confirmed")) showToast(message);
  }

  async function handleRateRefresh() {
    if (!user || !data) return;
    const currencies = [...new Set(data.records.filter((record) => record.record_type === "expense" && record.currency).map((record) => record.currency as Currency))];
    if (!currencies.length) { showToast("先记一笔外币消费吧"); return; }
    setRefreshingRates(true);
    try {
      const fetched = await refreshRates(user, data.settings.base_currency, currencies, !demoMode);
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
    return activeTrip(data?.trips || [], clockNow);
  }, [data?.trips, clockNow]);
  const summaryDay = currentTrip ? `${currentTrip.id}:${tripToday(currentTrip, clockNow)}` : "";
  const summaryContext = JSON.stringify((data?.trips || []).filter(trip => { const today = tripToday(trip, clockNow); return trip.start_date <= today && trip.end_date >= today; }).map(trip => [trip.id, tripToday(trip, clockNow), trip.timezone]).sort((a, b) => a[0].localeCompare(b[0])));
  useEffect(() => setDailySummary(""), [summaryDay, summaryContext, user?.id]);

  useEffect(() => {
    const ownerId = user?.id;
    if (!ownerId || !data || data.profile.user_id !== ownerId || !currentTrip || !validTimeZone(currentTrip.timezone) || demoMode || !online || dailySummary) return;
    const hasPlans = plansForDay(data.records, currentTrip, tripToday(currentTrip, clockNow)).some(record => record.plan_status === "planned");
    if (!hasPlans) return;
    let cancelled = false;
    const requestKey = `${ownerId}:${summaryContext}`;
    let request = summaryRequests.current.get(requestKey);
    if (!request) {
      request = (async () => {
        const cached = await loadAutomaticSummary(ownerId, summaryContext);
        if (activeOwner.current !== ownerId) return { action: "daily_summary" as const, skipped: true, result: "" };
        if (cached) return { action: "daily_summary" as const, result: cached };
        if (!await claimAutomaticSummary(ownerId, summaryContext) || activeOwner.current !== ownerId) return { action: "daily_summary" as const, skipped: true, result: "" };
        const result = await generateDailySummary(summaryContext);
        if (result.result && !result.skipped) {
          try { await saveAutomaticSummary(ownerId, summaryContext, result.result); }
          catch { return { ...result, warning: [result.warning, "摘要已生成，但本机暂时无法缓存；刷新后可能需要在设置中手动查看。"].filter(Boolean).join("；") }; }
        }
        return result;
      })().finally(() => summaryRequests.current.delete(requestKey));
      summaryRequests.current.set(requestKey, request);
    }
    void request.then((result) => { if (!cancelled && activeOwner.current === ownerId && !result.skipped && result.result) { setDailySummary(result.result); if (result.warning) showToast(result.warning); } }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [clockNow, currentTrip, dailySummary, data, demoMode, online, summaryContext, user?.id]);

  const currentDay = currentTrip ? tripDayNumber(currentTrip, clockNow) : 0;
  const pendingChangelog = data?.profile.has_seen_onboarding
    ? data.changelogs.find((item) => isVersionNewer(item.version, data.profile.last_seen_version))
    : undefined;

  if (!authReady) return <LoadingScreen label="正在打开你的记录空间" />;
  if (!user) return <LoginScreen onStartDemo={async () => { await startDemoSession(); localStorage.setItem("life-tracker-demo-active", "true"); setDemoMode(true); setData(loadDemoData()); }} />;
  if (!data || data.profile.user_id !== user.id) return <LoadingScreen label="正在整理你的时间线" />;

  return (
    <div className="app-shell">
      <header className="app-header">
        <button className="app-brand" onClick={() => setView("timeline")}><BrandLogo className="header-brand-logo" /><b>Life Tracker</b></button>
        <nav className="desktop-nav" aria-label="主导航">
          <button className={view === "timeline" ? "active" : ""} onClick={() => setView("timeline")}><ListFilter size={17} />记录</button>
          <button className={view === "planner" ? "active" : ""} onClick={() => setView("planner")}><CalendarRange size={17} />行程规划</button>
        </nav>
        <div className="header-actions">
          <button className={`connection ${online ? "online" : "offline"} ${demoMode ? "demo" : ""}`} onClick={() => setShowSyncIssues(true)}>{online ? <Cloud size={15} /> : <CloudOff size={15} />}{demoMode ? "本地演示" : currentSyncItems.some(item => item.state === "failed" || item.state === "conflict") || aiCopies.length ? `同步待处理 ${currentSyncItems.length + aiCopies.length}` : currentSyncItems.length ? `待同步 ${currentSyncItems.length}` : !online ? "离线" : cloudReady ? "已同步" : "未确认云端"}</button>
          <button className={`icon-button ${view === "settings" ? "active" : ""}`} aria-label="设置" onClick={() => setView("settings")}><Settings size={19} /></button>
          <ProfileAvatar profile={data.profile} className="mini-avatar" />
        </div>
      </header>

      {!online && <div className="offline-banner"><WifiOff size={15} />当前离线。你仍可查看缓存并记录，联网后会自动同步。</div>}
      {loadError && <div className="setup-banner"><b>暂未确认云端数据</b><span>{loadError}。本地副本会保留，请检查网络、权限或数据库迁移。</span></div>}
      {data.trips.some(trip => !validTimeZone(trip.timezone)) && <div className="setup-banner"><b>有行程使用了无效时区</b><span>请进入行程编辑，重新选择标准时区。首页日期暂按 UTC 显示，修正前请勿依赖自动日期匹配。</span></div>}

      <main className="app-main">
        {view === "timeline" && (
          <>
            <section className="home-heading" aria-label="今日概览"><p>{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(clockNow)}</p><h1>你好，{data.profile.display_name || "朋友"}</h1></section>
            {currentTrip && <button className="current-trip glass-card" onClick={() => { setPlannerTripId(currentTrip.id); setView("planner"); }}><span className="current-trip-icon"><Plane size={19} /></span><div><small>进行中的行程 · 第 {currentDay} 天</small><strong>{currentTrip.name}</strong><p>{dailySummary || `${currentTrip.destination} · ${currentTrip.start_date} — ${currentTrip.end_date}`}</p></div><ChevronRight /></button>}
            {currentTrip && !demoMode && !dailySummary && <p className="field-help">今日摘要未生成，可在设置中重试。</p>}
            <div className="home-quick-grid"><QuickComposer trips={data.trips} isDemo={demoMode} defaultCurrency={data.settings.base_currency} onSave={saveRecord} /><HomeRouteSearch trips={data.trips} records={data.records} isDemo={demoMode} onSave={saveRecord} /></div>
            <div className="filter-row">
              <div className="filter-tabs" role="tablist" aria-label="记录类型">{filters.map((item) => { const Icon = item.icon; return <button role="tab" aria-selected={filter === item.value} className={filter === item.value ? "active" : ""} onClick={() => setFilter(item.value)} key={item.value}><Icon size={15} />{item.label}<span>{item.value === "all" ? data.records.filter((record) => !record.parent_plan_id).length : data.records.filter((record) => record.record_type === item.value && !record.parent_plan_id).length}</span></button>; })}</div>
              <button className="planner-link" onClick={() => setView("planner")}><MapPinned size={16} />行程规划<ChevronRight size={15} /></button>
            </div>
            {filter === "expense" && <Suspense fallback={<div className="chart-loading glass-card"><LoaderCircle className="spin" />正在整理消费统计…</div>}><ExpenseStats records={data.records} rates={data.rates} baseCurrency={data.settings.base_currency} refreshing={refreshingRates} onRefresh={handleRateRefresh} /></Suspense>}
            <Timeline records={data.records} trips={data.trips} filter={filter} baseCurrency={data.settings.base_currency} onSaveRecord={saveRecord} onUpdateRecord={updateRecord} onEditRecord={setEditingRecordId} onDeleteRecord={deleteRecord} onAttachImage={attachRecordImage} onDetachImage={record => saveEditedRecord({ ...record, image_path: null })} isDemo={demoMode} onStatus={(record, status) => void updateRecord({ ...record, plan_status: status, updated_at: new Date().toISOString() }).catch(() => undefined)} />
          </>
        )}
        {view === "planner" && <Planner key={plannerTripId || "all"} trips={data.trips} records={data.records} initialTripId={plannerTripId} baseCurrency={data.settings.base_currency} isDemo={demoMode} onSaveTrip={saveTrip} onUpdateTrip={updateTrip} onSaveRecord={saveRecord} onUpdateRecord={updateRecord} onEditRecord={setEditingRecordId} onDeleteRecord={deleteRecord} onAttachImage={attachRecordImage} onDetachImage={record => saveEditedRecord({ ...record, image_path: null })} />}
        {view === "settings" && <SettingsPanel user={user} settings={data.settings} profile={data.profile} changelogs={data.changelogs} online={online} isDemo={demoMode} summaryContext={summaryContext} onUpdate={(settings) => void updateSettings(settings)} onUpdateProfile={(profile, avatar) => updateProfile(profile, avatar)} onResetDemo={() => { const next = resetDemoData(); setData(next); showToast("演示数据已重置"); }} onSignOut={() => { if (demoMode) { localStorage.removeItem("life-tracker-demo-active"); setDemoMode(false); setData(null); } else void supabase.auth.signOut(); }} />}
      </main>

      <button className="floating-add" aria-label="快速记录" onClick={() => setComposerOpen(true)}><Plus size={25} /></button>
      {editingRecordId && data.records.find(item => item.id === editingRecordId) && <RecordEditor key={editingRecordId} record={data.records.find(item => item.id === editingRecordId)!} trips={data.trips} isDemo={demoMode} onClose={() => setEditingRecordId(null)} onSave={saveEditedRecord} onUpload={uploadRecordImage} />}
      {composerOpen && <div className="composer-modal"><div className="composer-modal-inner"><QuickComposer compact isDemo={demoMode} trips={data.trips} defaultCurrency={data.settings.base_currency} onSave={saveRecord} onClose={() => setComposerOpen(false)} /></div></div>}

      <nav className="mobile-nav" aria-label="移动端导航"><button className={view === "timeline" && filter !== "expense" ? "active" : ""} onClick={() => { setView("timeline"); setFilter("all"); }}><ListFilter /><span>记录</span></button><button className={view === "planner" ? "active" : ""} onClick={() => setView("planner")}><Route /><span>行程</span></button><button className="mobile-add" aria-label="快速记录" onClick={() => setComposerOpen(true)}><Plus /></button><button className={filter === "expense" && view === "timeline" ? "active" : ""} onClick={() => { setView("timeline"); setFilter("expense"); }}><ReceiptText /><span>消费</span></button><button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}><CircleUserRound /><span>我的</span></button></nav>

      {toast && <div className="toast" role="status" aria-live="polite"><Sparkles size={15} />{toast}</div>}
      {showSyncIssues && <SyncStatusDialog key={user.id} items={ownerSyncItems} aiCopies={aiCopies} online={online} cloudReady={cloudReady} isDemo={demoMode} onClose={() => setShowSyncIssues(false)} onResolved={async () => { const fresh = await fetchAppData(user); if (activeOwner.current === user.id) { setData(fresh); setCloudReady(true); } }} onRetrySave={async () => { if (!user) return; await retryFailedMutations(user.id); await syncOutbox(user.id); const fresh = await fetchAppData(user); if (activeOwner.current === user.id) { setData(fresh); setCloudReady(true); } }} onRetryAi={async () => { if (!user) return; const result = await retryAiPersistence(user.id); if (activeOwner.current !== user.id) return; if (result.errors.length) throw new Error(result.errors.join("；")); showToast(`${result.saved} 份 AI 结果已保存，没有重新调用 AI`); }} />}
      {loading && <div className="sync-loader" role="status" aria-live="polite"><LoaderCircle className="spin" size={14} />正在同步</div>}
      {!data.profile.has_seen_onboarding && <Onboarding onComplete={() => updateProfile({ ...data.profile, has_seen_onboarding: true, updated_at: new Date().toISOString() }, undefined, "")} />}
      {data.profile.has_seen_onboarding && pendingChangelog && <WhatsNew changelog={pendingChangelog} onDismiss={() => updateProfile({ ...data.profile, last_seen_version: pendingChangelog.version, updated_at: new Date().toISOString() }, undefined, "")} />}
    </div>
  );
}

function LoadingScreen({ label }: { label: string }) {
  return <div className="loading-screen"><BrandLogo className="loading-brand-logo" /><LoaderCircle className="spin" /><p>{label}</p></div>;
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
