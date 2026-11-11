# 完整界面与样式精确参考

快照：2026-11-12，V2.0.0本地修复候选工作树，未部署。由build-documentation-reference.mjs机械生成；每块保存原始字节和SHA256。

先读[最新验收](../ACCEPTANCE-2026-10-01.md)、[重建规范](../REBUILD-SPEC.md)和[恢复流程](../DEPLOYMENT-ROLLBACK.md)。这是代码快照，不保证所有发布门禁已完成。SQL含历史身份种子，新项目先安全替换。包中无云端历史数据、用户上传图片或服务私钥。

## src/App.tsx

<!-- source: src/App.tsx sha256: 546b3f19731bb34a67253cdd3be521f0d499a9ea6b179ff50859cf89f82a6e07 encoding: utf8 -->
````tsx
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
            {currentTrip && <button className="current-trip glass-card" onClick={() => { setPlannerTripId(currentTrip.id); setView("planner"); }}><span className="current-trip-icon"><Plane size={19} /></span><div><small>你正在进行</small><strong>{currentTrip.name} · Day {currentDay}</strong><p>{dailySummary || `${currentTrip.destination}，今天也去留下一点什么吧。`}</p></div><ChevronRight /></button>}
            {currentTrip && !demoMode && !dailySummary && <p className="field-help">今日摘要在此设备自动尝试一次；若未生成，可在设置中手动生成。</p>}
            <div className="home-quick-grid"><QuickComposer trips={data.trips} isDemo={demoMode} defaultCurrency={data.settings.base_currency} onSave={saveRecord} /><HomeRouteSearch trips={data.trips} records={data.records} isDemo={demoMode} onSave={saveRecord} /></div>
            <div className="filter-row">
              <div className="filter-tabs" role="tablist">{filters.map((item) => { const Icon = item.icon; return <button role="tab" aria-selected={filter === item.value} className={filter === item.value ? "active" : ""} onClick={() => setFilter(item.value)} key={item.value}><Icon size={15} />{item.label}<span>{item.value === "all" ? data.records.filter((record) => !record.parent_plan_id).length : data.records.filter((record) => record.record_type === item.value && !record.parent_plan_id).length}</span></button>; })}</div>
              <button className="planner-link" onClick={() => setView("planner")}><MapPinned size={16} />行程规划<ChevronRight size={15} /></button>
            </div>
            {filter === "expense" && <Suspense fallback={<div className="chart-loading glass-card"><LoaderCircle className="spin" />正在整理消费统计…</div>}><ExpenseStats records={data.records} rates={data.rates} baseCurrency={data.settings.base_currency} refreshing={refreshingRates} onRefresh={handleRateRefresh} /></Suspense>}
            <Timeline records={data.records} trips={data.trips} filter={filter} baseCurrency={data.settings.base_currency} onSaveRecord={saveRecord} onUpdateRecord={updateRecord} isDemo={demoMode} onStatus={(record, status) => void updateRecord({ ...record, plan_status: status, updated_at: new Date().toISOString() }).catch(() => undefined)} />
          </>
        )}
        {view === "planner" && <Planner key={plannerTripId || "all"} trips={data.trips} records={data.records} initialTripId={plannerTripId} baseCurrency={data.settings.base_currency} isDemo={demoMode} onSaveTrip={saveTrip} onUpdateTrip={updateTrip} onSaveRecord={saveRecord} onUpdateRecord={updateRecord} />}
        {view === "settings" && <SettingsPanel user={user} settings={data.settings} profile={data.profile} changelogs={data.changelogs} online={online} isDemo={demoMode} summaryContext={summaryContext} onUpdate={(settings) => void updateSettings(settings)} onUpdateProfile={(profile, avatar) => updateProfile(profile, avatar)} onResetDemo={() => { const next = resetDemoData(); setData(next); showToast("演示数据已重置"); }} onSignOut={() => { if (demoMode) { localStorage.removeItem("life-tracker-demo-active"); setDemoMode(false); setData(null); } else void supabase.auth.signOut(); }} />}
      </main>

      <button className="floating-add" aria-label="快速记录" onClick={() => setComposerOpen(true)}><Plus size={25} /></button>
      {composerOpen && <div className="composer-modal"><div className="composer-modal-inner"><QuickComposer compact isDemo={demoMode} trips={data.trips} defaultCurrency={data.settings.base_currency} onSave={saveRecord} onClose={() => setComposerOpen(false)} /></div></div>}

      <nav className="mobile-nav" aria-label="移动端导航"><button className={view === "timeline" ? "active" : ""} onClick={() => setView("timeline")}><Sparkles /><span>记录</span></button><button className={view === "planner" ? "active" : ""} onClick={() => setView("planner")}><Route /><span>行程</span></button><button className="mobile-add" aria-label="快速记录" onClick={() => setComposerOpen(true)}><Plus /></button><button className={filter === "expense" && view === "timeline" ? "active" : ""} onClick={() => { setView("timeline"); setFilter("expense"); }}><ReceiptText /><span>消费</span></button><button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}><CircleUserRound /><span>我的</span></button></nav>

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

````

## src/components/BrandLogo.tsx

<!-- source: src/components/BrandLogo.tsx sha256: a701e2d0c017b360f057300d7f6f26765880265d0058d7dd37657e898d79c37b encoding: utf8 -->
````tsx
const BRAND_LOGO_URL = `${import.meta.env.BASE_URL}life-tracker-logo-v112.png`;

export function BrandLogo({ className = "" }: { className?: string }) {
  return <img className={`brand-logo ${className}`.trim()} src={BRAND_LOGO_URL} alt="" aria-hidden="true" draggable={false} />;
}

````

## src/components/ExpenseStats.tsx

<!-- source: src/components/ExpenseStats.tsx sha256: 3346f0f940254d7262bec2b6d579b4bd65cf00f7f8052995995fb6e848fb4a31 encoding: utf8 -->
````tsx
import { useMemo, useState } from "react";
import { ArrowUpRight, RefreshCw, WalletCards } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Currency, ExchangeRate, LifeRecord } from "../types";
import { CATEGORY_META, formatMoney } from "../types";
import { CHART_COLORS, CHART_TOOLTIP_STYLE } from "../lib/designTokens";
import { dateInZone } from "../lib/tripDates";
import { deviceTimeZone } from "../lib/calendar";

interface Props {
  records: LifeRecord[];
  rates: ExchangeRate[];
  baseCurrency: Currency;
  refreshing: boolean;
  onRefresh: () => void;
}

type Range = "7d" | "30d" | "all";

export function convertExpense(record: LifeRecord, quote: Currency, rates: ExchangeRate[]) {
  if (record.amount == null || !record.currency) return 0;
  if (record.currency === quote) return record.amount;
  const direct = rates
    .filter((rate) => rate.base_currency === record.currency && rate.quote_currency === quote)
    .sort((a, b) => b.rate_date.localeCompare(a.rate_date))[0];
  return direct ? record.amount * direct.rate : 0;
}

export function ExpenseStats({ records, rates, baseCurrency, refreshing, onRefresh }: Props) {
  const [range, setRange] = useState<Range>("30d");
  const expenses = useMemo(() => {
    const days = range === "7d" ? 7 : range === "30d" ? 30 : null;
    const cutoff = days ? Date.now() - days * 86_400_000 : 0;
    return records.filter((record) => record.record_type === "expense" && new Date(record.event_at).getTime() >= cutoff);
  }, [records, range]);

  const total = expenses.reduce((sum, record) => sum + convertExpense(record, baseCurrency, rates), 0);
  const unresolved = expenses.filter((record) => record.currency !== baseCurrency && !rates.some((rate) => rate.base_currency === record.currency && rate.quote_currency === baseCurrency)).length;
  const categoryData = Object.entries(CATEGORY_META).map(([key, meta], index) => ({
    key,
    name: meta.label,
    color: CHART_COLORS[index % CHART_COLORS.length],
    value: expenses.filter((record) => record.expense_category === key).reduce((sum, record) => sum + convertExpense(record, baseCurrency, rates), 0)
  })).filter((item) => item.value > 0);

  const dailyMap = new Map<string, number>();
  expenses.forEach((record) => {
    const key = dateInZone(record.event_at, deviceTimeZone());
    dailyMap.set(key, (dailyMap.get(key) || 0) + convertExpense(record, baseCurrency, rates));
  });
  const dailyData = [...dailyMap.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date: date.slice(5).replace("-", "/"), value }));
  const biggest = [...categoryData].sort((a, b) => b.value - a.value)[0];

  return (
    <section className="stats-section">
      <div className="stats-toolbar">
        <div><p className="eyebrow">消费概览</p><h2>看见钱花去了哪里</h2></div>
        <div className="range-switch">{(["7d", "30d", "all"] as Range[]).map((item) => <button className={range === item ? "active" : ""} onClick={() => setRange(item)} key={item}>{item === "all" ? "全部" : item === "7d" ? "7 天" : "30 天"}</button>)}</div>
      </div>

      <div className="summary-grid">
        <article className="total-card glass-card">
          <div className="summary-icon"><WalletCards /></div>
          <p>折合总花费</p>
          <strong>{formatMoney(total, baseCurrency)}</strong>
          <div className="summary-foot"><span>{expenses.length} 笔消费</span><button onClick={onRefresh} disabled={refreshing}><RefreshCw className={refreshing ? "spin" : ""} size={14} />更新汇率</button></div>
          {unresolved > 0 && <small>{unresolved} 笔外币消费等待汇率</small>}
        </article>
        <article className="insight-card glass-card">
          <span>本期最多</span>
          <strong>{biggest?.name || "还没有数据"}</strong>
          <p>{biggest ? `${formatMoney(biggest.value, baseCurrency)} · ${total ? Math.round(biggest.value / total * 100) : 0}%` : "记一笔消费后，这里会出现洞察"}</p>
          <ArrowUpRight size={20} />
        </article>
      </div>

      <div className="charts-grid">
        <article className="chart-card glass-card">
          <header><div><h3>分类占比</h3><p>按主币种统一换算</p></div></header>
          {categoryData.length ? <div className="pie-layout"><div className="pie-chart"><ResponsiveContainer width="100%" height={220}><PieChart><Pie data={categoryData} dataKey="value" innerRadius={58} outerRadius={84} paddingAngle={4} stroke="none">{categoryData.map((item) => <Cell key={item.key} fill={item.color} />)}</Pie><Tooltip formatter={(value) => formatMoney(Number(value), baseCurrency)} contentStyle={CHART_TOOLTIP_STYLE} itemStyle={{ color: "var(--text)" }} labelStyle={{ color: "var(--muted)" }} /></PieChart></ResponsiveContainer><span><b>{expenses.length}</b>笔</span></div><div className="chart-legend">{categoryData.map((item) => <div key={item.key}><i style={{ background: item.color }} /><span>{item.name}</span><b>{total ? Math.round(item.value / total * 100) : 0}%</b></div>)}</div></div> : <EmptyChart />}
        </article>
        <article className="chart-card glass-card">
          <header><div><h3>每日趋势</h3><p>每一天的消费节奏</p></div></header>
          {dailyData.length ? <ResponsiveContainer width="100%" height={235}><BarChart data={dailyData} margin={{ top: 10, right: 4, left: -22, bottom: 0 }}><CartesianGrid vertical={false} stroke="var(--border)" strokeDasharray="4 4" /><XAxis dataKey="date" stroke="var(--muted)" tickLine={false} axisLine={false} fontSize={13} /><YAxis stroke="var(--muted)" tickLine={false} axisLine={false} fontSize={13} /><Tooltip formatter={(value) => formatMoney(Number(value), baseCurrency)} contentStyle={CHART_TOOLTIP_STYLE} itemStyle={{ color: "var(--text)" }} labelStyle={{ color: "var(--muted)" }} /><Bar dataKey="value" fill="var(--accent)" radius={[4, 4, 0, 0]} maxBarSize={28} /></BarChart></ResponsiveContainer> : <EmptyChart />}
        </article>
      </div>
    </section>
  );
}

function EmptyChart() {
  return <div className="empty-chart"><span /><span /><span /><p>有消费记录后，图表会在这里生长</p></div>;
}

````

## src/components/FlightDetailsView.tsx

<!-- source: src/components/FlightDetailsView.tsx sha256: d8fb209944529d3befc91a882391e4f9361a3b4092ff57b0dc4d514da8f631e1 encoding: utf8 -->
````tsx
import { Route } from "lucide-react";
import type { LifeRecord } from "../types";
import { flightDisplay, flightStatusLabel, FLIGHT_CLOCK_LABELS } from "../lib/flightDisplay";
import { FlightDurationSummary } from "./FlightDurationSummary";
import { utcOffsetLabel } from "../lib/flightDuration";

export function FlightDetailsView({ record, original = false }: { record: LifeRecord; original?: boolean }) {
  const view = flightDisplay(original ? { ...record, actual_info_matched: false } : record);
  if (!view) return null;
  const { details, actual } = view;
  return <div className="flight-current-view">
    {view.matched && <div className="flight-view-status"><b>{flightStatusLabel(actual!.status)}</b><span>优先显示已匹配信息，缺失项保留计划值</span></div>}
    <FlightDurationSummary details={details} label={view.durationLabel} description={view.durationDescription} />
    <div className="transport-route-grid">
      <div><small>{view.matched ? FLIGHT_CLOCK_LABELS[view.departureSource] : "计划"}起飞 · 当地时间</small><b>{details.departure.airport}</b><span>{details.departure.date} · {details.departure.time}{details.departure.terminal && ` · 航站楼 ${details.departure.terminal}${view.matched && !actual?.departure.terminal ? "（计划值）" : ""}`}</span><i>{details.departure.timezone}{details.departure.utc_offset_minutes != null && ` · ${utcOffsetLabel(details.departure.utc_offset_minutes)}`}</i></div>
      <Route size={18} />
      <div><small>{view.matched ? FLIGHT_CLOCK_LABELS[view.arrivalSource] : "计划"}降落 · 当地时间</small><b>{details.arrival.airport}</b><span>{details.arrival.date} · {details.arrival.time}{details.arrival.terminal && ` · 航站楼 ${details.arrival.terminal}${view.matched && !actual?.arrival.terminal ? "（计划值）" : ""}`}</span><i>{details.arrival.timezone}{details.arrival.utc_offset_minutes != null && ` · ${utcOffsetLabel(details.arrival.utc_offset_minutes)}`}</i></div>
    </div>
    <div className="transport-facts">
      {details.airline && <span>航空公司 <b>{details.airline}</b></span>}
      {details.gate && <span>登机口 <b>{details.gate}</b>{view.matched && <small>{actual?.departure.gate ? "接口" : "计划值"}</small>}</span>}
      {details.seat && <span>座位 <b>{details.seat}</b><small>手动记录</small></span>}
      {details.aircraft_type && <span>机型 <b>{details.aircraft_type}</b>{view.matched && <small>{actual?.aircraft_type ? "接口" : "计划值"}</small>}</span>}
      {details.registration && <span>注册号 <b>{details.registration}</b>{view.matched && <small>{actual?.registration ? "接口" : "计划值"}</small>}</span>}
      {actual && actual.arrival.delay_minutes > 0 && <span>到达延误 <b>{actual.arrival.delay_minutes} 分钟</b></span>}
    </div>
    {details.notes && <p className="flight-record-notes">{details.notes}</p>}
  </div>;
}

````

## src/components/FlightDurationSummary.tsx

<!-- source: src/components/FlightDurationSummary.tsx sha256: c103795386ae7dbdacfd022ec7b750a9362249b313fac6bf436df09858f04e79 encoding: utf8 -->
````tsx
import { Clock3 } from "lucide-react";
import type { FlightDetails } from "../types";
import { calculateFlightDuration } from "../lib/flightDuration";

export function FlightDurationSummary({ details, label = "计划飞行时长", description }: { details: FlightDetails; label?: string; description?: string }) {
  const duration = calculateFlightDuration(details.departure, details.arrival);
  return <div className={`flight-duration-summary field-span-2 ${duration.status}`} role="status" aria-live="polite"><Clock3 size={17} /><div><b>{label}{duration.status === "ready" && <strong>{duration.label}</strong>}</b><p>{duration.status === "ready" ? description || "按两地当地时间及时区换算，自动处理跨日与时差；计划用时不等于实际空中飞行时间。" : duration.message}</p></div></div>;
}

````

## src/components/GuidanceOverlays.tsx

<!-- source: src/components/GuidanceOverlays.tsx sha256: 3f59cbbd2a0da8b711b6d1bb8d35d105bea2683fd0dd9195a2f5734d31733a8b encoding: utf8 -->
````tsx
import { useState } from "react";
import { ArrowRight, Check, ListFilter, MapPinned, Plus, Settings, SlidersHorizontal, Sparkles } from "lucide-react";
import type { Changelog } from "../types";
import { Button, DialogSurface } from "./ui";

const ONBOARDING_STEPS = [
  { title: "随时快速记录", description: "从页面顶部或底部加号开始，几秒内记下消费、行程或突然闪过的念头。日常内容建议优先使用文字，必要时再补充图片。", icon: Plus },
  { title: "所有片段汇成时间线", description: "保存后的内容会按时间倒序排列，最近发生的事情永远在最前面。", icon: ListFilter },
  { title: "按类型快速筛选", description: "使用顶部标签，只查看消费、行程或随记，让回顾更聚焦。", icon: SlidersHorizontal },
  { title: "提前安排下一次出发", description: "进入行程规划，按天添加计划；出发后还能打卡并关联实际消费和随记。", icon: MapPinned },
  { title: "把 Life Tracker 调成你的样子", description: "在设置中调整主币种、外观、昵称和头像。", icon: Settings }
];

export function Onboarding({ onComplete }: { onComplete: () => Promise<void> }) {
  const [step, setStep] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const item = ONBOARDING_STEPS[step];
  const Icon = item.icon;

  async function complete() {
    setSaving(true);
    setError("");
    try { await onComplete(); } catch (failure) { setError(failure instanceof Error ? failure.message : "资料保存失败，请重试"); } finally { setSaving(false); }
  }

  return (
    <div className="guidance-backdrop" role="presentation">
      <DialogSurface className="guidance-card" aria-labelledby="onboarding-title">
        <header><span>第一次使用</span><button onClick={() => void complete()} disabled={saving}>跳过</button></header>
        <div className="guidance-icon"><Icon /></div>
        <p className="guidance-step">{step + 1} / {ONBOARDING_STEPS.length}</p>
        <h2 id="onboarding-title">{item.title}</h2>
        <p>{item.description}</p>
        {error && <p className="field-error">{error}</p>}
        <div className="guidance-dots" aria-hidden="true">{ONBOARDING_STEPS.map((_, index) => <span className={index === step ? "active" : ""} key={index} />)}</div>
        <Button className="full" disabled={saving} onClick={() => step === ONBOARDING_STEPS.length - 1 ? void complete() : setStep(step + 1)}>{step === ONBOARDING_STEPS.length - 1 ? <><Check size={17} />开始记录</> : <>下一步<ArrowRight size={17} /></>}</Button>
      </DialogSurface>
    </div>
  );
}

export function WhatsNew({ changelog, onDismiss }: { changelog: Changelog; onDismiss: () => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  async function dismiss() {
    setSaving(true);
    setError("");
    try { await onDismiss(); } catch (failure) { setError(failure instanceof Error ? failure.message : "阅读记录保存失败，请重试"); } finally { setSaving(false); }
  }
  return (
    <div className="guidance-backdrop" role="presentation">
      <DialogSurface className="guidance-card whats-new-card" aria-labelledby="whats-new-title">
        <div className="guidance-icon"><Sparkles /></div>
        <p className="eyebrow">版本 {changelog.version}</p>
        <h2 id="whats-new-title">Life Tracker 更新了</h2>
        <ul>{changelog.summary.map((item) => <li key={item}><Check size={16} /><span>{item}</span></li>)}</ul>
        {error && <p className="field-error">{error}</p>}
        <Button className="full" disabled={saving} onClick={() => void dismiss()}>{saving ? "保存中…" : "知道了"}</Button>
      </DialogSurface>
    </div>
  );
}

````

## src/components/HomeRouteSearch.tsx

<!-- source: src/components/HomeRouteSearch.tsx sha256: d09d84892f743d6cabe2300981cb709a26fa377155ca20366e05c6b8653cf298 encoding: utf8 -->
````tsx
import { useMemo, useState, type FormEvent } from "react";
import { ArrowRight, CalendarDays, Clock3, LoaderCircle, MapPin, Route, Save, Sparkles, X } from "lucide-react";
import type { LifeRecord, MetroDetails, RecordDraft, Trip } from "../types";
import { queryTransitRoute, TRANSIT_AI_ERROR } from "../lib/transitAi";
import { transportTitle } from "../lib/transport";
import { dateInZone, zonedDateTimeToIso } from "../lib/tripDates";
import { flightTimeOptions, utcOffsetLabel } from "../../supabase/functions/_shared/flightTime";

interface Props {
  trips: Trip[];
  records: LifeRecord[];
  isDemo: boolean;
  onSave: (draft: RecordDraft) => Promise<void>;
}

function localToday(trip: Trip) {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: trip.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function defaultDate(trip: Trip) {
  const today = localToday(trip);
  if (today < trip.start_date) return trip.start_date;
  if (today > trip.end_date) return trip.end_date;
  return today;
}

function currentTime() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

export function HomeRouteSearch({ trips, records, isDemo, onSave }: Props) {
  const availableTrips = useMemo(() => trips.filter((trip) => !trip.archived_at && trip.end_date >= localToday(trip)).sort((left, right) => left.start_date.localeCompare(right.start_date)), [trips]);
  const [open, setOpen] = useState(false);
  const [origin, setOrigin] = useState("");
  const [destination, setDestination] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showSave, setShowSave] = useState(false);
  const [tripId, setTripId] = useState(availableTrips[0]?.id || "");
  const initialTrip = availableTrips.find((trip) => trip.id === tripId) || availableTrips[0];
  const [planDate, setPlanDate] = useState(initialTrip ? defaultDate(initialTrip) : "");
  const [planTime, setPlanTime] = useState(currentTime());
  const [localChoice, setLocalChoice] = useState<{ key: string; offset?: number }>({ key: "" });
  const localKey = `${tripId}|${planDate}|${planTime}|${initialTrip?.timezone}`;
  const localOffset = localChoice.key === localKey ? localChoice.offset : undefined;
  let localOptions: ReturnType<typeof flightTimeOptions> = [];
  try { if (initialTrip) localOptions = flightTimeOptions({ date: planDate, time: planTime, timezone: initialTrip.timezone }); } catch { /* Save reports invalid clocks, retaining the generated route. */ }

  function close() {
    setOpen(false);
    setOrigin("");
    setDestination("");
    setResult("");
    setError("");
    setShowSave(false);
  }

  function chooseTrip(nextId: string) {
    setTripId(nextId);
    const trip = availableTrips.find((item) => item.id === nextId);
    if (trip) setPlanDate(defaultDate(trip));
  }

  async function query(event: FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError("");
    setResult("");
    setShowSave(false);
    try {
      setResult(await queryTransitRoute(origin, destination, `请规划从“${origin.trim()}”到“${destination.trim()}”的实用路线。`, undefined, isDemo));
    } catch (queryError) {
      setError(queryError instanceof Error ? queryError.message : TRANSIT_AI_ERROR);
    } finally {
      setLoading(false);
    }
  }

  async function saveRoute() {
    const trip = availableTrips.find((item) => item.id === tripId);
    if (!trip || !result || !planDate || !planTime) return;
    setSaving(true);
    setError("");
    try {
      const details: MetroDetails = { origin: origin.trim(), destination: destination.trim(), estimated_departure_time: planTime, route_description: result };
      const sameDayCount = records.filter((record) => record.trip_id === trip.id && record.record_type === "trip" && dateInZone(record.event_at, trip.timezone) === planDate).length;
      await onSave({
        record_type: "trip",
        content: transportTitle("metro", details),
        location: `${details.origin} → ${details.destination}`,
        event_at: zonedDateTimeToIso(planDate, planTime, trip.timezone, localOffset),
        trip_id: trip.id,
        plan_status: "planned",
        sort_order: (sameDayCount + 1) * 1000,
        transport_type: "metro",
        transport_details: details
      });
      close();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "路线保存失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  }

  const selectedTrip = availableTrips.find((trip) => trip.id === tripId);

  return <>
    <button className="home-route-entry glass-card" type="button" onClick={() => setOpen(true)}><span><Route size={21} /></span><div><b>AI 路线查询</b><small>不用先建行程，随时问两地之间怎么走</small></div><ArrowRight size={18} /></button>
    {open && <div className="modal-backdrop"><section className="modal-card glass-card home-route-modal" role="dialog" aria-modal="true" aria-labelledby="home-route-title"><header><div><p className="eyebrow">快速路线</p><h2 id="home-route-title">从哪里，到哪里？</h2></div><button className="icon-button" type="button" aria-label="关闭路线查询" onClick={close}><X /></button></header>
      <form className="home-route-query" onSubmit={query}><label><span><MapPin size={14} />出发地</span><input autoFocus value={origin} onChange={(event) => setOrigin(event.target.value)} placeholder="例如 UCSB 加大圣塔芭芭拉分校" maxLength={120} required /></label><label><span><Route size={14} />目的地</span><input value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="例如 洛杉矶机场" maxLength={120} required /></label><button className="primary-button" disabled={loading || !origin.trim() || !destination.trim()}>{loading ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{loading ? "正在规划…" : "查询路线"}</button></form>
      {error && <p className="field-error" role="alert">{error}</p>}
      {result && <div className="home-route-result"><div><Sparkles size={17} /><b>路线建议</b></div><p>{result}</p><small>AI 结果仅供规划参考，请以当地实时交通信息为准。</small></div>}
      {result && showSave && localOptions.length > 1 && <label>重复当地时间 · 必选<select aria-label="重复当地时间" value={localOffset ?? ""} onChange={event => setLocalChoice({ key: localKey, offset: event.target.value === "" ? undefined : Number(event.target.value) })}><option value="" disabled>请选择第一次或第二次</option>{localOptions.map((option, index) => <option key={option.utcOffsetMinutes} value={option.utcOffsetMinutes}>{index === 0 ? "第一次" : "第二次"} · {utcOffsetLabel(option.utcOffsetMinutes)}</option>)}</select><small>夏令时结束时此时刻出现两次。选择后可直接保存，不需要重新查询 AI。</small></label>}
      {result && showSave && availableTrips.length > 0 && <div className="home-route-save"><label>保存到行程<select value={tripId} onChange={(event) => chooseTrip(event.target.value)}>{availableTrips.map((trip) => <option value={trip.id} key={trip.id}>{trip.name} · {trip.destination}</option>)}</select></label><div><label><span><CalendarDays size={14} />日期</span><input type="date" min={selectedTrip?.start_date} max={selectedTrip?.end_date} value={planDate} onChange={(event) => setPlanDate(event.target.value)} required /></label><label><span><Clock3 size={14} />时间</span><input type="time" value={planTime} onChange={(event) => setPlanTime(event.target.value)} required /></label></div><button className="primary-button" type="button" disabled={saving || !tripId || !planDate || !planTime} onClick={() => void saveRoute()}>{saving ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />}{saving ? "正在保存…" : "保存为行程计划"}</button></div>}
      {result && <footer className="home-route-actions"><button className="secondary-button" type="button" onClick={close}>仅供参考，不保存</button>{availableTrips.length > 0 ? !showSave && <button className="primary-button" type="button" onClick={() => setShowSave(true)}><Save size={16} />保存到某个行程</button> : <small>当前没有进行中或未来的行程，本次结果可以直接参考。</small>}</footer>}
    </section></div>}
  </>;
}

````

## src/components/LoginScreen.tsx

<!-- source: src/components/LoginScreen.tsx sha256: 89e89a28fcf3f6483c9268a01331f88385479c2288e924a1924e382f1267e627 encoding: utf8 -->
````tsx
import { useState, type FormEvent } from "react";
import { ArrowRight, FlaskConical, KeyRound, Mail, MapPinned, NotebookPen, ReceiptText, ShieldCheck, Sparkles } from "lucide-react";
import { supabase } from "../lib/supabase";
import { BrandLogo } from "./BrandLogo";

export function LoginScreen({ onStartDemo }: { onStartDemo: () => Promise<void> }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "code" | "verifying">("idle");
  const [error, setError] = useState("");
  const [demoLoading, setDemoLoading] = useState(false);

  async function sendCode(event?: FormEvent) {
    event?.preventDefault();
    if (!email.trim()) return;
    const returnToCodeEntry = status === "code" || status === "verifying";
    setStatus("sending");
    setError("");
    const { error: authError } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { shouldCreateUser: true }
    });
    if (authError) {
      setError(authError.message.toLowerCase().includes("rate limit") ? "请求过于频繁，请稍后再试" : "验证码发送失败，请稍后重试");
      setStatus(returnToCodeEntry ? "code" : "idle");
      return;
    }
    setCode("");
    setStatus("code");
  }

  async function verifyCode(event: FormEvent) {
    event.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError("请输入邮件中的 6 位数字验证码");
      return;
    }
    setStatus("verifying");
    setError("");
    const { error: authError } = await supabase.auth.verifyOtp({ email: email.trim(), token: code, type: "email" });
    if (authError) {
      const message = authError.message.toLowerCase();
      setError(message.includes("expired") || message.includes("invalid") ? "验证码无效或已过期，请检查后重试" : "验证失败，请稍后重试");
      setStatus("code");
    }
  }

  return (
    <main className="login-shell">
      <section className="login-layout">
        <div className="login-story">
          <div className="brand-mark"><BrandLogo className="login-brand-logo" /> Life Tracker</div>
          <h1>把生活的片段，<br /><span>好好收在一起。</span></h1>
          <p>旅行足迹、每一笔消费和突然闪过的念头，都能在几秒内记下。</p>
          <div className="feature-row">
            <div><span className="feature-icon coral"><ReceiptText size={19} /></span><b>消费</b><small>金额与分类统计</small></div>
            <div><span className="feature-icon blue"><MapPinned size={19} /></span><b>行程</b><small>计划与实际打通</small></div>
            <div><span className="feature-icon violet"><NotebookPen size={19} /></span><b>随记</b><small>留住日常瞬间</small></div>
          </div>
        </div>

        <div className="glass-card login-card">
          <div className="login-card-heading">
            <span className="mail-badge"><Mail size={22} /></span>
            <div><h2>登录你的记录空间</h2><p>无需密码，输入邮件验证码即可登录。</p></div>
          </div>
          {status === "code" || status === "verifying" ? (
            <div className="sent-state">
              <span className="success-ring"><KeyRound size={28} /></span>
              <h3>验证码已发送</h3>
              <p>请输入发送到 <strong>{email}</strong> 的 6 位数字验证码。无需点击链接，也不会跳转到 Safari。</p>
              <form className="otp-form" onSubmit={verifyCode}>
                <label htmlFor="otp-code">邮箱验证码</label>
                <input id="otp-code" className="otp-code-input" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} autoFocus value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} placeholder="000000" aria-invalid={Boolean(error)} required />
                {error && <p className="field-error" role="alert">{error}</p>}
                <button className="primary-button full" disabled={status === "verifying" || code.length !== 6}>{status === "verifying" ? "正在验证…" : "验证并登录"}<ArrowRight size={18} /></button>
              </form>
              <div className="otp-secondary-actions"><button className="text-button" disabled={status === "verifying"} onClick={() => void sendCode()}>重新发送验证码</button><button className="text-button" onClick={() => { setStatus("idle"); setCode(""); setError(""); }}>换一个邮箱</button></div>
            </div>
          ) : (
            <form onSubmit={sendCode}>
              <label htmlFor="email">邮箱地址</label>
              <div className="email-field"><Mail size={18} /><input id="email" type="email" autoComplete="email" placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.target.value)} aria-invalid={Boolean(error)} aria-describedby={error ? "login-error" : undefined} required /></div>
              {error && <p className="field-error" id="login-error" role="alert">{error}</p>}
              <button className="primary-button full" disabled={status === "sending"}>
                {status === "sending" ? "正在发送…" : "发送邮箱验证码"}<ArrowRight size={18} />
              </button>
              <p className="form-hint">首次使用会自动创建账号，无需单独注册。</p>
              <div className="login-limits"><Sparkles size={15} /><p>普通账号：航班实际信息每天 2 次，路线查询、记账识别与随记润色每天共用 15 次。朋友邀请码可在登录后于设置中兑换，记录与手动规划不受额度限制。</p></div>
            </form>
          )}
          <div className="demo-entry"><span>或者先看看完整功能</span><button className="secondary-button full" disabled={demoLoading} onClick={async () => { setDemoLoading(true); setError(""); try { await onStartDemo(); } catch (demoError) { setError(demoError instanceof Error ? demoError.message : "暂时无法进入演示模式"); } finally { setDemoLoading(false); } }}><FlaskConical size={17} />{demoLoading ? "正在准备演示…" : "进入演示模式"}</button><small>无需邮箱。数据只保存在当前设备；航班使用模拟信息，AI 每台设备每天可体验 2 次。</small></div>
          <div className="privacy-note"><ShieldCheck size={17} /><span>登录后，你将拥有完全独立的账号与数据空间——你的记录只有你自己能看到，不会与其他用户共享。</span></div>
        </div>
      </section>
      <footer className="app-footer">© 2026 Sherlock Zang.</footer>
    </main>
  );
}

````

## src/components/Planner.tsx

<!-- source: src/components/Planner.tsx sha256: 4c90a122a50334f1b16f602ef88aef7bec410789e3b4a4a8ff3be37c2ad7c72f encoding: utf8 -->
````tsx
import { useMemo, useState, type FormEvent } from "react";
import { DndContext, PointerSensor, TouchSensor, closestCenter, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ArrowLeft, CalendarDays, Check, ChevronDown, ChevronRight, CirclePlus, Clock3, GripVertical, LoaderCircle, Pencil, Plus, Route, Sparkles, X } from "lucide-react";
import type { Currency, FlightDetails, LifeRecord, MetroDetails, RailDetails, RecordDraft, Trip, TripDraft } from "../types";
import { formatDateTime, formatMoney } from "../types";
import { dateInZone, zonedDateTimeToIso } from "../lib/tripDates";
import { getTransportPresentation } from "../lib/transport";
import { detectTimeZone, TIMEZONE_OPTIONS, timeZoneLabel } from "../lib/timezones";
import { QuickComposer } from "./QuickComposer";
import { TransportDetailsPanel, TransportPlanEditor, type PlanKind } from "./TransportPlanEditor";
import { generateTripRecap } from "../lib/ai";
import { flightMoveOffset, flightTripPlacement } from "../lib/flightTripPlacement";
import { normalizeScheduleDetails, scheduleDayEntries, scheduleTripDate, type ScheduleDayEntry } from "../lib/schedules";
import { ScheduleDaySection } from "./ScheduleDaySection";
import { flightDisplay } from "../lib/flightDisplay";
import { deviceTimeZone, tripToday, validTimeZone } from "../lib/calendar";
import { calculateFlightDuration, resolveFlightInstant } from "../lib/flightDuration";
import { invalidateChangedFlight } from "../lib/flightMatchState";

interface Props {
  trips: Trip[];
  records: LifeRecord[];
  onSaveTrip: (draft: TripDraft) => Promise<Trip>;
  onUpdateTrip: (trip: Trip) => Promise<void>;
  onSaveRecord: (draft: RecordDraft) => Promise<void>;
  onUpdateRecord: (record: LifeRecord, serverConfirmed?: boolean) => Promise<void>;
  initialTripId?: string;
  baseCurrency: Currency;
  isDemo?: boolean;
}

function dateRange(start: string, end: string) {
  const result: string[] = [];
  const cursor = new Date(`${start}T12:00:00Z`);
  const endDate = new Date(`${end}T12:00:00Z`);
  while (cursor <= endDate) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function planDate(record: LifeRecord, trip: Trip) {
  const schedule = normalizeScheduleDetails(record.schedule_details);
  if (schedule) return scheduleTripDate(schedule, trip);
  if (record.transport_type === "flight" && record.transport_details) return flightTripPlacement(record.transport_details as FlightDetails, trip).day;
  if (record.transport_type === "rail" && record.transport_details) return (record.transport_details as RailDetails).departure.date;
  return dateInZone(record.event_at, trip.timezone);
}

function shiftDate(date: string, offsetDays: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offsetDays);
  return value.toISOString().slice(0, 10);
}

function chronological(left: LifeRecord, right: LifeRecord) {
  return left.event_at.localeCompare(right.event_at) || (left.sort_order || 0) - (right.sort_order || 0) || left.created_at.localeCompare(right.created_at);
}

function orderedTrips(trips: Trip[]) {
  return [...trips].sort((left, right) => {
    const leftToday = tripToday(left), rightToday = tripToday(right);
    const leftGroup = left.start_date <= leftToday && left.end_date >= leftToday ? 0 : left.start_date > leftToday ? 1 : 2;
    const rightGroup = right.start_date <= rightToday && right.end_date >= rightToday ? 0 : right.start_date > rightToday ? 1 : 2;
    if (leftGroup !== rightGroup) return leftGroup - rightGroup;
    return leftGroup === 2 ? right.end_date.localeCompare(left.end_date) : left.start_date.localeCompare(right.start_date);
  });
}

export function Planner({ trips, records, onSaveTrip, onUpdateTrip, onSaveRecord, onUpdateRecord, initialTripId, baseCurrency, isDemo = false }: Props) {
  const [selectedId, setSelectedId] = useState(initialTripId || "");
  const [showCreate, setShowCreate] = useState(false);
  const selected = trips.find((trip) => trip.id === selectedId);

  if (!selected) {
    return (
      <section className="planner-home">
        <div className="section-hero"><div><p className="eyebrow">行程规划</p><h1>先把期待，排进日历。</h1><p>按天安排地点与事项，出发后直接打卡，还能把实际消费和随记挂在计划下面。</p></div><button className="primary-button" onClick={() => setShowCreate(true)}><Plus size={17} />创建行程</button></div>
        {showCreate && <TripForm onClose={() => setShowCreate(false)} onSave={async (draft) => { const trip = await onSaveTrip(draft); setSelectedId(trip.id); setShowCreate(false); }} />}
        <div className="trip-grid">
          {orderedTrips(trips).map((trip) => {
            const planCount = records.filter((record) => record.trip_id === trip.id && record.record_type === "trip").length;
            const completed = records.filter((record) => record.trip_id === trip.id && record.record_type === "trip" && record.plan_status === "completed").length;
            return <button className="trip-card glass-card" onClick={() => setSelectedId(trip.id)} key={trip.id}><span className="trip-card-icon"><Route /></span><div><p>{trip.destination}</p><h3>{trip.name}</h3><span><CalendarDays size={14} />{trip.start_date.replaceAll("-", ".")} — {trip.end_date.replaceAll("-", ".")}</span></div><div className="trip-progress"><b>{completed}/{planCount || 0}</b><small>已完成</small></div><ChevronRight /></button>;
          })}
          {!trips.length && <div className="empty-planner glass-card"><span><Route /></span><h3>还没有行程</h3><p>创建下一次出发，把机票、酒店和想去的地方提前放进来。</p><button className="secondary-button" onClick={() => setShowCreate(true)}>创建第一个行程</button></div>}
        </div>
      </section>
    );
  }

  if (!validTimeZone(selected.timezone)) return <section className="planner-home"><h2>请先修正这段行程的时区</h2><p>旧记录不会删除。选择标准时区后即可重新查看日期规划。</p><TripForm trip={selected} onClose={() => setSelectedId("")} onSave={async draft => { await onUpdateTrip({ ...selected, ...draft, updated_at: new Date().toISOString() }); }} /></section>;
  return <TripBoard trip={selected} records={records} onBack={() => setSelectedId("")} onUpdateTrip={onUpdateTrip} onSaveRecord={onSaveRecord} onUpdateRecord={onUpdateRecord} baseCurrency={baseCurrency} isDemo={isDemo} />;
}

function TripForm({ trip, records = [], onSave, onClose }: { trip?: Trip; records?: LifeRecord[]; onSave: (draft: TripDraft) => Promise<void>; onClose: () => void }) {
  const today = tripToday({ timezone: deviceTimeZone() });
  const [draft, setDraft] = useState<TripDraft>(trip ? { name: trip.name, destination: trip.destination, start_date: trip.start_date, end_date: trip.end_date, timezone: trip.timezone } : { name: "", destination: "", start_date: today, end_date: today, timezone: deviceTimeZone() });
  const [timezoneMode, setTimezoneMode] = useState<"device" | "detected" | "manual">(trip ? "manual" : "device");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!validTimeZone(draft.timezone)) { setSaveError("请重新选择标准时区后再保存"); return; }
    const outside = records.filter((record) => { const date = trip ? planDate(record, { ...trip, ...draft }) : record.event_at.slice(0, 10); return date < draft.start_date || date > draft.end_date; });
    if (outside.length && !window.confirm(`修改后有 ${outside.length} 条计划超出新的行程日期范围。这些计划不会被删除，但会暂时显示在日期范围之外。仍要保存吗？`)) return;
    setSaving(true); setSaveError("");
    try { await onSave(draft); }
    catch (error) { setSaveError(error instanceof Error ? error.message : "保存失败，草稿已保留"); }
    finally { setSaving(false); }
  }
  function updateDestination(destination: string) {
    const detected = detectTimeZone(destination);
    setDraft((current) => ({ ...current, destination, timezone: timezoneMode !== "manual" && detected ? detected : current.timezone }));
    if (timezoneMode !== "manual") setTimezoneMode(detected ? "detected" : "device");
  }
  return <div className="modal-backdrop"><form className="modal-card glass-card trip-form" onSubmit={submit}><header><div><p className="eyebrow">{trip ? "编辑行程" : "新行程"}</p><h2>{trip ? "调整这段旅程" : "下一站去哪里？"}</h2></div><button type="button" className="icon-button" aria-label="关闭行程编辑" onClick={onClose}><X /></button></header><label>行程名称<input autoFocus value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="例如：悉尼夏日漫游" required /></label><label>目的地<input value={draft.destination} onChange={(event) => updateDestination(event.target.value)} placeholder="城市或国家" required /></label><div className="form-row"><label>开始日期<input type="date" value={draft.start_date} onChange={(event) => setDraft({ ...draft, start_date: event.target.value, end_date: event.target.value > draft.end_date ? event.target.value : draft.end_date })} required /></label><label>结束日期<input type="date" min={draft.start_date} value={draft.end_date} onChange={(event) => setDraft({ ...draft, end_date: event.target.value })} required /></label></div><label>行程时区<select value={draft.timezone} onChange={(event) => { setDraft({ ...draft, timezone: event.target.value }); setTimezoneMode("manual"); }} required>{TIMEZONE_OPTIONS.map((timezone) => <option value={timezone} key={timezone}>{timeZoneLabel(timezone)}</option>)}</select><span className="field-help">{timezoneMode === "detected" ? "已根据目的地自动匹配，可手动调整" : timezoneMode === "manual" ? "已选择标准 IANA 时区" : "输入目的地后自动匹配；当前暂用设备时区"}</span></label>{saveError && <p className="field-error">{saveError}</p>}<footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? "保存中…" : trip ? "保存行程" : "创建行程"}</button></footer></form></div>;
}

function TripBoard({ trip, records, onBack, onUpdateTrip, onSaveRecord, onUpdateRecord, baseCurrency, isDemo }: { trip: Trip; records: LifeRecord[]; onBack: () => void; onUpdateTrip: Props["onUpdateTrip"]; onSaveRecord: Props["onSaveRecord"]; onUpdateRecord: Props["onUpdateRecord"]; baseCurrency: Currency; isDemo: boolean }) {
  const [addingDay, setAddingDay] = useState<string | null>(null);
  const [addingKind, setAddingKind] = useState<PlanKind>("general");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [editingTrip, setEditingTrip] = useState(false);
  const [editingOutsideId, setEditingOutsideId] = useState<string | null>(null);
  const [pendingFlightMove, setPendingFlightMove] = useState<{ original: LifeRecord; draft: LifeRecord; day: string } | null>(null);
  const [recap, setRecap] = useState("");
  const [recapLoading, setRecapLoading] = useState(false);
  const [recapError, setRecapError] = useState("");
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }), useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }));
  const days = useMemo(() => dateRange(trip.start_date, trip.end_date), [trip]);
  const plans = records.filter((record) => record.trip_id === trip.id && record.record_type === "trip" && !record.parent_plan_id);
  const outsidePlans = plans.filter((record) => { const date = planDate(record, trip); return date < trip.start_date || date > trip.end_date; }).sort(chronological);
  const editingOutsidePlan = outsidePlans.find((plan) => plan.id === editingOutsideId);

  async function handleDragEnd(event: DragEndEvent) {
    const active = plans.find((item) => item.id === event.active.id);
    if (!active || active.schedule_details || !event.over) return;
    const overId = String(event.over.id);
    const overPlan = plans.find((item) => item.id === overId);
    const targetDate = overId.startsWith("day:") ? overId.slice(4) : overPlan ? planDate(overPlan, trip) : null;
    if (!targetDate) return;
    const targetItems = plans.filter((item) => !item.schedule_details && planDate(item, trip) === targetDate).sort(chronological);
    const targetIndex = overPlan ? Math.max(0, targetItems.findIndex((item) => item.id === overPlan.id)) : targetItems.length;
    const activeFlight = active.transport_type === "flight" && active.transport_details ? active.transport_details as FlightDetails : null;
    const sourceDate = planDate(active, trip);
    if (activeFlight && targetDate === sourceDate) { await onUpdateRecord({ ...active, sort_order: (targetIndex + 1) * 1000, updated_at: new Date().toISOString() }); return; }
    if (activeFlight && flightTripPlacement(activeFlight, trip).startsBeforeTrip && !window.confirm(`这趟航班在行程开始前出发。移到 ${targetDate} 将把起飞日调整到该行程日，并同步平移降落日期。继续吗？`)) return;
    const offsetDays = activeFlight ? flightMoveOffset(activeFlight, trip, targetDate) : Math.round((new Date(`${targetDate}T12:00:00Z`).getTime() - new Date(`${sourceDate}T12:00:00Z`).getTime()) / 86_400_000);
    const currentTime = activeFlight?.departure.time || new Intl.DateTimeFormat("en-GB", { timeZone: trip.timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(active.event_at));
    const eventTimeZone = activeFlight?.departure.timezone || trip.timezone;
    const movedDetails = active.transport_type === "flight" && active.transport_details
      ? { ...(active.transport_details as FlightDetails), departure: { ...(active.transport_details as FlightDetails).departure, date: shiftDate(activeFlight!.departure.date, offsetDays), utc_offset_minutes: undefined }, arrival: { ...(active.transport_details as FlightDetails).arrival, date: shiftDate((active.transport_details as FlightDetails).arrival.date, offsetDays), utc_offset_minutes: undefined } }
      : active.transport_type === "rail" && active.transport_details
        ? { ...(active.transport_details as RailDetails), departure: { ...(active.transport_details as RailDetails).departure, date: targetDate }, arrival: { ...(active.transport_details as RailDetails).arrival, date: shiftDate((active.transport_details as RailDetails).arrival.date, offsetDays) } }
        : active.transport_details;
    const moved = { ...active, transport_details: movedDetails, sort_order: (targetIndex + 1) * 1000, updated_at: new Date().toISOString() };
    if (activeFlight) {
      const shifted = movedDetails as FlightDetails;
      if (calculateFlightDuration(shifted.departure, shifted.arrival).status !== "ready") {
        // Changing dates may introduce a repeated/nonexistent local clock. Keep
        // the original intact and let the existing editor collect the choice.
        setPendingFlightMove({ original: active, draft: moved, day: targetDate }); return;
      }
      moved.event_at = new Date(resolveFlightInstant(shifted.departure)).toISOString();
    } else {
      try { moved.event_at = zonedDateTimeToIso(targetDate, currentTime, eventTimeZone); }
      catch { setPendingFlightMove({ original: active, draft: moved, day: targetDate }); return; }
    }
    await onUpdateRecord(invalidateChangedFlight(active, moved));
  }

  async function loadRecap(regenerate = false) {
    if (regenerate && !window.confirm("重新生成会再次使用一次旅行回顾额度，是否继续？")) return;
    setRecapLoading(true); setRecapError("");
    try { const result = await generateTripRecap(trip.id, regenerate, isDemo); setRecap(result.result); setRecapError(result.warning || ""); }
    catch (error) { setRecapError(error instanceof Error ? error.message : "暂时无法生成旅行回顾"); }
    finally { setRecapLoading(false); }
  }

  return (
    <section className="trip-board">
      <header className="trip-board-header"><button className="back-button" onClick={onBack}><ArrowLeft size={18} />全部行程</button><div><p>{trip.destination}</p><h1>{trip.name}</h1><span><CalendarDays size={15} />{trip.start_date} — {trip.end_date}<i>·</i>{days.length} 天</span><button className="trip-edit-link" onClick={() => setEditingTrip(true)}><Pencil size={13} />编辑行程</button></div><div className="trip-completion"><b>{plans.filter((item) => item.plan_status === "completed").length}/{plans.length}</b><span>计划已完成</span></div></header>
      {(trip.end_date < tripToday(trip) || (plans.length > 0 && plans.every((plan) => plan.plan_status === "completed")) || isDemo) && <section className="trip-recap-card glass-card"><div><Sparkles size={18} /><span><b>本次旅行回顾</b><small>结合消费统计和少量随记生成，结果会缓存保存</small></span></div>{recap ? <><p>{recap}</p><button className="text-button" disabled={recapLoading} onClick={() => void loadRecap(true)}>{recapLoading ? "正在整理…" : "重新生成"}</button></> : <button className="secondary-button" disabled={recapLoading} onClick={() => void loadRecap(false)}>{recapLoading ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}{recapLoading ? "正在整理…" : "生成本次旅行回顾"}</button>}{recapError && <p className="field-error">{recapError}</p>}</section>}
      {outsidePlans.length > 0 && <section className="trip-range-warning"><b>{outsidePlans.length} 条计划在当前行程日期范围之外</b><p>这些计划仍然保留，没有被删除。编辑行程日期或逐条调整时间后，它们会重新回到对应日期。</p><ul>{outsidePlans.map((plan) => <li key={plan.id}><span>{planDate(plan, trip)} · {getTransportPresentation(plan).title}</span><button className="record-control-button" aria-label={`编辑${getTransportPresentation(plan).title}`} onClick={() => setEditingOutsideId(plan.id)}><Pencil size={14} />{plan.transport_type === "flight" ? "编辑航班" : "编辑计划"}</button></li>)}</ul></section>}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(event) => void handleDragEnd(event).catch(() => undefined)}>
        <div className="day-board">
          {days.map((day, index) => {
            const items = plans.filter((item) => !item.schedule_details && planDate(item, trip) === day).sort(chronological);
            return <DayColumn key={day} day={day} dayNumber={index + 1} items={items} scheduleEntries={scheduleDayEntries(plans, day)} records={records} expanded={expanded} onExpand={setExpanded} onAdd={() => { setAddingKind("general"); setAddingDay(day); }} onAddSchedule={() => { setAddingKind("all_day"); setAddingDay(day); }} addingKind={addingKind} onSaveRecord={onSaveRecord} onUpdateRecord={onUpdateRecord} trip={trip} adding={addingDay === day} onCloseAdd={() => setAddingDay(null)} baseCurrency={baseCurrency} isDemo={isDemo} />;
          })}
        </div>
      </DndContext>
      {editingTrip && <TripForm trip={trip} records={plans} onClose={() => setEditingTrip(false)} onSave={async (draft) => { await onUpdateTrip({ ...trip, ...draft, updated_at: new Date().toISOString() }); setEditingTrip(false); }} />}
      {editingOutsidePlan && <TransportPlanEditor key={editingOutsidePlan.id} modal day={planDate(editingOutsidePlan, trip)} trip={trip} count={0} record={editingOutsidePlan} isDemo={isDemo} onSave={onSaveRecord} onUpdate={onUpdateRecord} onClose={() => setEditingOutsideId(null)} />}
      {pendingFlightMove && <TransportPlanEditor key={`move-${pendingFlightMove.draft.id}`} modal day={pendingFlightMove.day} trip={trip} count={0} record={pendingFlightMove.draft} isDemo={isDemo} onSave={onSaveRecord} onUpdate={record => onUpdateRecord(invalidateChangedFlight(pendingFlightMove.original, record))} onClose={() => setPendingFlightMove(null)} />}
    </section>
  );
}

function DayColumn({ day, dayNumber, items, scheduleEntries, records, expanded, onExpand, onAdd, onAddSchedule, addingKind, onSaveRecord, onUpdateRecord, trip, adding, onCloseAdd, baseCurrency, isDemo }: { day: string; dayNumber: number; items: LifeRecord[]; scheduleEntries: ScheduleDayEntry[]; records: LifeRecord[]; expanded: string | null; onExpand: (id: string | null) => void; onAdd: () => void; onAddSchedule: () => void; addingKind: PlanKind; onSaveRecord: Props["onSaveRecord"]; onUpdateRecord: Props["onUpdateRecord"]; trip: Trip; adding: boolean; onCloseAdd: () => void; baseCurrency: Currency; isDemo: boolean }) {
  const droppable = useDroppable({ id: `day:${day}` });
  return <section ref={droppable.setNodeRef} className={`day-column ${droppable.isOver ? "drag-over" : ""}`}><header><div><strong>Day {dayNumber}</strong><span>{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "short" }).format(new Date(`${day}T12:00:00`))}</span></div><button className="icon-button" aria-label={`为 Day ${dayNumber} 添加计划`} onClick={onAdd}><Plus size={18} /></button></header>{adding && <TransportPlanEditor key={`${day}-${addingKind}`} initialKind={addingKind} day={day} trip={trip} count={items.length} isDemo={isDemo} onClose={onCloseAdd} onSave={onSaveRecord} />}<ScheduleDaySection day={day} trip={trip} entries={scheduleEntries} isDemo={isDemo} onAdd={onAddSchedule} onSave={onSaveRecord} onUpdate={onUpdateRecord} /><SortableContext items={items.map((item) => item.id)} strategy={verticalListSortingStrategy}><div className="plan-list">{items.map((item) => <SortablePlan key={item.id} item={item} actualRecords={records.filter((record) => record.parent_plan_id === item.id)} expanded={expanded === item.id} onExpand={() => onExpand(expanded === item.id ? null : item.id)} onUpdate={onUpdateRecord} onSaveRecord={onSaveRecord} trip={trip} baseCurrency={baseCurrency} isDemo={isDemo} />)}{!items.length && !adding && <button className="empty-day" onClick={onAdd}><CirclePlus size={20} /><span>{scheduleEntries.length ? "这一天还没有定时安排" : "这一天还没有安排"}</span><small>点这里添加，或把其他计划拖过来</small></button>}</div></SortableContext></section>;
}

function SortablePlan({ item, actualRecords, expanded, onExpand, onUpdate, onSaveRecord, trip, baseCurrency, isDemo }: { item: LifeRecord; actualRecords: LifeRecord[]; expanded: boolean; onExpand: () => void; onUpdate: Props["onUpdateRecord"]; onSaveRecord: Props["onSaveRecord"]; trip: Trip; baseCurrency: Currency; isDemo: boolean }) {
  const sortable = useSortable({ id: item.id });
  const style = { transform: CSS.Transform.toString(sortable.transform), transition: sortable.transition };
  const [actualMode, setActualMode] = useState<"standard" | "route" | null>(null);
  const [editing, setEditing] = useState(false);
  const presentation = getTransportPresentation(item);
  const planSubtitle = item.transport_type ? presentation.subtitle : [item.location, item.notes].filter(Boolean).join(" · ");
  const suggestedRoute = item.transport_type === "metro" ? (item.transport_details as MetroDetails | null)?.route_description || "" : "";
  const flight = item.transport_type === "flight" ? item.transport_details as FlightDetails | null : null;
  const placement = flight ? flightTripPlacement(flight, trip) : null;
  const flightView = flightDisplay(item);
  const displayTime = item.transport_type === "flight" && item.transport_details
    ? flightView!.details.departure.time
    : new Intl.DateTimeFormat("zh-CN", { timeZone: trip.timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(item.event_at));
  return <>
    <article ref={sortable.setNodeRef} style={style} className={`plan-item glass-card ${item.transport_type ? "transport-plan" : ""} ${sortable.isDragging ? "dragging" : ""} ${item.plan_status}`}>
      <div className="plan-summary"><button className="drag-handle" aria-label="拖动计划排序" {...sortable.attributes} {...sortable.listeners}><GripVertical size={18} /></button><button className="plan-check" aria-label={item.plan_status === "completed" ? "标记为计划中" : "标记完成"} onClick={() => void onUpdate({ ...item, plan_status: item.plan_status === "completed" ? "planned" : "completed", updated_at: new Date().toISOString() }).catch(() => undefined)}>{item.plan_status === "completed" && <Check size={16} />}</button><div className="plan-time">{displayTime}{flightView?.matched && <small>已匹配</small>}</div><button className="plan-content" onClick={onExpand}><strong>{presentation.title}</strong>{planSubtitle && <span><em>{planSubtitle}</em></span>}{item.transport_type && item.plan_status === "completed" && <span className="plan-completed-badge">已完成</span>}</button><button className="icon-button" aria-label={expanded ? "收起计划详情" : "展开计划详情"} onClick={onExpand}>{expanded ? <ChevronDown /> : <ChevronRight />}</button></div>
      {flight && placement && (placement.startsBeforeTrip || placement.day !== flight.departure.date) && <p className="plan-flight-carryover">{placement.startsBeforeTrip ? "行程开始前出发，归入首日。" : "按行程时区归入本日。"}原计划当地起飞 {flight.departure.date} {flight.departure.time}（{flight.departure.iata}） → 当地到达 {flight.arrival.date} {flight.arrival.time}（{flight.arrival.iata}）</p>}
      {expanded && <div className="plan-expanded">
        <TransportDetailsPanel record={item} isDemo={isDemo} onUpdate={onUpdate} onEdit={() => setEditing(true)} />
        <div className="actual-heading"><span>实际发生</span><small>{actualRecords.length} 条记录</small></div>
        {actualRecords.map((record) => <div className={`actual-row ${record.record_type}`} key={record.id}><span>{record.record_type === "expense" ? "消费" : "随记"}</span><div><b>{record.content}</b><small>{formatDateTime(record.event_at)}</small></div>{record.amount != null && record.currency && <strong>{formatMoney(record.amount, record.currency)}</strong>}</div>)}
        {actualMode ? <QuickComposer compact isDemo={isDemo} trips={[]} defaultCurrency={baseCurrency} forcedTripId={trip.id} parentPlanId={item.id} defaultType={actualMode === "route" ? "note" : undefined} initialContent={actualMode === "route" ? "实际路线" : undefined} initialNotes={actualMode === "route" ? suggestedRoute : undefined} onSave={onSaveRecord} onClose={() => setActualMode(null)} /> : <div className="actual-actions"><button className="add-actual" onClick={() => setActualMode("standard")}><Plus size={15} />添加消费或随记</button>{item.transport_type === "metro" && <button className="add-actual route-actual" onClick={() => setActualMode("route")}><Route size={15} />补记实际路线</button>}</div>}
        <div className="plan-status-actions"><button className={item.plan_status === "planned" ? "active" : ""} onClick={() => void onUpdate({ ...item, plan_status: "planned", updated_at: new Date().toISOString() }).catch(() => undefined)}><Clock3 size={14} />计划中</button><button className={item.plan_status === "completed" ? "active" : ""} onClick={() => void onUpdate({ ...item, plan_status: "completed", updated_at: new Date().toISOString() }).catch(() => undefined)}><Check size={14} />已完成</button><button className={item.plan_status === "cancelled" ? "active" : ""} onClick={() => void onUpdate({ ...item, plan_status: "cancelled", updated_at: new Date().toISOString() }).catch(() => undefined)}><X size={14} />已取消</button></div>
      </div>}
    </article>
    {editing && <TransportPlanEditor modal day={planDate(item, trip)} trip={trip} count={0} record={item} isDemo={isDemo} onSave={onSaveRecord} onUpdate={onUpdate} onClose={() => setEditing(false)} />}
  </>;
}

````

## src/components/ProfileAvatar.tsx

<!-- source: src/components/ProfileAvatar.tsx sha256: f1d511a356a10c27be22c6fa82db45aba785f54cd130e2291ca14ef5dfefeeed encoding: utf8 -->
````tsx
import type { CSSProperties } from "react";
import type { UserProfile } from "../types";

interface Props {
  profile: Pick<UserProfile, "display_name" | "avatar_url" | "avatar_color">;
  className?: string;
  imageUrl?: string | null;
}

export function ProfileAvatar({ profile, className = "", imageUrl }: Props) {
  const url = imageUrl === undefined ? profile.avatar_url : imageUrl;
  const style = { "--avatar-color": profile.avatar_color } as CSSProperties;
  return (
    <span className={`profile-avatar ${className}`} style={style} aria-hidden="true">
      {url ? <img src={url} alt="" /> : profile.display_name.trim().slice(0, 1).toUpperCase() || "L"}
    </span>
  );
}

````

## src/components/QuickComposer.tsx

<!-- source: src/components/QuickComposer.tsx sha256: ecc11ef1be9658ececb444a65f717f0d71300f7736f4b85c1e006ef1d4c098c1 encoding: utf8 -->
````tsx
import { useEffect, useRef, useState, type FormEvent } from "react";
import { CalendarDays, ChevronDown, Coffee, LoaderCircle, MapPin, NotebookPen, Plus, ReceiptText, Route, Send, ShoppingBag, Sparkles, Ticket, TrainFront, X } from "lucide-react";
import type { Currency, ExpenseCategory, RecordDraft, RecordType, Trip } from "../types";
import { CATEGORY_META, CURRENCIES, nowLocalInput, toIso } from "../types";
import { parseExpense, polishNote, type ParsedExpense } from "../lib/ai";

interface Props {
  trips: Trip[];
  defaultCurrency: Currency;
  forcedTripId?: string;
  parentPlanId?: string;
  defaultType?: RecordType;
  initialContent?: string;
  initialNotes?: string;
  compact?: boolean;
  isDemo?: boolean;
  onSave: (draft: RecordDraft) => Promise<void>;
  onClose?: () => void;
}

const typeMeta: { type: RecordType; label: string; icon: typeof ReceiptText }[] = [
  { type: "expense", label: "消费", icon: ReceiptText },
  { type: "trip", label: "行程", icon: Route },
  { type: "note", label: "随记", icon: NotebookPen }
];

const categoryIcons: Record<ExpenseCategory, typeof Coffee> = {
  food: Coffee,
  transport: TrainFront,
  shopping: ShoppingBag,
  stay: CalendarDays,
  entertainment: Ticket,
  other: Sparkles
};

export function QuickComposer({ trips, defaultCurrency, forcedTripId, parentPlanId, defaultType, initialContent, initialNotes, compact, isDemo = false, onSave, onClose }: Props) {
  const [open, setOpen] = useState(Boolean(compact));
  const [type, setType] = useState<RecordType>(defaultType || (parentPlanId ? "expense" : "note"));
  const [content, setContent] = useState(initialContent || "");
  const [notes, setNotes] = useState(initialNotes || "");
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState<Currency>(defaultCurrency);
  const [category, setCategory] = useState<ExpenseCategory>("food");
  const [location, setLocation] = useState("");
  const [eventAt, setEventAt] = useState(nowLocalInput());
  const [tripId, setTripId] = useState(forcedTripId || "");
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState("");
  const [expensePreview, setExpensePreview] = useState<ParsedExpense | null>(null);
  const [polishPreview, setPolishPreview] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setCurrency(defaultCurrency);
  }, [defaultCurrency]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 80);
  }, [open]);

  const reset = () => {
    setContent(""); setNotes(""); setAmount(""); setLocation(""); setEventAt(nowLocalInput());
    if (!forcedTripId) setTripId("");
  };

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!content.trim() || (type === "expense" && !amount)) return;
    setSaving(true); setSaveError("");
    try {
      await onSave({
      record_type: type,
      content,
      notes,
      amount: type === "expense" ? Number(amount) : undefined,
      currency: type === "expense" ? currency : undefined,
      expense_category: type === "expense" ? category : undefined,
      location: type !== "note" ? location : undefined,
      event_at: toIso(eventAt),
      trip_id: forcedTripId || tripId || undefined,
      plan_status: type === "trip" && (forcedTripId || tripId) ? "planned" : undefined,
      parent_plan_id: parentPlanId
      });
      reset();
      if (compact) onClose?.();
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "保存未完成，输入内容已保留，请核对后重试。");
    } finally {
      setSaving(false);
    }
  }

  async function runAi() {
    if (!content.trim()) return;
    if (Array.from(content.trim()).length > 200) { setAiError("内容较长，建议直接手动填写，AI 识别更适合简短描述"); return; }
    setAiLoading(true); setAiError("");
    try {
      if (type === "expense") { const result = await parseExpense(content.trim(), isDemo); setExpensePreview(result.result); setAiError(result.warning || ""); }
      if (type === "note") { const result = await polishNote(content.trim(), isDemo); setPolishPreview(result.result); setAiError(result.warning || ""); }
    } catch (error) { setAiError(error instanceof Error ? error.message : "AI 功能暂时不可用"); }
    finally { setAiLoading(false); }
  }

  function applyExpensePreview() {
    if (!expensePreview) return;
    if (expensePreview.amount != null) setAmount(String(expensePreview.amount));
    if (expensePreview.currency && CURRENCIES.some((item) => item.code === expensePreview.currency)) setCurrency(expensePreview.currency as Currency);
    if (expensePreview.category) setCategory(expensePreview.category);
    if (expensePreview.merchant) { setContent(expensePreview.merchant); setLocation(expensePreview.merchant); }
    if (expensePreview.note) setNotes((current) => [current, expensePreview.note].filter(Boolean).join(" · "));
    setExpensePreview(null);
  }

  if (!open && !compact) {
    return (
      <button className="quick-collapsed glass-card" onClick={() => setOpen(true)}>
        <span className="quick-plus"><Plus size={22} /></span>
        <span><b>现在，想记下什么？</b><small>消费、行程或一个念头</small></span>
        <span className="quick-types"><ReceiptText /><Route /><NotebookPen /></span>
      </button>
    );
  }

  return (
    <form className={`composer glass-card ${compact ? "composer-compact" : ""}`} onSubmit={submit}>
      <div className="composer-top">
        <div className="type-switch" role="tablist" aria-label="记录类型">
          {typeMeta.filter((item) => !(parentPlanId && item.type === "trip")).map((item) => {
            const Icon = item.icon;
            return <button type="button" role="tab" aria-selected={type === item.type} className={type === item.type ? `active ${item.type}` : ""} onClick={() => setType(item.type)} key={item.type}><Icon size={17} />{item.label}</button>;
          })}
        </div>
        <button type="button" className="icon-button" aria-label="收起快速输入" onClick={() => { setOpen(false); onClose?.(); }}><X size={19} /></button>
      </div>

      <div className="composer-ai-input"><input ref={inputRef} className="composer-main-input" value={content} maxLength={4000} onChange={(event) => { setContent(event.target.value); setAiError(""); }} placeholder={type === "expense" ? "也可以写：在羽田买咖啡，1100日元" : type === "trip" ? "要去哪里或做什么？" : "此刻发生了什么？"} />{(type === "expense" || type === "note") && <button type="button" className="ai-inline-button" disabled={aiLoading || !content.trim()} onClick={() => void runAi()}>{aiLoading ? <LoaderCircle className="spin" size={14} /> : <Sparkles size={14} />}{type === "expense" ? "AI 识别" : "AI 帮我润色"}</button>}</div>
      {aiError && <p className="field-error composer-ai-error">{aiError}</p>}

      {type === "expense" && (
        <div className="expense-fields">
          <div className="amount-box"><span>{CURRENCIES.find((item) => item.code === currency)?.symbol}</span><input type="number" min="0" step="any" inputMode="decimal" placeholder="0" value={amount} onChange={(event) => setAmount(event.target.value)} /><label>金额</label></div>
          <label className="select-field"><span>币种</span><select value={currency} onChange={(event) => setCurrency(event.target.value as Currency)}>{CURRENCIES.map((item) => <option key={item.code} value={item.code}>{item.code} · {item.label}</option>)}</select><ChevronDown size={16} /></label>
          <div className="category-picker">
            {Object.entries(CATEGORY_META).map(([key, meta]) => {
              const Icon = categoryIcons[key as ExpenseCategory];
              return <button type="button" className={category === key ? "active" : ""} onClick={() => setCategory(key as ExpenseCategory)} key={key}><Icon size={17} /><span>{meta.label}</span></button>;
            })}
          </div>
        </div>
      )}

      <div className="composer-grid">
        {type !== "note" && <label className="soft-field"><MapPin size={16} /><input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="地点（选填）" /></label>}
        <label className="soft-field"><CalendarDays size={16} /><input type="datetime-local" value={eventAt} onChange={(event) => setEventAt(event.target.value)} /></label>
        {!forcedTripId && trips.length > 0 && <label className="soft-field"><Route size={16} /><select value={tripId} onChange={(event) => setTripId(event.target.value)}><option value="">不关联行程</option>{trips.map((trip) => <option value={trip.id} key={trip.id}>{trip.name}</option>)}</select></label>}
      </div>
      <textarea value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="补充备注（选填）" rows={2} />
      {saveError && <p className="field-error" role="alert">{saveError}</p>}
      <div className="composer-actions">
        <span>{isDemo ? "演示记录只保存在当前设备" : navigator.onLine ? "将保存到你的私人空间" : "当前离线，将在联网后同步"}</span>
        <button className="primary-button" disabled={saving || !content.trim() || (type === "expense" && !amount)}>{saving ? "保存中…" : "记下来"}<Send size={16} /></button>
      </div>
      {expensePreview && <div className="nested-modal-backdrop"><section className="modal-card glass-card ai-preview-modal"><header><div><p className="eyebrow">AI 识别预览</p><h2>确认记账信息</h2></div><button type="button" className="icon-button" onClick={() => setExpensePreview(null)}><X /></button></header><div className="ai-preview-fields"><span>金额 <b>{expensePreview.amount ?? "未识别"}</b></span><span>币种 <b>{expensePreview.currency || "未识别"}</b></span><span>分类 <b>{expensePreview.category ? CATEGORY_META[expensePreview.category].label : "未识别"}</b></span><span>商户 <b>{expensePreview.merchant || "未识别"}</b></span><span>备注 <b>{expensePreview.note || "无"}</b></span></div><p className="ai-disclaimer">AI 不确定的内容不会猜测。应用后仍可继续修改，只有点击“记下来”才会保存。</p><footer><button type="button" className="secondary-button" onClick={() => setExpensePreview(null)}>保留手动填写</button><button type="button" className="primary-button" onClick={applyExpensePreview}>应用到表单</button></footer></section></div>}
      {polishPreview && <div className="nested-modal-backdrop"><section className="modal-card glass-card ai-preview-modal"><header><div><p className="eyebrow">润色预览</p><h2>选择保留哪一版</h2></div><button type="button" className="icon-button" onClick={() => setPolishPreview("")}><X /></button></header><div className="note-compare"><article><b>原文</b><p>{content}</p></article><article><b>润色后</b><p>{polishPreview}</p></article></div><footer><button type="button" className="secondary-button" onClick={() => setPolishPreview("")}>保留原文</button><button type="button" className="primary-button" onClick={() => { setContent(polishPreview); setPolishPreview(""); }}>采用润色版本</button></footer></section></div>}
    </form>
  );
}

````

## src/components/ScheduleDaySection.tsx

<!-- source: src/components/ScheduleDaySection.tsx sha256: 9cc529d8574095b31764a00b1cdf07871f3ff563aa76b6c0fdc1a4eb53cec41e encoding: utf8 -->
````tsx
import { useState } from "react";
import { BedDouble, CalendarDays, Check, Pencil, Plus, RotateCcw, X } from "lucide-react";
import type { LifeRecord, RecordDraft, Trip } from "../types";
import { scheduleDayNotice, scheduleNights, type ScheduleDayEntry } from "../lib/schedules";
import { TransportPlanEditor } from "./TransportPlanEditor";

interface Props {
  day: string;
  trip: Trip;
  entries: ScheduleDayEntry[];
  isDemo: boolean;
  onAdd: () => void;
  onSave: (draft: RecordDraft) => Promise<void>;
  onUpdate: (record: LifeRecord) => Promise<void>;
}

export function ScheduleDaySection({ day, trip, entries, isDemo, onAdd, onSave, onUpdate }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = entries.find((entry) => entry.record.id === editingId);
  const notice = scheduleDayNotice(entries);
  return <section className="schedule-day-section" aria-label={`${day} 全天与住宿`}>
    <header><span><CalendarDays size={16} />全天与住宿</span><button className="text-button" onClick={onAdd}><Plus size={14} />添加</button></header>
    {notice.change && <p className="hotel-change-notice">{notice.change}</p>}
    {notice.conflict && <p className="field-error">{notice.conflict}</p>}
    <div className="schedule-cards">{entries.map(({ record, details, phase }) => {
      const hotel = details.kind === "hotel";
      const phaseLabel = { all_day: "全天", check_in: "入住", staying: "连住", check_out: "退房" }[phase];
      const phaseTime = phase === "check_in" ? details.check_in_time : phase === "check_out" ? details.check_out_time : "";
      const Icon = hotel ? BedDouble : CalendarDays;
      return <article className={`schedule-card glass-card ${record.plan_status} ${phase}`} key={record.id}>
        <div className="schedule-card-top"><span className="schedule-phase"><Icon size={16} />{phaseLabel}{phaseTime && ` · ${phaseTime}`}</span><span className={`status ${record.plan_status}`}>{{ planned: "计划中", completed: "已完成", cancelled: "已取消" }[record.plan_status || "planned"]}</span></div>
        <h3>{record.content}</h3>
        <p>{hotel ? `${details.start_date} 入住 → ${details.end_date} 退房 · ${scheduleNights(details)} 晚` : details.start_date === details.end_date ? "全天安排" : `${details.start_date} — ${details.end_date}（含结束日）`}</p>
        {phase === "check_out" && <small>本日仅退房，不计入住宿夜晚。</small>}
        {record.location && <p>{record.location}</p>}
        {details.booking_reference && <p>预订号：{details.booking_reference}</p>}
        {record.notes && <p className="schedule-notes">{record.notes}</p>}
        <div className="record-control-buttons"><button className="record-control-button" aria-label={`编辑${record.content}`} onClick={() => setEditingId(record.id)}><Pencil size={14} />编辑{hotel ? "住宿" : "事项"}</button>
          <button className="record-control-button" onClick={() => void onUpdate({ ...record, plan_status: record.plan_status === "planned" ? "completed" : "planned", updated_at: new Date().toISOString() }).catch(() => undefined)}>{record.plan_status === "planned" ? <Check size={14} /> : <RotateCcw size={14} />}{record.plan_status === "planned" ? "标记完成" : record.plan_status === "completed" ? "撤回完成" : "恢复计划"}</button>
          {record.plan_status === "planned" && <button className="record-control-button" onClick={() => void onUpdate({ ...record, plan_status: "cancelled", updated_at: new Date().toISOString() }).catch(() => undefined)}><X size={14} />取消计划</button>}
        </div>
      </article>;
    })}</div>
    {!entries.length && <p className="schedule-empty">可添加全天事项，或跨日的酒店住宿。</p>}
    {editing && <TransportPlanEditor key={editing.record.id} modal day={editing.details.start_date} trip={trip} count={0} record={editing.record} isDemo={isDemo} onSave={onSave} onUpdate={onUpdate} onClose={() => setEditingId(null)} />}
  </section>;
}

````

## src/components/SettingsPanel.tsx

<!-- source: src/components/SettingsPanel.tsx sha256: cc4164480417274c2228d2251380da0cf23bd9567534003d637d2235696982ac encoding: utf8 -->
````tsx
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Bell, BookOpen, Bot, Check, ChevronRight, Cloud, HeartHandshake, History, ImagePlus, KeyRound, LoaderCircle, LogOut, Mail, Moon, Palette, Pencil, RefreshCcw, Search, ShieldCheck, Smartphone, Sparkles, Sun, Users, WalletCards, X } from "lucide-react";
import type { User } from "@supabase/supabase-js";
import type { ApiQuotaSnapshot, Changelog, Currency, OwnerManagedUser, ThemeMode, UserProfile, UserSettings } from "../types";
import { CURRENCIES } from "../types";
import { APP_VERSION } from "../version";
import { ProfileAvatar } from "./ProfileAvatar";
import { generateDailySummary } from "../lib/ai";
import { getApiQuota, getOwnerManagedUsers, redeemInvite, setOwnerManagedUserTier } from "../lib/account";
import { AVATAR_COLORS } from "../lib/designTokens";
import { SettingsRow } from "./ui";

interface Props {
  user: User;
  settings: UserSettings;
  profile: UserProfile;
  changelogs: Changelog[];
  online: boolean;
  summaryContext?: string;
  onUpdate: (settings: UserSettings) => void;
  onUpdateProfile: (profile: UserProfile, avatar?: Blob) => Promise<void>;
  onSignOut: () => void;
  isDemo?: boolean;
  onResetDemo?: () => void;
}

export function SettingsPanel({ user, settings, profile, changelogs, online, summaryContext, onUpdate, onUpdateProfile, onSignOut, isDemo = false, onResetDemo }: Props) {
  const [editingProfile, setEditingProfile] = useState(false);
  const [showingReleaseHistory, setShowingReleaseHistory] = useState(false);
  const [showingUsageGuide, setShowingUsageGuide] = useState(false);
  const [showingPrivacy, setShowingPrivacy] = useState(false);
  const [showingOwnerAdmin, setShowingOwnerAdmin] = useState(false);
  const [quota, setQuota] = useState<ApiQuotaSnapshot | null>(null);
  const [quotaError, setQuotaError] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [inviteMessage, setInviteMessage] = useState("");
  const [inviteLoading, setInviteLoading] = useState(false);
  const [summary, setSummary] = useState("");
  const [summaryLoading, setSummaryLoading] = useState(false);
  const update = (patch: Partial<UserSettings>) => onUpdate({ ...settings, ...patch, updated_at: new Date().toISOString() });

  useEffect(() => {
    if (isDemo) return;
    void getApiQuota().then(setQuota).catch((error) => setQuotaError(error instanceof Error ? error.message : "暂时无法读取额度"));
  }, [isDemo]);

  async function submitInvite(event: FormEvent) {
    event.preventDefault(); if (!inviteCode.trim()) return;
    setInviteLoading(true); setInviteMessage("");
    try { const result = await redeemInvite(inviteCode); setInviteMessage(result.tier === "owner" ? "当前账号已是 Owner" : "邀请码已兑换，朋友权限已生效"); setInviteCode(""); setQuota(await getApiQuota()); }
    catch (error) { setInviteMessage(error instanceof Error ? error.message : "邀请码验证失败"); }
    finally { setInviteLoading(false); }
  }

  async function loadDailySummary() {
    setSummaryLoading(true); setSummary("");
    try { const result = await generateDailySummary(summaryContext); setSummary(result.skipped ? "今天没有待进行的行程计划，不会调用 AI。" : [result.result, result.warning].filter(Boolean).join("\n\n")); }
    catch (error) { setSummary(error instanceof Error ? error.message : "今日摘要暂时不可用"); }
    finally { setSummaryLoading(false); }
  }

  return (
    <section className="settings-page">
      <div className="section-hero"><div><p className="eyebrow">设置</p><h1>让记录更像你。</h1><p>选择常用币种和显示方式，数据会跟随你的账号。</p></div></div>
      <div className="settings-layout">
        <div className="settings-main">
          <section className="settings-card glass-card">
            <header><span className="settings-icon blue"><WalletCards /></span><div><h2>主币种</h2><p>统计图表会统一换算到这个币种</p></div></header>
            <div className="currency-grid">{CURRENCIES.map((currency) => <button className={settings.base_currency === currency.code ? "active" : ""} key={currency.code} onClick={() => update({ base_currency: currency.code as Currency })}><span>{currency.symbol}</span><div><b>{currency.code}</b><small>{currency.label}</small></div>{settings.base_currency === currency.code && <Check size={16} />}</button>)}</div>
          </section>
          <section className="settings-card glass-card">
            <header><span className="settings-icon violet"><Palette /></span><div><h2>外观</h2><p>可以跟随设备，也可以固定选择</p></div></header>
            <div className="theme-options">{([{"value":"system","label":"跟随系统","icon":Smartphone},{"value":"dark","label":"深色","icon":Moon},{"value":"light","label":"浅色","icon":Sun}] as const).map((item) => { const Icon = item.icon; return <button className={settings.theme === item.value ? "active" : ""} onClick={() => update({ theme: item.value as ThemeMode })} key={item.value}><Icon /><span>{item.label}</span>{settings.theme === item.value && <Check size={16} />}</button>; })}</div>
          </section>
          <section className="settings-card glass-card">
            <SettingsRow icon={Bell} title="今日计划摘要" description={isDemo ? "演示模式暂不开放" : "当天首次打开时按需生成并缓存"} disabled={isDemo || summaryLoading} onClick={() => void loadDailySummary()} trailing={summaryLoading ? <LoaderCircle className="spin" /> : <ChevronRight />} />
            {summary && <div className="daily-summary"><Sparkles size={16} /><p>{summary}</p></div>}
            <SettingsRow icon={BookOpen} title="使用说明" description="快速记录、交通模板与 AI 路线查询" onClick={() => setShowingUsageGuide(true)} trailing={<ChevronRight />} />
            <SettingsRow icon={History} title="更新记录" description="查看 Life Tracker 的所有版本与新功能" onClick={() => setShowingReleaseHistory(true)} trailing={<><em>v{APP_VERSION}</em><ChevronRight /></>} />
            <SettingsRow icon={ShieldCheck} title="隐私与数据" description="所有云端数据均受账号隔离保护" onClick={() => setShowingPrivacy(true)} trailing={<ChevronRight />} />
          </section>
          <section className="settings-card glass-card smart-service-card">
            <header><span className="settings-icon violet"><Bot /></span><div><h2>智能服务与权限</h2><p>额度按北京时间重置，记录与手动编辑始终不受影响</p></div></header>
            <div className="tier-heading"><span>{isDemo ? "Demo" : quota ? ({ standard: "Standard", friend: "Friend", owner: "Owner" } as const)[quota.tier] : "正在读取…"}</span><small>{isDemo ? "AI 每台设备每天 2 次；航班使用模拟数据" : tierDescription(quota?.tier)}</small></div>
            {!isDemo && quota && <QuotaOverview quota={quota} />}
            {quotaError && <p className="field-error">{quotaError}</p>}
            {!isDemo && quota?.tier === "standard" && <form className="invite-form" onSubmit={submitInvite}><label><KeyRound size={15} /><input value={inviteCode} onChange={(event) => setInviteCode(event.target.value)} placeholder="输入朋友邀请码" autoComplete="off" /></label><button className="secondary-button" disabled={inviteLoading || !inviteCode.trim()}>{inviteLoading ? "验证中…" : "兑换"}</button></form>}
            {inviteMessage && <p className="invite-message">{inviteMessage}</p>}
            {isDemo && <button className="secondary-button reset-demo-button" onClick={onResetDemo}><RefreshCcw size={15} />重置演示数据</button>}
          </section>
          {!isDemo && quota?.tier === "owner" && <section className="settings-card glass-card owner-admin-card">
            <button className="settings-row" onClick={() => setShowingOwnerAdmin(true)}><span className="settings-icon blue"><Users /></span><div><b>账号与权限后台</b><small>查找用户、调整 Friend 权限并查看本月智能服务用量</small></div><ChevronRight /></button>
          </section>}
          <section className="settings-card glass-card credits-card" aria-labelledby="credits-title">
            <header><span className="settings-icon blue"><HeartHandshake /></span><div><h2 id="credits-title">致谢</h2><p>感谢参与这个长期个人记录工具的伙伴</p></div></header>
            <p lang="en">Built with the help of Codex, with special thanks to Claude for prompt design and development support.</p>
          </section>
        </div>
        <aside className="account-card glass-card">
          <button className="account-profile-button" onClick={() => setEditingProfile(true)}>
            <ProfileAvatar profile={profile} className="avatar" />
            <h3>{profile.display_name}</h3>
            <span className="edit-profile-link"><Pencil size={13} />编辑资料</span>
          </button>
          <p><Mail size={14} />{user.email}</p>
          <div className={`sync-state ${online ? "online" : "offline"}`}><Cloud size={17} /><span><b>{isDemo ? "本地演示模式" : online ? "网络可用" : "离线模式"}</b><small>{isDemo ? "不会读取或写入真实账号数据" : online ? "云端确认与待处理副本请查看顶部状态" : "恢复网络后自动同步"}</small></span></div>
          <button className="signout-button" onClick={onSignOut}><LogOut size={17} />{isDemo ? "退出演示" : "退出登录"}</button>
        </aside>
      </div>
      <footer className="app-footer settings-footer"><span>版本 {APP_VERSION}</span><span>© 2026 Sherlock Zang.</span></footer>
      {editingProfile && <ProfileEditor profile={profile} isDemo={isDemo} onClose={() => setEditingProfile(false)} onSave={onUpdateProfile} />}
      {showingUsageGuide && <UsageGuide onClose={() => setShowingUsageGuide(false)} />}
      {showingReleaseHistory && <ReleaseHistory changelogs={changelogs} onClose={() => setShowingReleaseHistory(false)} />}
      {showingPrivacy && <PrivacyDialog onClose={() => setShowingPrivacy(false)} />}
      {showingOwnerAdmin && <OwnerAdminDialog onClose={() => setShowingOwnerAdmin(false)} />}
    </section>
  );
}

function tierDescription(tier?: ApiQuotaSnapshot["tier"]) {
  if (tier === "owner") return "航班可使用本月总池的全部剩余额度；AI 不设账号额度";
  if (tier === "friend") return "无个人日限额，仍受共享池与频率保护";
  return "航班每天 2 次；轻量 AI 助手每天共用 15 次";
}

function QuotaOverview({ quota }: { quota: ApiQuotaSnapshot }) {
  if (quota.tier === "owner") {
    return <div className="quota-overview owner-quota-overview">
      <div><b>航班总额度</b><span>{quota.aviation.globalUsed} / {quota.aviation.globalLimit}<small>全部账号 / 月</small></span><p>当前还可使用 {quota.aviation.globalRemaining} 次；Owner 本月已使用 {quota.aviation.ownerUsed} 次。</p></div>
      <div><b>Owner 权限</b><span>不限额<small>AI 功能</small></span><p>其他用户航班共享池已使用 {quota.aviation.nonOwnerUsed} / {quota.aviation.nonOwnerLimit} 次；Owner 不受该 80 次上限影响。</p></div>
      {quota.cooldownUntil && <p className="quota-cooldown">查询暂停至 {new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(quota.cooldownUntil))}</p>}
    </div>;
  }
  const own = quota.buckets.filter((bucket) => bucket.bucket_key.includes(":standard:") || bucket.bucket_key.includes(":owner:") || bucket.bucket_key.includes(":recap:"));
  const shared = quota.buckets.filter((bucket) => bucket.bucket_key.includes(":shared:"));
  return <div className="quota-overview"><div><b>个人额度</b>{own.length ? own.map((bucket) => <span key={bucket.bucket_key}>{bucket.used_value} / {bucket.limit_value}<small>{bucket.bucket_key.includes("aviation") ? "航班" : bucket.bucket_key.includes("recap") ? "旅行回顾" : "轻量 AI"}</small></span>) : <p>当前账号没有个人日限额</p>}</div><div><b>共享额度池</b>{shared.map((bucket) => <span key={bucket.bucket_key}>{bucket.used_value} / {bucket.limit_value}<small>{bucket.bucket_key.includes("aviation") ? "航班 / 月" : "轻量 AI / 月"}</small></span>)}</div>{quota.cooldownUntil && <p className="quota-cooldown">查询暂停至 {new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(quota.cooldownUntil))}</p>}</div>;
}

function PrivacyDialog({ onClose }: { onClose: () => void }) {
  return <div className="modal-backdrop">
    <section className="modal-card privacy-modal glass-card" role="dialog" aria-modal="true" aria-labelledby="privacy-title">
      <header><div><p className="eyebrow">隐私与数据</p><h2 id="privacy-title">你的记录只属于你。</h2></div><button type="button" className="icon-button" aria-label="关闭隐私说明" onClick={onClose}><X /></button></header>
      <div className="privacy-copy">
        <p>你的记录、行程和设置均通过 Supabase 行级安全策略按账号隔离，其他用户无法读取。外部 API 密钥只保存在服务端；Owner 后台仅用于管理账号权限和额度，不会展示用户的个人记录内容。</p>
        <p>登录验证码和会话由 Supabase Auth 管理，Life Tracker 不保存你的邮箱密码。</p>
      </div>
      <footer><button type="button" className="primary-button" onClick={onClose}>知道了</button></footer>
    </section>
  </div>;
}

function OwnerAdminDialog({ onClose }: { onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [users, setUsers] = useState<OwnerManagedUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState("");
  const [error, setError] = useState("");

  async function load(nextQuery = query) {
    setLoading(true); setError("");
    try { setUsers(await getOwnerManagedUsers(nextQuery)); }
    catch (loadError) { setError(loadError instanceof Error ? loadError.message : "暂时无法读取账号列表"); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    let active = true;
    void getOwnerManagedUsers("").then((result) => { if (active) setUsers(result); }).catch((loadError) => {
      if (active) setError(loadError instanceof Error ? loadError.message : "暂时无法读取账号列表");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function changeTier(managedUser: OwnerManagedUser, tier: "standard" | "friend") {
    if (managedUser.tier === "owner" || managedUser.tier === tier) return;
    const nextLabel = tier === "friend" ? "Friend" : "Standard";
    if (!window.confirm(`确认将 ${managedUser.email} 调整为 ${nextLabel}？`)) return;
    setSavingId(managedUser.id); setError("");
    try {
      await setOwnerManagedUserTier(managedUser.id, tier);
      setUsers((current) => current.map((item) => item.id === managedUser.id ? { ...item, tier, source: "admin" } : item));
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "权限修改失败，请稍后重试");
    } finally { setSavingId(""); }
  }

  return <div className="modal-backdrop">
    <section className="modal-card owner-admin-modal glass-card" role="dialog" aria-modal="true" aria-labelledby="owner-admin-title">
      <header><div><p className="eyebrow">Owner 后台</p><h2 id="owner-admin-title">账号与权限</h2><p>只管理账号等级与智能服务用量，不提供个人记录内容入口。</p></div><button type="button" className="icon-button" aria-label="关闭账号后台" onClick={onClose}><X /></button></header>
      <form className="owner-user-search" onSubmit={(event) => { event.preventDefault(); void load(query); }}><label><Search size={16} /><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="按邮箱查找用户" /></label><button className="secondary-button" disabled={loading}>{loading ? "查询中…" : "查找"}</button></form>
      {error && <p className="field-error">{error}</p>}
      <div className="owner-user-list">
        {loading && <div className="owner-admin-state"><LoaderCircle className="spin" />正在读取账号…</div>}
        {!loading && !users.length && <div className="owner-admin-state">没有找到符合条件的账号。</div>}
        {!loading && users.map((managedUser) => <article className="owner-user-card" key={managedUser.id}>
          <div className="owner-user-heading"><div><strong>{managedUser.email}</strong><span>注册 {formatAdminDate(managedUser.createdAt)} · 最近登录 {managedUser.lastSignInAt ? formatAdminDate(managedUser.lastSignInAt) : "暂无"}</span></div><em className={`owner-tier-badge tier-${managedUser.tier}`}>{({ standard: "Standard", friend: "Friend", owner: "Owner" } as const)[managedUser.tier]}</em></div>
          <div className="owner-user-usage"><span><b>{managedUser.monthUsage.aviation}</b>本月航班</span><span><b>{managedUser.monthUsage.deepseek}</b>本月 AI</span><span><b>{managedUser.source === "invite" ? "邀请码" : managedUser.source === "admin" ? "后台" : "默认"}</b>权限来源</span></div>
          <div className="owner-tier-actions"><button type="button" className={managedUser.tier === "standard" ? "active" : ""} disabled={managedUser.tier === "owner" || savingId === managedUser.id} onClick={() => void changeTier(managedUser, "standard")}>Standard</button><button type="button" className={managedUser.tier === "friend" ? "active" : ""} disabled={managedUser.tier === "owner" || savingId === managedUser.id} onClick={() => void changeTier(managedUser, "friend")}>Friend</button>{managedUser.tier === "owner" && <small>Owner 身份已锁定</small>}{savingId === managedUser.id && <LoaderCircle className="spin" size={16} />}</div>
        </article>)}
      </div>
      <p className="owner-audit-note"><ShieldCheck size={15} />每次权限变更都会记录操作者、目标账号、修改前后等级和时间。</p>
      <footer><button type="button" className="primary-button" onClick={onClose}>完成</button></footer>
    </section>
  </div>;
}

function formatAdminDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function UsageGuide({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop">
      <section className="modal-card usage-guide-modal glass-card" role="dialog" aria-modal="true" aria-labelledby="usage-guide-title">
        <header><div><p className="eyebrow">使用说明</p><h2 id="usage-guide-title">记录与规划指南</h2><p>从快速记录到交通安排，都可以在这里随时回看。</p></div><button type="button" className="icon-button" aria-label="关闭使用说明" onClick={onClose}><X /></button></header>
        <div className="usage-guide-list">
          <article><span className="settings-icon blue"><BookOpen /></span><div><h3>日常记录</h3><p>从首页顶部或底部加号添加消费、行程和随记。日常内容建议优先使用文字，必要时再补充图片，让长期记录保持轻巧、清晰，也更方便检索和回顾。</p></div></article>
          <article><span className="settings-icon green"><Smartphone /></span><div><h3>交通计划与实际航班</h3><p>未来航班先手动填写计划信息，机场支持中文、英文、城市、拼音和 IATA 离线补全。计划到达约一小时后，卡片会出现“匹配实际飞行信息”；核对计划与实际差异并确认后才会保存，打开页面不会自动查询。</p></div></article>
          <article><span className="settings-icon violet"><Bot /></span><div><h3>AI 助手</h3><p>路线查询、记账识别和随记润色共用轻量额度；旅行回顾与今日摘要独立计数。AI 结果始终先预览、后确认，不会直接替你保存。旅行回顾只使用服务端聚合统计和少量抽样随记。</p></div></article>
        </div>
        <footer><button type="button" className="primary-button" onClick={onClose}>完成</button></footer>
      </section>
    </div>
  );
}

function ReleaseHistory({ changelogs, onClose }: { changelogs: Changelog[]; onClose: () => void }) {
  const releases = [...changelogs].sort((left, right) => compareVersions(right.version, left.version));

  return (
    <div className="modal-backdrop">
      <section className="modal-card release-history-modal glass-card" role="dialog" aria-modal="true" aria-labelledby="release-history-title">
        <header><div><p className="eyebrow">版本历史</p><h2 id="release-history-title">更新记录</h2><p>从第一个版本开始，所有重要变化都留在这里。</p></div><button type="button" className="icon-button" aria-label="关闭更新记录" onClick={onClose}><X /></button></header>
        <div className="release-history-list">
          {releases.map((release) => (
            <article className="release-entry" key={release.version}>
              <div className="release-entry-heading"><div><strong>Life Tracker {release.version}</strong><time>{formatReleaseDate(release.created_at)}</time></div>{release.version === APP_VERSION && <span>当前版本</span>}</div>
              <ul>{release.summary.map((item) => <li key={item}><Check size={15} /><span>{item}</span></li>)}</ul>
            </article>
          ))}
          {!releases.length && <p className="release-history-empty">暂时无法读取更新记录，请联网后重试。</p>}
        </div>
        <footer><button type="button" className="primary-button" onClick={onClose}>完成</button></footer>
      </section>
    </div>
  );
}

function compareVersions(left: string, right: string) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

function formatReleaseDate(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(new Date(value));
}

function ProfileEditor({ profile, isDemo, onClose, onSave }: { profile: UserProfile; isDemo: boolean; onClose: () => void; onSave: Props["onUpdateProfile"] }) {
  const [displayName, setDisplayName] = useState(profile.display_name);
  const [avatarColor, setAvatarColor] = useState(profile.avatar_color);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(profile.avatar_url);
  const [avatarBlob, setAvatarBlob] = useState<Blob>();
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  async function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) { setError("请选择 JPG、PNG 或 WebP 图片"); return; }
    if (file.size > 2 * 1024 * 1024) { setError("头像图片不能超过 2MB"); return; }
    try {
      const cropped = await cropSquare(file);
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      setAvatarBlob(cropped);
      setPreviewUrl(URL.createObjectURL(cropped));
      setError("");
    } catch {
      setError("无法处理这张图片，请换一张重试");
    }
  }

  function chooseColor(color: string) {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setAvatarBlob(undefined);
    setAvatarUrl(null);
    setAvatarColor(color);
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!displayName.trim()) return;
    setSaving(true);
    setError("");
    try {
      await onSave({ ...profile, display_name: displayName.trim(), avatar_color: avatarColor, avatar_url: avatarUrl, updated_at: new Date().toISOString() }, avatarBlob);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="modal-card profile-editor glass-card" onSubmit={submit}>
        <header><div><p className="eyebrow">个人资料</p><h2>你希望怎样出现？</h2></div><button type="button" className="icon-button" aria-label="关闭" onClick={onClose}><X /></button></header>
        <div className="profile-preview"><ProfileAvatar profile={{ display_name: displayName, avatar_color: avatarColor, avatar_url: avatarUrl }} imageUrl={previewUrl ?? avatarUrl} className="avatar profile-preview-avatar" />{!isDemo && <><button type="button" className="secondary-button" onClick={() => fileInput.current?.click()}><ImagePlus size={16} />上传图片</button><input ref={fileInput} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" onChange={chooseFile} /></>}</div>
        <label>显示昵称<input value={displayName} maxLength={40} onChange={(event) => setDisplayName(event.target.value)} placeholder="输入你的昵称" required /></label>
        <fieldset className="avatar-color-field"><legend>首字母头像颜色</legend><div>{AVATAR_COLORS.map((color) => <button type="button" key={color} className={!avatarUrl && !previewUrl && avatarColor === color ? "active" : ""} style={{ backgroundColor: color }} aria-label={`选择头像颜色 ${color}`} onClick={() => chooseColor(color)}>{!avatarUrl && !previewUrl && avatarColor === color && <Check size={15} />}</button>)}</div></fieldset>
        <p className="profile-hint">{isDemo ? "演示模式不支持图片上传，资料只保存在当前设备。" : "图片会自动居中裁剪为正方形，最大 2MB。"}</p>
        {error && <p className="field-error">{error}</p>}
        <footer><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving || !displayName.trim()}>{saving ? "保存中…" : "保存资料"}</button></footer>
      </form>
    </div>
  );
}

async function cropSquare(file: File) {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas unavailable");
  context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, 512, 512);
  bitmap.close();
  return new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Avatar conversion failed")), "image/webp", .9));
}

````

## src/components/SyncStatusDialog.tsx

<!-- source: src/components/SyncStatusDialog.tsx sha256: 7e3fb9d51b48f90376e6562de8485b2216ff1c21c1eae110c2c87482540bd3cf encoding: utf8 -->
````tsx
import { useState } from "react";
import type { PendingMutation } from "../lib/offline";
import type { PendingAiRecovery } from "../lib/ai";
import { inspectSyncConflict, resolveSyncConflict } from "../lib/data";

interface Props {
  items: PendingMutation[]; aiCopies: PendingAiRecovery[];
  online: boolean; cloudReady: boolean; isDemo: boolean;
  onClose: () => void; onRetrySave: () => Promise<void>; onRetryAi: () => Promise<void>;
  onResolved: () => Promise<void>;
}
export function SyncStatusDialog({ items, aiCopies, online, cloudReady, isDemo, onClose, onRetrySave, onRetryAi, onResolved }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [review, setReview] = useState<Awaited<ReturnType<typeof inspectSyncConflict>> | null>(null);
  const activeItems = items.filter(item => !item.supersededBy);
  async function retry(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : "仍未完成保存，请保留本地副本"); }
    finally { setBusy(false); }
  }
  function exportCopies() {
    const blob = new Blob([JSON.stringify({ records: items, aiResults: aiCopies }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = "life-tracker-local-copies.json"; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="modal-backdrop"><section className="modal-card glass-card" role="dialog" aria-modal="true" aria-labelledby="sync-status-title">
    <header><h2 id="sync-status-title">同步与本地副本</h2><button className="secondary-button" onClick={onClose}>关闭</button></header>
    <p>只有收到云端确认才显示“已同步”。冲突可点击“比较并处理”，核对两份内容后选择保留云端或保存本机内容；原始副本仍可导出。</p>
    <p>导出文件包含个人内容及临时保存凭据，请妥善保管，不要公开分享。</p>
    {items.map(item => <p key={item.id}><b>{String(item.payload.content || item.payload.name || item.table)}</b> · {item.supersededBy ? "已处理，保留历史副本（不会再次同步）" : item.error || "等待同步"}{!item.supersededBy && item.state === "conflict" && <button className="secondary-button" disabled={busy || !online || isDemo} onClick={() => void retry(async () => setReview(await inspectSyncConflict(item)))}>比较并处理</button>}</p>)}
    {review && <section><h3>核对冲突内容</h3><b>云端内容</b><pre className="local-copy-content">{JSON.stringify(review.cloud, null, 2) || "云端记录不存在"}</pre><b>本机最新内容</b><pre className="local-copy-content">{JSON.stringify(review.inspected.at(-1)?.payload, null, 2)}</pre><p>保存本机内容会替换以上云端版本。若云端随后又发生变化，将再次提示冲突，不会强制覆盖。</p>{(["cloud", "local"] as const).map(choice => <button key={choice} className="secondary-button" disabled={busy || !online} onClick={() => void retry(async () => { await resolveSyncConflict(review, choice); setReview(null); await onResolved(); })}>{choice === "cloud" ? "保留云端，归档本机副本" : "使用本机内容保存"}</button>)}</section>}
    {aiCopies.map(item => <section key={item.id}><p><b>AI 结果待保存</b> · {item.error || item.warning || "内容已生成，但尚未确认云端保存"}</p><pre className="local-copy-content">{typeof item.result === "string" ? item.result : JSON.stringify(item.result, null, 2)}</pre></section>)}
    {!activeItems.length && !aiCopies.length && <p>{isDemo ? "演示数据仅保存在此设备。" : cloudReady && online ? "当前记录已获云端确认。" : "暂无待同步记录；网络连接不代表云端已确认。"}</p>}
    {error && <p className="field-error">{error}</p>}
    <footer>
      <button className="secondary-button" disabled={!items.length && !aiCopies.length} onClick={exportCopies}>导出本地副本</button>
      <button className="primary-button" disabled={!online || isDemo || busy} onClick={() => void retry(onRetrySave)}>重试可恢复的保存</button>
      {!!aiCopies.length && <button className="secondary-button" disabled={!online || busy} onClick={() => void retry(onRetryAi)}>仅重试 AI 保存（不重新生成）</button>}
    </footer>
  </section></div>;
}

````

## src/components/Timeline.tsx

<!-- source: src/components/Timeline.tsx sha256: 5acf38bf423e3cb8c9de4a1271304be990859d157ee10a8eaa42c5d72fa9a672 encoding: utf8 -->
````tsx
import { useState } from "react";
import { CalendarClock, Check, CircleDollarSign, Clock3, MapPin, NotebookPen, Pencil, ReceiptText, RotateCcw, Route, Sparkles, X } from "lucide-react";
import type { Currency, LifeRecord, RecordDraft, RecordType, Trip } from "../types";
import { CATEGORY_META, formatDateTime, formatMoney } from "../types";
import { getTransportPresentation } from "../lib/transport";
import { calculateFlightDuration } from "../lib/flightDuration";
import { EmptyState } from "./ui";
import { TransportPlanEditor } from "./TransportPlanEditor";
import { flightDisplay } from "../lib/flightDisplay";
import { normalizeScheduleDetails } from "../lib/schedules";
import { groupTimeline, timelineDate } from "../lib/calendar";

interface Props {
  records: LifeRecord[];
  trips: Trip[];
  filter: "all" | RecordType;
  baseCurrency: Currency;
  onStatus: (record: LifeRecord, status: "planned" | "completed" | "cancelled") => void;
  onSaveRecord: (draft: RecordDraft) => Promise<void>;
  onUpdateRecord: (record: LifeRecord, serverConfirmed?: boolean) => Promise<void>;
  isDemo?: boolean;
}

const icons = { expense: ReceiptText, trip: Route, note: NotebookPen };
const labels = { expense: "消费", trip: "行程", note: "随记" };

export function Timeline({ records, trips, filter, onStatus, onSaveRecord, onUpdateRecord, isDemo = false }: Props) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const editingRecord = records.find((record) => record.id === editingId);
  const editingTrip = trips.find((trip) => trip.id === editingRecord?.trip_id);
  const visible = records.filter((record) => !record.parent_plan_id && (filter === "all" || record.record_type === filter)).sort((a, b) => b.event_at.localeCompare(a.event_at));
  const grouped = groupTimeline(visible);

  if (!visible.length) {
    return <EmptyState className="empty-timeline" icon={Sparkles} title="这里还很安静" description="从上方快速记下第一条，生活的时间线就会从这里开始。" />;
  }

  return (
    <section className="timeline">
      {grouped.map(([date, items]) => (
        <div className="timeline-day" key={date}>
          <div className="day-label"><span>{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric" }).format(new Date(`${date}T12:00:00`))}</span><small>{new Intl.DateTimeFormat("zh-CN", { weekday: "long" }).format(new Date(`${date}T12:00:00`))}</small></div>
          <div className="day-records">
            {items.map((record) => <RecordCard key={record.id} record={record} trip={trips.find((trip) => trip.id === record.trip_id)} onStatus={onStatus} onEdit={() => setEditingId(record.id)} />)}
          </div>
        </div>
      ))}
      {editingRecord && editingTrip && <TransportPlanEditor key={editingRecord.id} modal day={timelineDate(editingRecord, editingTrip.timezone)} trip={editingTrip} count={0} record={editingRecord} isDemo={isDemo} onSave={onSaveRecord} onUpdate={onUpdateRecord} onClose={() => setEditingId(null)} />}
    </section>
  );
}

function RecordCard({ record, trip, onStatus, onEdit }: { record: LifeRecord; trip?: Trip; onStatus: Props["onStatus"]; onEdit: () => void }) {
  const Icon = icons[record.record_type];
  const presentation = getTransportPresentation(record);
  const flightView = flightDisplay(record);
  const flight = flightView?.details;
  const schedule = normalizeScheduleDetails(record.schedule_details);
  const duration = flight ? calculateFlightDuration(flight.departure, flight.arrival) : null;
  const displayTime = record.transport_type === "flight" && record.transport_details
    ? flight!.departure.time
    : schedule ? "全天" : formatDateTime(record.event_at).split(" ").slice(-1);
  return (
    <article className={`record-card glass-card record-${record.record_type}`}>
      <span className="record-icon"><Icon size={20} /></span>
      <div className="record-main">
        <div className="record-meta"><span>{record.transport_type || schedule ? presentation.label : labels[record.record_type]}</span><i>·</i><time>{displayTime}</time>{trip && <em>{trip.name}</em>}</div>
        <h3>{presentation.title}</h3>
        {presentation.subtitle && <p>{presentation.subtitle}</p>}
        <div className="record-details">
          {duration?.status === "ready" && <span><Clock3 size={14} />{flightView!.durationLabel} {duration.label}</span>}
          {flightView?.matched && <span className="status completed"><Check size={14} />优先展示匹配信息</span>}
          {record.location && !record.transport_type && <span><MapPin size={14} />{record.location}</span>}
          {record.record_type === "expense" && record.expense_category && <span><CircleDollarSign size={14} />{CATEGORY_META[record.expense_category].label}</span>}
          {record.record_type === "trip" && record.plan_status && <span className={`status ${record.plan_status}`}><Clock3 size={14} />{{ planned: "计划中", completed: "已完成", cancelled: "已取消" }[record.plan_status]}</span>}
        </div>
      </div>
      {record.record_type === "expense" && record.amount != null && record.currency && <strong className="record-amount">{formatMoney(record.amount, record.currency)}</strong>}
      {record.record_type === "trip" && <div className="record-controls">
        {record.plan_status === "completed" && <span className="done-stamp"><Check size={15} />已打卡</span>}
        <div className="record-control-buttons">
          {trip && <button className="record-control-button" onClick={onEdit}><Pencil size={15} />{record.transport_type === "flight" ? "编辑航班" : "编辑计划"}</button>}
          {record.plan_status === "planned" && <><button className="record-control-button" onClick={() => onStatus(record, "completed")}><Check size={15} />标记完成</button><button className="record-control-button" onClick={() => onStatus(record, "cancelled")}><X size={15} />取消计划</button></>}
          {(record.plan_status === "completed" || record.plan_status === "cancelled") && <button className="record-control-button" onClick={() => onStatus(record, "planned")}><RotateCcw size={15} />{record.plan_status === "completed" ? "撤回完成" : "恢复计划"}</button>}
        </div>
      </div>}
      {record.record_type === "trip" && <span className="timeline-pin"><CalendarClock size={13} /></span>}
    </article>
  );
}

````

## src/components/TransportPlanEditor.tsx

<!-- source: src/components/TransportPlanEditor.tsx sha256: 4a295867e678cdff03f55c0c5b4f3056de4027f9e7899a61ce2cb36763b1a97f encoding: utf8 -->
````tsx
import { useId, useState, type FormEvent } from "react";
import { BedDouble, CalendarDays, CalendarClock, Check, LoaderCircle, MapPin, Plane, Route, Sparkles, TrainFront, X } from "lucide-react";
import type { ActualFlightInfo, FlightDetails, FlightStop, LifeRecord, MetroDetails, RailDetails, RailSystemType, RecordDraft, TransportDetails, TransportType, Trip } from "../types";
import { RAIL_SYSTEM_LABELS, getTransportPresentation, transportTitle } from "../lib/transport";
import { queryTransitRoute, TRANSIT_AI_ERROR } from "../lib/transitAi";
import { zonedDateTimeToIso } from "../lib/tripDates";
import { confirmFlightActual, demoFlightPreview, flightMatchEligibility, matchFlightActual, type FlightMatchPreview } from "../lib/flightLookup";
import { airportLabel, searchAirports, type AirportOption } from "../lib/airports";
import { TIMEZONE_OPTIONS, timeZoneLabel } from "../lib/timezones";
import { normalizeAircraftType, searchAircraftTypes } from "../lib/aircraftTypes";
import { AIRLINES, completeFlightNumber, flightNumberInput, isCompleteFlightNumber, isFlightNumberSuffix, normalizeFlightNumber, resolveAirline, searchAirlines, type AirlineOption } from "../lib/airlines";
import { FlightDurationSummary } from "./FlightDurationSummary";
import { normalizeScheduleDetails, scheduleValidation, shiftScheduleDate, scheduleNights, validScheduleDate } from "../lib/schedules";
import { FlightDetailsView } from "./FlightDetailsView";
import { flightMatchIsCurrent, flightPlanKey, invalidateChangedFlight } from "../lib/flightMatchState";
import { calculateFlightDuration, flightTimeOptions, resolveFlightInstant, utcOffsetLabel } from "../lib/flightDuration";

export type PlanKind = "general" | TransportType | "all_day" | "hotel";

interface EditorProps {
  day: string;
  trip: Trip;
  count: number;
  record?: LifeRecord;
  modal?: boolean;
  isDemo?: boolean;
  initialKind?: PlanKind;
  onSave: (draft: RecordDraft) => Promise<void>;
  onUpdate?: (record: LifeRecord, serverConfirmed?: boolean) => Promise<void>;
  onClose: () => void;
}

function timeInZone(iso: string | undefined, timeZone: string) {
  if (!iso) return "09:00";
  return new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(iso));
}

function emptyFlight(day: string, timeZone: string): FlightDetails {
  return { airline: "", flight_number: "", departure: { date: day, time: "09:00", airport: "", iata: "", terminal: "", timezone: timeZone }, arrival: { date: day, time: "11:00", airport: "", iata: "", terminal: "", timezone: timeZone } };
}

function emptyRail(day: string): RailDetails {
  return { system_type: "china_hsr", train_number: "", departure: { date: day, time: "09:00", station: "" }, arrival: { date: day, time: "11:00", station: "" } };
}

function emptyMetro(): MetroDetails {
  return { origin: "", destination: "", estimated_departure_time: "09:00", estimated_arrival_time: "" };
}

export function TransportPlanEditor({ day, trip, count, record, modal, isDemo = false, initialKind = "general", onSave, onUpdate, onClose }: EditorProps) {
  const storedSchedule = normalizeScheduleDetails(record?.schedule_details);
  const [kind, setKind] = useState<PlanKind>(storedSchedule?.kind || record?.transport_type || initialKind);
  const [schedule, setSchedule] = useState(storedSchedule || { kind: initialKind === "hotel" ? "hotel" as const : "all_day" as const, start_date: day, end_date: initialKind === "hotel" ? shiftScheduleDate(day, 1) : day, check_in_time: "", check_out_time: "", booking_reference: "" });
  const [content, setContent] = useState(record?.transport_type ? "" : record?.content || "");
  const [location, setLocation] = useState(record?.transport_type ? "" : record?.location || "");
  const [notes, setNotes] = useState(record?.transport_type ? "" : record?.notes || "");
  const [time, setTime] = useState(timeInZone(record?.event_at, trip.timezone));
  const storedFlight = record?.transport_type === "flight" ? record.transport_details as FlightDetails : null;
  const [flight, setFlight] = useState<FlightDetails>(storedFlight ? {
    ...storedFlight,
    departure: { ...storedFlight.departure, timezone: storedFlight.departure.timezone || trip.timezone },
    arrival: { ...storedFlight.arrival, timezone: storedFlight.arrival.timezone || trip.timezone }
  } : emptyFlight(day, trip.timezone));
  const [rail, setRail] = useState<RailDetails>(record?.transport_type === "rail" ? record.transport_details as RailDetails : emptyRail(day));
  const [metro, setMetro] = useState<MetroDetails>(record?.transport_type === "metro" ? record.transport_details as MetroDetails : emptyMetro());
  const [showAi, setShowAi] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [localChoice, setLocalChoice] = useState<{ key: string; offset?: number }>({ key: "" });
  const localDate = kind === "rail" ? rail.departure.date : day;
  const localTime = kind === "rail" ? rail.departure.time : kind === "metro" ? metro.estimated_departure_time || time : time;
  const localKey = `${localDate}|${localTime}|${trip.timezone}`;
  let localOptions: ReturnType<typeof flightTimeOptions> = [];
  try { if (["general", "rail", "metro"].includes(kind)) localOptions = flightTimeOptions({ date: localDate, time: localTime, timezone: trip.timezone }); } catch { /* Submit reports invalid/nonexistent clocks without changing the draft. */ }
  const originalOption = localOptions.find(option => option.instant === Math.floor(Date.parse(record?.event_at || "") / 60_000) * 60_000);
  const localOffset = localChoice.key === localKey ? localChoice.offset : originalOption?.utcOffsetMinutes;
  const selectedAirline = resolveAirline(flight.airline);
  const fullFlightNumber = completeFlightNumber(flight.flight_number, flight.airline);
  const showAirlinePrefix = selectedAirline && (!flight.flight_number || isFlightNumberSuffix(flight.flight_number) || (isCompleteFlightNumber(fullFlightNumber) && fullFlightNumber.startsWith(selectedAirline.iata)));

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError("");
    try {
      let draft: RecordDraft;
      if (kind === "general") {
        draft = { record_type: "trip", content, location, notes, event_at: zonedDateTimeToIso(day, time, trip.timezone, localOffset, record?.event_at), trip_id: trip.id, plan_status: record?.plan_status || "planned", sort_order: record?.sort_order ?? (count + 1) * 1000 };
      } else if (kind === "all_day" || kind === "hotel") {
        const details = { ...schedule, kind };
        const validation = scheduleValidation(details);
        if (validation) throw new Error(validation);
        if (!content.trim()) throw new Error(kind === "hotel" ? "请填写酒店名称" : "请填写事项名称");
        draft = { record_type: "trip", content, location, notes, event_at: storedSchedule?.start_date === details.start_date && record ? record.event_at : zonedDateTimeToIso(details.start_date, "12:00", trip.timezone), trip_id: trip.id, plan_status: record?.plan_status || "planned", sort_order: record?.sort_order ?? (count + 1) * 1000, schedule_details: normalizeScheduleDetails(details)! };
      } else {
        const details: TransportDetails = kind === "flight" ? { ...flight, airline: selectedAirline?.name || flight.airline.trim(), flight_number: fullFlightNumber } : kind === "rail" ? rail : metro;
        if (kind === "flight" && !isCompleteFlightNumber(fullFlightNumber)) throw new Error("请选择已收录的航空公司，或填写带航司代码的完整航班号（例如 NH105）");
        const departureDate = kind === "flight" ? flight.departure.date : kind === "rail" ? rail.departure.date : day;
        const departureTime = kind === "flight" ? flight.departure.time : kind === "rail" ? rail.departure.time : metro.estimated_departure_time || time;
        const eventTimeZone = kind === "flight" ? flight.departure.timezone || trip.timezone : trip.timezone;
        if (kind === "flight" && (!flight.departure.airport.trim() || !flight.arrival.airport.trim())) throw new Error("请填写起飞机场和到达机场名称");
        if (kind === "flight") { const duration = calculateFlightDuration(flight.departure, flight.arrival); if (duration.status !== "ready") throw new Error(duration.message); }
        draft = {
          record_type: "trip", content: transportTitle(kind, details),
          location: kind === "flight" ? `${flight.departure.airport} → ${flight.arrival.airport}` : kind === "rail" ? `${rail.departure.station} → ${rail.arrival.station}` : `${metro.origin} → ${metro.destination}`,
          notes: details.notes, event_at: kind === "flight" ? new Date(resolveFlightInstant(flight.departure)).toISOString() : zonedDateTimeToIso(departureDate, departureTime, eventTimeZone, localOffset, record?.event_at), trip_id: trip.id,
          plan_status: record?.plan_status || "planned", sort_order: record?.sort_order ?? (count + 1) * 1000, transport_type: kind, transport_details: details
        };
      }
      if (record && onUpdate) {
        await onUpdate(invalidateChangedFlight(record, { ...record, content: draft.content.trim(), location: draft.location?.trim() || null, notes: draft.notes?.trim() || null, event_at: draft.event_at || record.event_at, plan_status: draft.plan_status || record.plan_status, sort_order: draft.sort_order ?? record.sort_order, transport_type: draft.transport_type || null, transport_details: draft.transport_details || null, ...(draft.schedule_details ? { schedule_details: draft.schedule_details } : record.schedule_details ? { schedule_details: null } : {}), updated_at: new Date().toISOString() }));
      } else await onSave(draft);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "保存失败，请稍后重试");
    } finally {
      setSaving(false);
    }
  }

  const form = <form className={`transport-plan-form ${modal ? "modal-card glass-card transport-editor-modal" : ""}`} onSubmit={submit}>
    {modal && <header><div><p className="eyebrow">编辑计划</p><h2>更新行程信息</h2></div><button type="button" className="icon-button" aria-label="关闭编辑" onClick={onClose}><X /></button></header>}
    <div className="plan-type-switch" role="tablist" aria-label="计划类型">{([{"value":"general","label":"通用事项","icon":MapPin},{"value":"flight","label":"飞机","icon":Plane},{"value":"rail","label":"高铁 / 铁路","icon":TrainFront},{"value":"metro","label":"市内交通","icon":Route},{"value":"all_day","label":"全天事项","icon":CalendarDays},{"value":"hotel","label":"酒店住宿","icon":BedDouble}] as const).map((item) => { const Icon = item.icon; return <button type="button" role="tab" aria-selected={kind === item.value} className={kind === item.value ? "active" : ""} onClick={() => { setKind(item.value); if (item.value === "hotel" && (!validScheduleDate(schedule.start_date) || schedule.end_date <= schedule.start_date)) { const start = validScheduleDate(schedule.start_date) ? schedule.start_date : day; setSchedule({ ...schedule, start_date: start, end_date: shiftScheduleDate(start, 1) }); } }} key={item.value}><Icon size={15} />{item.label}</button>; })}</div>

    {kind === "general" && <div className="transport-fields"><label className="field-span-2">事项名称<input autoFocus value={content} onChange={(event) => setContent(event.target.value)} placeholder="地点或事项名称" required /></label><label>时间<input type="time" value={time} onChange={(event) => setTime(event.target.value)} required /></label><label>地点 <span className="optional-tag">选填</span><input value={location} onChange={(event) => setLocation(event.target.value)} placeholder="例如 酒店大堂" /></label><label className="field-span-2">备注 <span className="optional-tag">选填</span><textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></label></div>}

    {(kind === "all_day" || kind === "hotel") && <div className="transport-fields">
      <p className="field-help field-span-2">日期按行程时区 {timeZoneLabel(trip.timezone)} 记录。跨日安排只保存一条，修改会同步到所有展示日期。</p>
      <label className="field-span-2">{kind === "hotel" ? "酒店名称" : "事项名称"}<input autoFocus value={content} onChange={(event) => setContent(event.target.value)} placeholder={kind === "hotel" ? "例如 东京浅草酒店" : "例如 全天游园"} required /></label>
      <label>{kind === "hotel" ? "入住日期" : "开始日期"}<input type="date" value={schedule.start_date} onChange={(event) => setSchedule({ ...schedule, start_date: event.target.value })} required /></label>
      <label>{kind === "hotel" ? "退房日期" : "结束日期（含当天）"}<input type="date" min={kind === "hotel" && schedule.start_date ? shiftScheduleDate(schedule.start_date, 1) : schedule.start_date} value={schedule.end_date} onChange={(event) => setSchedule({ ...schedule, end_date: event.target.value })} required /></label>
      {kind === "hotel" && <><label>入住时间 <span className="optional-tag">选填</span><input type="time" value={schedule.check_in_time || ""} onChange={(event) => setSchedule({ ...schedule, check_in_time: event.target.value })} /></label><label>退房时间 <span className="optional-tag">选填</span><input type="time" value={schedule.check_out_time || ""} onChange={(event) => setSchedule({ ...schedule, check_out_time: event.target.value })} /></label><p className="field-help field-span-2">{validScheduleDate(schedule.start_date) && validScheduleDate(schedule.end_date) && schedule.end_date > schedule.start_date ? `共 ${scheduleNights(schedule)} 晚；退房日会显示退房提醒，不计入连住夜晚。` : "请填写有效日期，并将退房日期设在入住日期之后。"}</p><label className="field-span-2">预订号 <span className="optional-tag">选填</span><input value={schedule.booking_reference || ""} onChange={(event) => setSchedule({ ...schedule, booking_reference: event.target.value })} /></label></>}
      <label className="field-span-2">{kind === "hotel" ? "酒店地址" : "地点"} <span className="optional-tag">选填</span><input value={location} onChange={(event) => setLocation(event.target.value)} /></label>
      <label className="field-span-2">备注 <span className="optional-tag">选填</span><textarea rows={3} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
    </div>}

    {kind === "flight" && <div className="transport-fields">
      <div className="flight-planning-note field-span-2"><Plane size={16} /><p><b>先填写计划信息</b><span>未来航班不调用接口。保存后前往“行程规划”，展开航班详情即可查看“匹配实际飞行信息”；按钮仅在计划到达 1 小时后至 48 小时内显示，其他时间可手动补充。</span></p></div>
      <AirlineField value={flight.airline} onChange={(airline) => setFlight({ ...flight, airline })} />
      <div><label>航班号<div className="flight-number-input">{showAirlinePrefix && <span aria-hidden="true">{selectedAirline.iata}</span>}<input aria-label="航班号" value={flightNumberInput(flight.flight_number, flight.airline)} onChange={(event) => setFlight({ ...flight, flight_number: normalizeFlightNumber(event.target.value) })} placeholder={selectedAirline ? "例如 105" : "例如 NH105"} required /></div></label><p className="field-help">{selectedAirline ? isCompleteFlightNumber(fullFlightNumber) ? `完整航班号：${fullFlightNumber}${fullFlightNumber.startsWith(selectedAirline.iata) ? "" : "；与所选航司代码不同，请核对是否为代码共享航班"}` : `已匹配 ${selectedAirline.iata}，只需填写数字部分；也可粘贴完整航班号。` : "选择航司后自动补全代码；未收录的航司请填写完整航班号。"}</p></div>
      <FlightStopEditor legend="起飞信息 · 当地时间" stop={flight.departure} onChange={(departure) => setFlight({ ...flight, departure })} />
      <FlightStopEditor legend="降落信息 · 当地时间" stop={flight.arrival} onChange={(arrival) => setFlight({ ...flight, arrival })} />
      {(!flight.departure.iata || !flight.arrival.iata) && <p className="field-help field-span-2">未收录机场可按名称和当地时区手动保存。自动匹配另需从候选列表选择正确机场，不能选择其他机场代替。</p>}
      <FlightDurationSummary details={flight} />
      <label>登机口 <span className="optional-tag">选填</span><input value={flight.gate || ""} onChange={(event) => setFlight({ ...flight, gate: event.target.value })} /></label>
      <label>座位号 <span className="optional-tag">选填</span><input value={flight.seat || ""} onChange={(event) => setFlight({ ...flight, seat: event.target.value })} /></label>
      <label>注册号 <span className="optional-tag">选填</span><input value={flight.registration || ""} onChange={(event) => setFlight({ ...flight, registration: event.target.value.toUpperCase() })} /></label>
      <AircraftTypeField value={flight.aircraft_type || ""} onChange={(aircraftType) => setFlight({ ...flight, aircraft_type: aircraftType })} />
      <label className="field-span-2">备注 <span className="optional-tag">选填</span><textarea rows={3} value={flight.notes || ""} onChange={(event) => setFlight({ ...flight, notes: event.target.value })} /></label>
    </div>}

    {kind === "rail" && <div className="transport-fields"><label>铁路系统<select value={rail.system_type} onChange={(event) => setRail({ ...rail, system_type: event.target.value as RailSystemType })}>{Object.entries(RAIL_SYSTEM_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>车次号<input value={rail.train_number} onChange={(event) => setRail({ ...rail, train_number: event.target.value })} required /></label>{rail.system_type === "other" && <label className="field-span-2">铁路系统名称<input value={rail.custom_system || ""} onChange={(event) => setRail({ ...rail, custom_system: event.target.value })} required /></label>}<RailStop legend="出发信息" value={rail.departure} onChange={(departure) => setRail({ ...rail, departure })} stationLabel="出发站" /><RailStop legend="到达信息" value={rail.arrival} onChange={(arrival) => setRail({ ...rail, arrival })} stationLabel="到达站" /><label className="field-span-2">座位 / 车厢 <span className="optional-tag">选填</span><input value={rail.seat_carriage || ""} onChange={(event) => setRail({ ...rail, seat_carriage: event.target.value })} /></label><label className="field-span-2">备注 <span className="optional-tag">选填</span><textarea rows={3} value={rail.notes || ""} onChange={(event) => setRail({ ...rail, notes: event.target.value })} /></label></div>}

    {kind === "metro" && <div className="transport-fields"><label>出发点<input value={metro.origin} onChange={(event) => setMetro({ ...metro, origin: event.target.value })} required /></label><label>到达点<input value={metro.destination} onChange={(event) => setMetro({ ...metro, destination: event.target.value })} required /></label><label>预计出发时间 <span className="optional-tag">选填</span><input type="time" value={metro.estimated_departure_time || ""} onChange={(event) => setMetro({ ...metro, estimated_departure_time: event.target.value })} /></label><label>预计到达时间 <span className="optional-tag">选填</span><input type="time" value={metro.estimated_arrival_time || ""} onChange={(event) => setMetro({ ...metro, estimated_arrival_time: event.target.value })} /></label><label className="field-span-2 route-description-field"><span>换乘线路 / 路线说明 <span className="optional-tag">选填</span><button type="button" className="ai-route-button" disabled={!metro.origin.trim() || !metro.destination.trim()} onClick={() => setShowAi(true)}><Sparkles size={14} />AI 帮我查</button></span><textarea rows={5} value={metro.route_description || ""} onChange={(event) => setMetro({ ...metro, route_description: event.target.value })} /></label><label className="field-span-2">备注 <span className="optional-tag">选填</span><textarea rows={3} value={metro.notes || ""} onChange={(event) => setMetro({ ...metro, notes: event.target.value })} /></label></div>}
    {localOptions.length > 1 && <label>重复当地时间 · 必选<select value={localOffset ?? ""} required onChange={event => setLocalChoice({ key: localKey, offset: event.target.value === "" ? undefined : Number(event.target.value) })}><option value="" disabled>请选择第一次或第二次</option>{localOptions.map((option, index) => <option key={option.utcOffsetMinutes} value={option.utcOffsetMinutes}>{index === 0 ? "第一次" : "第二次"} · {utcOffsetLabel(option.utcOffsetMinutes)}</option>)}</select><small className="field-help">夏令时结束时同一当地时间出现两次。已有计划保留原选择；修改日期或时间后请重新核对。</small></label>}
    {error && <p className="field-error" role="alert">{error}</p>}
    <footer className="transport-form-actions"><button type="button" className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving}>{saving ? "保存中…" : record ? "保存修改" : "添加计划"}</button></footer>
    {showAi && <TransitAiDialog metro={metro} isDemo={isDemo} onClose={() => setShowAi(false)} onFill={(route) => { setMetro({ ...metro, route_description: route }); setShowAi(false); }} />}
  </form>;
  return modal ? <div className="modal-backdrop">{form}</div> : form;
}

function AirlineField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const listId = useId();
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(-1);
  const options = searchAirlines(value);
  function select(airline: AirlineOption) { onChange(airline.name); setFocused(false); setActive(-1); }
  return <label className="airline-autocomplete">航空公司<input aria-label="航空公司" role="combobox" aria-autocomplete="list" aria-expanded={focused && options.length > 0} aria-controls={listId} aria-activedescendant={focused && options[active] ? `${listId}-${active}` : undefined} value={value} onChange={(event) => { onChange(event.target.value); setFocused(true); setActive(-1); }} onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); setActive(-1); }} onKeyDown={(event) => {
    if ((event.key === "ArrowDown" || event.key === "ArrowUp") && options.length > 0) { event.preventDefault(); setFocused(true); setActive((current) => event.key === "ArrowDown" ? Math.min(current + 1, options.length - 1) : Math.max(current - 1, 0)); }
    else if (event.key === "Enter" && focused && active >= 0 && options[active]) { event.preventDefault(); select(options[active]); }
    else if (event.key === "Escape") { event.preventDefault(); setFocused(false); setActive(-1); }
  }} placeholder="搜索中文、英文、简称或代码；也可自行输入" autoComplete="off" required /><span className="field-help">已收录 {AIRLINES.length} 家常用航司，输入关键词查看更多候选。</span>{focused && options.length > 0 && <div className="airline-options" id={listId} role="listbox" aria-label="航空公司候选">{options.map((airline, index) => <button type="button" role="option" aria-selected={active === index} id={`${listId}-${index}`} key={airline.iata} ref={(element) => { if (active === index) element?.scrollIntoView({ block: "nearest" }); }} onMouseDown={(event) => event.preventDefault()} onClick={() => select(airline)}><b>{airline.iata}</b><span>{airline.name}<small>{airline.nameEn}</small></span></button>)}</div>}</label>;
}

function AircraftTypeField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [focused, setFocused] = useState(false);
  const options = focused ? searchAircraftTypes(value) : [];
  return <label className="aircraft-autocomplete">机型 <span className="optional-tag">选填</span><input value={value} onChange={(event) => onChange(event.target.value)} onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); onChange(normalizeAircraftType(value)); }} placeholder="例如 78X、787-10" autoComplete="off" />{options.length > 0 && <div className="aircraft-options">{options.map((option) => <button type="button" key={option.canonical} onMouseDown={(event) => event.preventDefault()} onClick={() => { onChange(option.canonical); setFocused(false); }}><b>{option.canonical}</b><small>{option.aliases.slice(0, 4).join(" · ")}</small></button>)}</div>}</label>;
}

function FlightStopEditor({ legend, stop, onChange }: { legend: string; stop: FlightStop; onChange: (stop: FlightStop) => void }) {
  const [query, setQuery] = useState(stop.airport);
  const options = query !== stop.airport || !stop.iata ? searchAirports(query) : [];
  function select(airport: AirportOption) {
    setQuery(airportLabel(airport));
    onChange({ ...stop, airport: airportLabel(airport), iata: airport.iata, timezone: airport.timezone, utc_offset_minutes: airport.timezone === stop.timezone ? stop.utc_offset_minutes : undefined });
  }
  const occurrences = (() => { try { return flightTimeOptions(stop); } catch { return []; } })();
  return <fieldset className="transport-stop field-span-2"><legend>{legend}</legend><div><label>日期<input type="date" value={stop.date} onChange={(event) => onChange({ ...stop, date: event.target.value, utc_offset_minutes: undefined })} required /></label><label>时间<input type="time" value={stop.time} onChange={(event) => onChange({ ...stop, time: event.target.value, utc_offset_minutes: undefined })} required /></label><label className="airport-autocomplete">机场<input value={query} onChange={(event) => { setQuery(event.target.value); onChange({ ...stop, airport: event.target.value, iata: "" }); }} placeholder="输入羽田、HND、Tokyo…" autoComplete="off" required />{options.length > 0 && <div className="airport-options">{options.map((airport) => <button type="button" key={airport.iata} onClick={() => select(airport)}><b>{airport.iata}</b><span>{airport.nameZh}<small>{airport.city} · {airport.nameEn}</small></span></button>)}</div>}</label><label>航站楼 <span className="optional-tag">选填</span><input value={stop.terminal} onChange={(event) => onChange({ ...stop, terminal: event.target.value })} /></label><label className="flight-timezone-field">当地时区<select value={stop.timezone || "Asia/Shanghai"} onChange={(event) => onChange({ ...stop, timezone: event.target.value, utc_offset_minutes: undefined })} required>{TIMEZONE_OPTIONS.map((timezone) => <option value={timezone} key={timezone}>{timeZoneLabel(timezone)}</option>)}</select></label>{occurrences.length > 1 && <label className="flight-timezone-field">重复当地时间 · 必选<select value={occurrences.some(option => option.utcOffsetMinutes === stop.utc_offset_minutes) ? stop.utc_offset_minutes : ""} onChange={event => onChange({ ...stop, utc_offset_minutes: event.target.value === "" ? undefined : Number(event.target.value) })} required><option value="" disabled>请选择第一次或第二次</option>{occurrences.map((option, index) => <option key={option.utcOffsetMinutes} value={option.utcOffsetMinutes}>{index === 0 ? "第一次" : "第二次"} · {utcOffsetLabel(option.utcOffsetMinutes)}</option>)}</select><small className="field-help">当地夏令时结束，同一个时间会出现两次。请按机票标注的偏移选择。</small></label>}</div></fieldset>;
}

function RailStop({ legend, value, onChange, stationLabel }: { legend: string; value: RailDetails["departure"]; onChange: (value: RailDetails["departure"]) => void; stationLabel: string }) {
  return <fieldset className="transport-stop field-span-2"><legend>{legend}</legend><div className="rail-stop-grid"><label>日期<input type="date" value={value.date} onChange={(event) => onChange({ ...value, date: event.target.value })} required /></label><label>时间<input type="time" value={value.time} onChange={(event) => onChange({ ...value, time: event.target.value })} required /></label><label>{stationLabel}<input value={value.station} onChange={(event) => onChange({ ...value, station: event.target.value })} required /></label></div></fieldset>;
}

function TransitAiDialog({ metro, isDemo, onClose, onFill }: { metro: MetroDetails; isDemo: boolean; onClose: () => void; onFill: (route: string) => void }) {
  const [query, setQuery] = useState(`从${metro.origin}到${metro.destination}怎么乘坐地铁或公共交通？`);
  const [preview, setPreview] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  async function runQuery() { setLoading(true); setError(""); try { setPreview(await queryTransitRoute(metro.origin, metro.destination, query, metro.estimated_departure_time, isDemo)); } catch (queryError) { setError(queryError instanceof Error ? queryError.message : TRANSIT_AI_ERROR); } finally { setLoading(false); } }
  return <div className="nested-modal-backdrop"><section className="modal-card glass-card transit-ai-modal" role="dialog" aria-modal="true"><header><div><p className="eyebrow">AI 路线查询</p><h2>确认查询内容</h2></div><button type="button" className="icon-button" onClick={onClose}><X /></button></header><label>查询内容<textarea rows={3} value={query} onChange={(event) => setQuery(event.target.value)} maxLength={500} /></label><button type="button" className="secondary-button ai-query-submit" disabled={loading || !query.trim()} onClick={() => void runQuery()}>{loading ? <LoaderCircle className="spin" size={16} /> : <Sparkles size={16} />}{loading ? "正在查询…" : "查询路线"}</button>{error && <p className="field-error">{error}</p>}{preview && <label>路线预览<textarea rows={7} value={preview} onChange={(event) => setPreview(event.target.value)} /></label>}<p className="ai-disclaimer">AI 结果仅供规划参考。确认后才会填入表单，请以当地实时交通信息为准。</p><footer><button type="button" className="secondary-button" onClick={onClose}>取消</button>{preview && <button type="button" className="primary-button" onClick={() => onFill(preview)}>确认并填入</button>}</footer></section></div>;
}

export function TransportDetailsPanel({ record, isDemo = false, onUpdate, onEdit }: { record: LifeRecord; isDemo?: boolean; onUpdate: (record: LifeRecord, serverConfirmed?: boolean) => Promise<void>; onEdit: () => void }) {
  const [gate, setGate] = useState(record.transport_type === "flight" ? (record.transport_details as FlightDetails).gate || "" : "");
  const [savingGate, setSavingGate] = useState(false);
  const [matching, setMatching] = useState(false);
  const [matchError, setMatchError] = useState("");
  const [preview, setPreview] = useState<FlightMatchPreview | null>(null);
  if (!record.transport_type || !record.transport_details) return <button className="edit-plan-button" onClick={onEdit}>编辑事项信息</button>;
  const presentation = getTransportPresentation(record);

  async function saveGate() {
    if (record.transport_type !== "flight") return;
    setSavingGate(true); setMatchError("");
    try { await onUpdate({ ...record, transport_details: { ...(record.transport_details as FlightDetails), gate: gate.trim() || undefined }, updated_at: new Date().toISOString() }); }
    catch (error) { setMatchError(error instanceof Error ? error.message : "登机口保存失败，输入内容已保留。"); }
    finally { setSavingGate(false); }
  }
  async function runMatch(rematch = false) {
    if (rematch && !window.confirm("重新匹配会再次使用一次航班查询额度，是否继续？")) return;
    setMatching(true); setMatchError("");
    try { setPreview(isDemo ? demoFlightPreview(record) : await matchFlightActual(record, rematch)); }
    catch (error) { setMatchError(error instanceof Error ? error.message : "暂时无法匹配航班"); }
    finally { setMatching(false); }
  }
  async function confirmPreview() {
    if (!preview) return;
    setMatching(true); setMatchError("");
    try {
      if (preview.planKey !== flightPlanKey(record) || preview.planVersion !== (record.flight_plan_version ?? 1)) throw new Error("航班计划已修改，这份预览不再适用。请先核对并保存最新计划。");
      if (isDemo) await onUpdate({ ...record, actual_match_status: "matched", actual_info: preview.preview, actual_info_matched: true, flight_plan_version: preview.planVersion, actual_match_plan_version: preview.planVersion, actual_confirmed_request_id: preview.requestId, actual_matched_at: preview.preview.matched_at || new Date().toISOString(), actual_match_provider: "aviationstack", actual_match_request_id: preview.requestId, updated_at: new Date().toISOString() });
      else await onUpdate(await confirmFlightActual(record.id, preview.requestId, preview.planVersion, preview.recoveryToken), true);
      setPreview(null);
    } catch (error) { setMatchError(error instanceof Error ? error.message : "保存失败"); }
    finally { setMatching(false); }
  }
  const eligibility = flightMatchEligibility(record);
  const matched = flightMatchIsCurrent(record);

  return <section className="transport-details-panel"><div className="transport-details-heading"><div><span>{presentation.label}</span><strong>{presentation.title}</strong></div><button className="edit-plan-button" onClick={onEdit}>编辑完整信息</button></div>
    {record.transport_type === "flight" && (() => {
      const details = record.transport_details as FlightDetails;
      const actual = matched ? record.actual_info : null;
      const gateEditor = <div className="gate-editor"><label>{matched ? "手动登机口（原计划）" : "登机口"}<input value={gate} onChange={(event) => setGate(event.target.value)} placeholder="尚未公布" /></label><button className="secondary-button" disabled={savingGate || gate === (details.gate || "")} onClick={() => void saveGate()}>{savingGate ? "保存中…" : "更新登机口"}</button></div>;
      return <>
        <FlightDetailsView record={record} />
        {record.actual_info_matched && actual ? <details className="flight-original-plan"><summary>查看原计划与修改登机口</summary><FlightDetailsView record={record} original />{gateEditor}</details> : gateEditor}
        <div className="flight-match-card">{record.actual_info_matched && actual ? <><div className="match-success"><Check size={16} /><span><b>实际飞行信息已匹配</b><small>原计划完整保留；打开页面不会重复查询</small></span></div><details className="flight-provider-details"><summary>查看接口返回详情</summary><ActualFlightSummary actual={actual} /></details><button className="text-button" disabled={matching} onClick={() => void runMatch(true)}>重新匹配</button></> : <><div><b>实际飞行信息</b><p>{eligibility.reason}</p>{(record.actual_match_status === "not_found" || record.actual_match_status === "failed") && <small>上次没有保存匹配结果；再次尝试会使用一次航班额度。</small>}</div>{eligibility.eligible && <button className="secondary-button" disabled={matching} onClick={() => void runMatch(record.actual_match_status === "not_found" || record.actual_match_status === "failed")}>{matching ? <LoaderCircle className="spin" size={15} /> : <Plane size={15} />}{matching ? "正在匹配…" : record.actual_match_status === "not_found" || record.actual_match_status === "failed" ? "重新匹配" : "匹配实际飞行信息"}</button>}</>}{matchError && <p className="field-error">{matchError}</p>}</div>
      </>;
    })()}
    {record.transport_type === "rail" && (() => { const details = record.transport_details as RailDetails; return <><div className="transport-route-grid"><div><small>出发</small><b>{details.departure.station}</b><span>{details.departure.date} · {details.departure.time}</span></div><TrainFront size={18} /><div><small>到达</small><b>{details.arrival.station}</b><span>{details.arrival.date} · {details.arrival.time}</span></div></div></>; })()}
    {record.transport_type === "metro" && (() => { const details = record.transport_details as MetroDetails; return <><div className="transport-route-grid metro"><div><small>出发点</small><b>{details.origin}</b></div><Route size={18} /><div><small>到达点</small><b>{details.destination}</b></div></div>{details.route_description && <div className="route-description-preview"><CalendarClock size={16} /><p>{details.route_description}</p></div>}</>; })()}
    {preview && <FlightPreviewDialog plan={record.transport_details as FlightDetails} actual={preview.preview} warning={preview.warning} loading={matching} onClose={() => setPreview(null)} onConfirm={() => void confirmPreview()} />}
  </section>;
}

function ActualFlightSummary({ actual }: { actual: ActualFlightInfo }) {
  return <div className="actual-flight-summary"><span>状态 <b>{actual.status || "已完成"}</b></span><span>实际起飞 <b>{actual.departure.actual.date || actual.departure.estimated.date} {actual.departure.actual.time || actual.departure.estimated.time}</b></span><span>实际到达 <b>{actual.arrival.actual.date || actual.arrival.estimated.date} {actual.arrival.actual.time || actual.arrival.estimated.time}</b></span>{actual.arrival.delay_minutes > 0 && <span>到达延误 <b>{actual.arrival.delay_minutes} 分钟</b></span>}{actual.aircraft_type && <span>实际机型 <b>{actual.aircraft_type}</b></span>}</div>;
}

function FlightPreviewDialog({ plan, actual, warning, loading, onClose, onConfirm }: { plan: FlightDetails; actual: ActualFlightInfo; warning?: string; loading: boolean; onClose: () => void; onConfirm: () => void }) {
  return <div className="nested-modal-backdrop"><section className="modal-card glass-card flight-lookup-modal"><header><div><p className="eyebrow">计划 vs 实际</p><h2>确认实际飞行信息</h2></div><button className="icon-button" onClick={onClose}><X /></button></header><p className="flight-lookup-intro">先核对差异，再决定是否保存。原计划会完整保留。</p>{warning && <p className="field-error" role="alert">{warning}</p>}<div className="flight-compare-grid"><article><b>计划</b><span>起飞 {plan.departure.date} {plan.departure.time}</span><span>到达 {plan.arrival.date} {plan.arrival.time}</span><span>登机口 {plan.gate || "未填写"}</span><span>机型 {plan.aircraft_type || "未填写"}</span></article><article><b>实际</b><span>起飞 {actual.departure.actual.date || actual.departure.estimated.date} {actual.departure.actual.time || actual.departure.estimated.time}</span><span>到达 {actual.arrival.actual.date || actual.arrival.estimated.date} {actual.arrival.actual.time || actual.arrival.estimated.time}</span><span>登机口 {actual.departure.gate || "未提供"}</span><span>机型 {actual.aircraft_type || "未提供"}</span></article></div><footer><button className="secondary-button" onClick={onClose}>保留计划</button><button className="primary-button" disabled={loading} onClick={onConfirm}>{loading ? "保存中…" : "确认保存实际信息"}</button></footer></section></div>;
}

````

## src/components/ui.tsx

<!-- source: src/components/ui.tsx sha256: 02c522d8295d75d1f7191a15c2cb530c55d9072e3525c8b92615ecc04110b2e7 encoding: utf8 -->
````tsx
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

/** Presentation only: native button type, callbacks and disabled state pass through. */
export function Button({ className = "", variant = "primary", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" }) {
  return <button className={`${variant}-button ${className}`.trim()} {...props} />;
}

export function DialogSurface({ className = "", ...props }: HTMLAttributes<HTMLElement>) {
  return <section className={`glass-card ${className}`.trim()} role="dialog" aria-modal="true" {...props} />;
}

export function EmptyState({ icon: Icon, title, description, className = "", children }: { icon: LucideIcon; title: string; description: string; className?: string; children?: ReactNode }) {
  return <div className={`empty-state glass-card ${className}`.trim()}><span><Icon size={20} /></span><h3>{title}</h3><p>{description}</p>{children}</div>;
}

export function SettingsRow({ icon: Icon, title, description, trailing, className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon: LucideIcon; title: string; description: string; trailing: ReactNode }) {
  return <button className={`settings-row ${className}`.trim()} {...props}><span className="settings-icon"><Icon size={20} /></span><div><b>{title}</b><small>{description}</small></div>{trailing}</button>;
}

````

## src/styles/tokens.css

<!-- source: src/styles/tokens.css sha256: ccf1c7cf38b5d47ecb50ffb5a3578830887523f50e651a6976964bf068661f3b encoding: utf8 -->
````css
/* One presentation-only source of truth. Theme preference/storage is unchanged. */
:root {
  color-scheme: dark;
  font-family: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
  --font-ui: -apple-system, "PingFang SC", "Helvetica Neue", sans-serif;
  --bg: #000000;
  --bg-elevated: #1c1c1e;
  --surface: #1c1c1e;
  --surface-solid: var(--surface);
  --surface-soft: #242426;
  --surface-hover: #2c2c2e;
  --field-bg: var(--surface);
  --border: #2c2c2e;
  --border-strong: #48484a;
  --card-border: var(--border);
  --text: #f2f2f7;
  --text-soft: #d1d1d6;
  --muted: #98989f;
  --accent: #0a84ff;
  --accent-strong: var(--accent);
  --green: #34c759;
  --warning: #ff9500;
  --danger: #ff3b30;
  --on-accent: #ffffff;
  --violet: var(--muted);
  --coral: var(--muted);
  --backdrop: rgba(0, 0, 0, .56);
  --toast-bg: #1c1c1e;
  --toast-text: #f2f2f7;
  --card-shadow: none;
  --shadow: var(--card-shadow);
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --radius-card: 16px;
  --radius-control: 10px;
  --radius-badge: 8px;
  --duration: 180ms;
  --ease: ease-out;
  --chart-1: #0a84ff;
  --chart-2: #379aff;
  --chart-3: #64b0ff;
  --chart-4: #91c6ff;
  --chart-5: #bedcff;
  --chart-6: #dcedff;
}

:root[data-theme="light"] {
  color-scheme: light;
  --bg: #f5f5f7;
  --bg-elevated: #ffffff;
  --surface: #ffffff;
  --surface-soft: #f5f5f7;
  --surface-hover: #f5f5f7;
  --border: #e5e5ea;
  --border-strong: #c7c7cc;
  --card-border: transparent;
  --text: #1c1c1e;
  --text-soft: #3a3a3c;
  --muted: #8e8e93;
  --card-shadow: 0 1px 3px rgba(0, 0, 0, .06);
}

@media (prefers-color-scheme: light) {
  :root[data-theme="system"] {
    color-scheme: light;
    --bg: #f5f5f7;
    --bg-elevated: #ffffff;
    --surface: #ffffff;
    --surface-soft: #f5f5f7;
    --surface-hover: #f5f5f7;
    --border: #e5e5ea;
    --border-strong: #c7c7cc;
    --card-border: transparent;
    --text: #1c1c1e;
    --text-soft: #3a3a3c;
    --muted: #8e8e93;
    --card-shadow: 0 1px 3px rgba(0, 0, 0, .06);
  }
}

````

## src/styles.css

<!-- source: src/styles.css sha256: b0ca44b557db7e8788459e9e09ebc20d9405397330ea3c8506764bde618effff encoding: utf8 -->
````css
@import "tailwindcss";

.local-copy-content { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 18rem; overflow-y: auto; font: inherit; }

@import "./styles/tokens.css";
* { box-sizing: border-box; }
#root :is(button, input, textarea, select):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
html { background: var(--bg); min-height: 100%; scroll-behavior: smooth; }
body { margin: 0; min-width: 320px; min-height: 100vh; background: var(--bg); color: var(--text); -webkit-font-smoothing: antialiased; }
input { font: inherit; }
textarea { font: inherit; }
select { font: inherit; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
textarea:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
select:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button { font: inherit; color: inherit; cursor: pointer; }
button:disabled { cursor: not-allowed; opacity: .5; }
a { color: inherit; }
.eyebrow { text-transform: uppercase; margin: 0 0 8px; color: var(--muted); font-size: 13px; letter-spacing: .06em; font-weight: 600; }
.secondary-button { border: 0; display: inline-flex; align-items: center; justify-content: center; gap: 8px; }
.primary-button { border: 0; display: inline-flex; align-items: center; justify-content: center; gap: 8px; color: var(--on-accent); background: var(--accent); box-shadow: var(--card-shadow); }
.primary-button:hover { transform: none; filter: brightness(1.05); }
.full { width: 100%; }
.icon-button { display: inline-flex; align-items: center; justify-content: center; padding: 0; border: 1px solid transparent; border-radius: var(--radius-control); background: transparent; color: var(--muted); width: 44px; height: 44px; }
.spin { animation: spin 1s linear infinite; }
@keyframes spin {
to { transform: rotate(360deg); } }

/* Login */
.login-shell { min-height: 100vh; display: grid; place-items: center; position: relative; overflow: hidden; padding: 48px 24px; background: var(--bg); }
.login-layout { width: min(1040px, 100%); display: grid; grid-template-columns: 1.1fr .82fr; position: relative; z-index: 1; }
.brand-mark { display: inline-flex; align-items: center; gap: 8px; color: var(--text-soft); font-size: 15px; font-weight: 700; letter-spacing: .03em; }
.login-story h1 { font-size: clamp(45px, 5.3vw, 72px); letter-spacing: -.055em; font-weight: 700; }
.login-story h1 span { -webkit-background-clip: text; background-clip: text; }
.login-story > p { max-width: 520px; color: var(--muted); line-height: 1.75; }
.feature-row { display: flex; margin-top: 42px; gap: var(--space-5); }
.feature-row > div { display: grid; column-gap: 8px; align-items: center; grid-template-columns: 20px auto; padding-right: 0; gap: var(--space-2); }
.feature-row b { font-size: 14px; }
.feature-row small { color: var(--muted); font-size: 13px; grid-column: 2; }
.feature-icon { grid-row: span 2; width: 40px; height: 40px; border-radius: var(--radius-card); display: grid; place-items: center; }
.feature-icon.coral { background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--coral); }
.feature-icon.blue { background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); }
.feature-icon.violet { background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--violet); }
.login-card { border-radius: var(--radius-card); }
.login-card-heading { display: flex; margin-bottom: 24px; align-items: start; gap: var(--space-3); }
.mail-badge { width: 48px; height: 48px; display: grid; place-items: center; border-radius: var(--radius-card); background: color-mix(in srgb, var(--accent) 11%, transparent); }
.login-card h2 { margin: 0 0 4px; letter-spacing: -.02em; font-size: 20px; line-height: 1.4; font-weight: 600; }
.login-card-heading p { margin: 0; color: var(--muted); }
.login-card form > label { display: block; color: var(--text-soft); font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.modal-card .form-row label { display: block; color: var(--text-soft); font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.email-field { height: 52px; display: flex; align-items: center; gap: 8px; border: 1px solid var(--border-strong); background: var(--field-bg); border-radius: var(--radius-control); padding: 0 12px; margin-bottom: 12px; }
.email-field svg { color: var(--muted); }
.email-field input { border: 0; outline: 0; background: transparent; color: var(--text); flex: 1; min-width: 0; }
.form-hint { text-align: center; font-size: 13px; color: var(--muted); margin: 12px 0 0; }
.field-error { color: var(--danger); font-size: 13px; }
.privacy-note { margin-top: 24px; padding-top: 16px; border-top: 1px solid var(--border); display: flex; gap: 8px; }
.privacy-note svg { flex: none; }
.sent-state { text-align: center; padding: 8px 0 4px; }
.success-ring { width: 62px; height: 62px; margin: 0 auto 16px; display: grid; place-items: center; border-radius: 50%; border: 1px solid color-mix(in srgb, var(--accent) 25%, transparent); }
.sent-state h3 { margin: 0 0 8px; }
.sent-state p { color: var(--muted); font-size: 14px; line-height: 1.65; }
.text-button { background: transparent; border: 0; color: var(--accent); font-weight: 700; }
.otp-form { display: grid; gap: 8px; margin-top: 16px; text-align: left; }
.otp-form > label { margin: 0; color: var(--text-soft); font-size: 13px; font-weight: 600; }
.otp-code-input { width: 100%; height: 58px; border: 1px solid var(--border-strong); border-radius: var(--radius-control); outline: 0; background: var(--surface-hover); color: var(--text); font-size: 25px; font-weight: 700; letter-spacing: .42em; text-align: center; }
.otp-code-input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 13%, transparent); }
.otp-secondary-actions { display: flex; justify-content: center; gap: 16px; margin-top: 12px; }
.otp-secondary-actions .text-button:disabled { color: var(--muted); }

/* App shell */
.app-shell { min-height: 100vh; background: var(--bg); }
.app-header { height: 68px; position: sticky; top: 0; z-index: 40; display: flex; align-items: center; padding: 0 max(24px, calc((100vw - 1180px) / 2)); border-bottom: 1px solid var(--border); }
.app-brand { padding: 0; display: flex; align-items: center; gap: 8px; background: transparent; border: 0; letter-spacing: -.02em; }
.app-brand > span { display: grid; place-items: center; }
.desktop-nav { display: flex; margin-left: 52px; height: 100%; gap: 8px; }
.desktop-nav button { position: relative; display: flex; align-items: center; gap: 8px; padding: 0 12px; background: transparent; border: 0; color: var(--muted); font-size: 14px; font-weight: 600; }
.desktop-nav button.active::after { content: ""; position: absolute; bottom: 0; height: 2px; border-radius: var(--radius-control); }
.header-actions { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.connection { display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--muted); margin-right: 4px; }
.connection.online svg { color: var(--green); }
.connection.offline svg { color: var(--coral); }
.mini-avatar { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 50%; background: var(--accent); border: 1px solid var(--border-strong); font-size: 13px; font-weight: 700; }
.app-main { width: min(1080px, calc(100% - 40px)); margin: 0 auto; padding: 34px 0 120px; min-width: 0; padding-top: var(--space-6); }
.offline-banner { padding: 8px 16px; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 13px; border-bottom: 1px solid color-mix(in srgb, var(--accent) 15%, transparent); }
.setup-banner { padding: 8px 16px; display: flex; align-items: center; justify-content: center; gap: 8px; font-size: 13px; flex-wrap: wrap; }
.current-trip { width: 100%; display: flex; align-items: center; gap: 16px; padding: 16px 16px; border-radius: var(--radius-card); text-align: left; margin-bottom: 16px; color: var(--text); transition: background-color var(--duration) var(--ease), border-color var(--duration) var(--ease), color var(--duration) var(--ease), opacity var(--duration) var(--ease); }
.current-trip:hover { transform: none; border-color: color-mix(in srgb, var(--accent) 20%, transparent); }
.current-trip-icon { width: 42px; height: 42px; display: grid; place-items: center; flex: none; border-radius: var(--radius-card); background: color-mix(in srgb, var(--accent) 12%, transparent); color: var(--accent); }
.current-trip div { flex: 1; }
.current-trip small { color: var(--accent); font-weight: 700; }
.current-trip strong { display: block; font-size: 15px; margin: 4px 0; }
.current-trip p { margin: 0; color: var(--muted); font-size: 13px; }
.current-trip > svg { color: var(--muted); }

/* Composer */
.home-quick-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(260px, .42fr); gap: 12px; align-items: stretch; }
.home-quick-grid > .quick-collapsed { height: 100%; }
.home-quick-grid > .quick-expanded { height: 100%; }
.home-route-entry { width: 100%; min-height: 94px; display: flex; align-items: center; gap: 12px; color: var(--text); text-align: left; transition: background-color var(--duration) var(--ease), border-color var(--duration) var(--ease), color var(--duration) var(--ease), opacity var(--duration) var(--ease); border-radius: var(--radius-card); padding: var(--space-4); }
.home-route-entry:hover { transform: none; border-color: color-mix(in srgb, var(--violet) 35%, var(--border)); }
.home-route-entry > span { flex: none; display: grid; place-items: center; color: var(--muted); background: transparent; width: 24px; height: 24px; border-radius: 0; }
.home-route-entry > div { min-width: 0; flex: 1; }
.home-route-entry b { display: block; font-size: 16px; font-weight: 600; }
.home-route-entry small { display: block; margin-top: 4px; color: var(--muted); font-size: 14px; line-height: 1.5; }
.home-route-entry > svg { flex: none; color: var(--muted); }
.quick-collapsed { width: 100%; min-height: 94px; display: flex; align-items: center; gap: 16px; color: var(--text); text-align: left; transition: background-color var(--duration) var(--ease), border-color var(--duration) var(--ease), color var(--duration) var(--ease), opacity var(--duration) var(--ease); }
.quick-collapsed:hover { border-color: color-mix(in srgb, var(--accent) 22%, transparent); transform: none; }
.quick-plus { display: grid; place-items: center; flex: none; }
.quick-collapsed > span:nth-child(2) { flex: 1; }
.quick-collapsed b { display: block; margin-bottom: 4px; font-size: 16px; font-weight: 600; }
.quick-collapsed small { color: var(--muted); font-size: 14px; line-height: 1.5; }
.quick-types { display: flex; gap: var(--space-2); }
.composer-top { display: flex; align-items: center; justify-content: space-between; }
.type-switch { display: flex; }
.type-switch button { height: 34px; display: flex; align-items: center; gap: 4px; border: 0; background: transparent; color: var(--muted); font-weight: 700; }
.type-switch button.active.expense svg { color: var(--coral); }
.type-switch button.active.trip svg { color: var(--accent); }
.type-switch button.active.note svg { color: var(--violet); }
.composer-main-input { width: 100%; height: 64px; padding: 4px 4px 0; border: 0; border-bottom: 1px solid var(--border); outline: 0; background: transparent; color: var(--text); font-weight: 600; letter-spacing: -.02em; font-size: 20px; }
.composer-main-input::placeholder { color: color-mix(in srgb, var(--muted) 65%, transparent); }
.expense-fields { padding-top: 16px; display: grid; grid-template-columns: 1.15fr .9fr; gap: 12px; }
.amount-box { position: relative; display: flex; align-items: center; gap: 8px; border-radius: var(--radius-card); border: 1px solid var(--border); background: var(--field-bg); padding: 12px 12px 4px; }
.amount-box > span { font-size: 20px; }
.amount-box input { min-width: 0; width: 100%; border: 0; outline: 0; background: transparent; color: var(--text); font-size: 24px; font-weight: 700; }
.amount-box label { position: absolute; left: 14px; color: var(--muted); font-size: 13px; top: 4px; }
.select-field { position: relative; border: 1px solid var(--border); border-radius: var(--radius-control); background: var(--field-bg); padding: 8px 38px 8px 12px; }
.select-field span { display: block; color: var(--muted); font-size: 13px; }
.select-field select { width: 100%; border: 0; outline: 0; appearance: none; background: transparent; color: var(--text); font-weight: 600; }
.select-field svg { position: absolute; right: 13px; color: var(--muted); pointer-events: none; top: 32px; }
.category-picker { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(6, 1fr); gap: var(--space-2); }
.category-picker button { height: 48px; display: flex; align-items: center; justify-content: center; gap: 4px; border-radius: var(--radius-control); border: 1px solid var(--border); background: transparent; color: var(--muted); font-size: 13px; }
.composer-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding-top: 12px; }
.soft-field { display: flex; align-items: center; gap: 8px; padding: 0 12px; border: 1px solid var(--border); border-radius: var(--radius-control); color: var(--muted); background: var(--field-bg); }
.soft-field input { flex: 1; min-width: 0; width: 100%; border: 0; outline: 0; background: transparent; color: var(--text-soft); font-size: 15px; }
.soft-field select { flex: 1; min-width: 0; width: 100%; border: 0; outline: 0; background: transparent; color: var(--text-soft); appearance: none; font-size: 15px; }
.composer textarea { width: 100%; resize: vertical; margin-top: 8px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-control); outline: 0; background: var(--field-bg); color: var(--text); }
.composer-actions { display: flex; align-items: center; justify-content: space-between; padding-top: 8px; }
.composer-actions > span { color: var(--muted); font-size: 13px; }
.composer-actions .primary-button { min-height: 40px; }
.composer-compact { box-shadow: none; background: var(--surface-solid); }
.composer-modal { position: fixed; inset: 0; z-index: 70; display: grid; place-items: center; padding: 16px; background: var(--backdrop); }
.composer-modal-inner { width: min(720px, 100%); max-height: calc(100dvh - 48px); overflow-y: auto; }
.floating-add { position: fixed; right: max(24px, calc((100vw - 1180px) / 2)); bottom: 28px; z-index: 50; width: 56px; height: 56px; display: grid; place-items: center; border: 0; border-radius: var(--radius-card); color: var(--on-accent); background: var(--accent); box-shadow: var(--card-shadow); transition: background-color var(--duration) var(--ease), border-color var(--duration) var(--ease), color var(--duration) var(--ease), opacity var(--duration) var(--ease); }

/* Filters and timeline */
.filter-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
.filter-tabs { display: flex; overflow-x: auto; scrollbar-width: none; }
.filter-tabs button { height: 38px; display: flex; align-items: center; gap: 8px; background: transparent; color: var(--muted); white-space: nowrap; }
.filter-tabs button span { min-width: 20px; border-radius: var(--radius-control); font-size: 13px; text-align: center; }
.filter-tabs button.active { border-color: var(--border); }
.filter-tabs button.active svg { color: var(--accent); }
.planner-link { display: flex; align-items: center; gap: 8px; border: 0; background: transparent; color: var(--text-soft); font-size: 13px; white-space: nowrap; }
.planner-link svg:first-child { color: var(--accent); }
.timeline { display: grid; }
.timeline-day { display: grid; grid-template-columns: 92px 1fr; gap: 16px; }
.day-label { position: sticky; top: 90px; height: fit-content; padding-top: 8px; }
.day-label span { display: block; font-size: 14px; font-weight: 700; }
.day-label small { color: var(--muted); font-size: 13px; }
.day-records { display: grid; position: relative; }
.day-records::before { content: ""; position: absolute; left: -9px; top: 18px; bottom: 18px; width: 1px; }
.record-card { min-height: 106px; position: relative; display: flex; align-items: flex-start; border-radius: var(--radius-card); }
.record-card::before { content: ""; position: absolute; left: -13px; top: 24px; width: 7px; height: 7px; border-radius: 50%; background: var(--surface-solid); border: 2px solid var(--muted); }
.record-card.record-expense::before { border-color: var(--coral); }
.record-card.record-trip::before { border-color: var(--accent); }
.record-card.record-note::before { border-color: var(--violet); }
.record-icon { width: 38px; height: 38px; flex: none; display: grid; place-items: center; border-radius: var(--radius-card); }
.record-expense .record-icon { color: var(--coral); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.record-trip .record-icon { color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.record-note .record-icon { color: var(--violet); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.record-main { flex: 1; min-width: 0; }
.record-meta { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 13px; flex-wrap: wrap; letter-spacing: normal; }
.record-meta > span { text-transform: uppercase; letter-spacing: normal; font-weight: 500; }
.record-meta i { opacity: .5; }
.record-meta em { margin-left: 4px; padding: 4px 8px; border-radius: var(--radius-badge); background: var(--surface-hover); color: var(--text-soft); font-style: normal; }
.record-main h3 { margin: 8px 0 4px; letter-spacing: -.01em; font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
.record-main > p { margin: 0 0 8px; color: var(--text-soft); line-height: 1.6; font-size: 15px; }
.record-details { display: flex; flex-wrap: wrap; gap: 12px; }
.record-details > span { display: inline-flex; align-items: center; gap: 4px; color: var(--muted); font-size: 13px; }
.record-details .status.planned { color: var(--accent); }
.record-details .status.completed { color: var(--green); }
.record-amount { margin-top: 4px; }
.record-actions { display: flex; gap: 4px; }
.record-actions button { display: grid; place-items: center; border: 1px solid var(--border); border-radius: var(--radius-control); background: transparent; color: var(--muted); width: 40px; height: 40px; }
.record-actions button:first-child:hover { color: var(--green); border-color: color-mix(in srgb, var(--accent) 22%, transparent); }
.record-actions button:last-child:hover { color: var(--danger); }
.done-stamp { display: flex; align-items: center; gap: 4px; padding: 4px 8px; border-radius: var(--radius-badge); color: var(--green); font-size: 13px; font-weight: 700; }
.timeline-pin { display: none; }
.empty-timeline { padding: 60px 24px; text-align: center; border-radius: var(--radius-card); }
.empty-timeline > span { width: 54px; height: 54px; display: grid; place-items: center; margin: auto; border-radius: var(--radius-card); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.empty-planner > span { width: 54px; height: 54px; display: grid; place-items: center; margin: auto; border-radius: var(--radius-card); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.empty-timeline h3 { margin: 16px 0 4px; }
.empty-planner h3 { margin: 16px 0 4px; }
.empty-timeline p { color: var(--muted); font-size: 13px; }
.empty-planner p { color: var(--muted); font-size: 13px; }

/* Stats */
.stats-section { margin-bottom: 32px; }
.stats-toolbar { display: flex; align-items: end; justify-content: space-between; margin: 4px 0 16px; }
.stats-toolbar h2 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -.02em; }
.range-switch { display: flex; padding: 4px; border-radius: var(--radius-control); border: 1px solid var(--border); }
.range-switch button { height: 30px; padding: 0 12px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--muted); min-height: 44px; font-size: 15px; }
.summary-grid { display: grid; grid-template-columns: 1.6fr .9fr; gap: 12px; }
.total-card { border-radius: var(--radius-card); padding: 16px; box-shadow: var(--card-shadow); position: relative; overflow: hidden; }
.total-card::after { display: none; }
.summary-icon { position: absolute; right: 18px; top: 18px; color: var(--accent); }
.total-card > p { margin: 0 0 8px; color: var(--muted); font-size: 13px; }
.total-card > strong { display: block; font-size: clamp(28px, 5vw, 38px); letter-spacing: -.05em; }
.summary-foot { display: flex; align-items: center; gap: 16px; margin-top: 12px; }
.summary-foot > span { color: var(--muted); font-size: 13px; }
.summary-foot button { display: flex; align-items: center; gap: 4px; border: 0; background: transparent; color: var(--accent); font-size: 13px; }
.total-card > small { color: var(--muted); font-size: 13px; display: block; margin-top: 8px; }
.insight-card { border-radius: var(--radius-card); padding: 16px; box-shadow: var(--card-shadow); position: relative; display: flex; flex-direction: column; justify-content: center; }
.insight-card > span { color: var(--muted); font-size: 13px; }
.insight-card > strong { font-size: 20px; margin-top: 4px; }
.insight-card p { color: var(--text-soft); font-size: 13px; margin: 4px 0 0; }
.insight-card svg { position: absolute; top: 17px; right: 17px; color: var(--violet); }
.charts-grid { display: grid; grid-template-columns: 1fr 1.35fr; gap: 12px; margin-top: 12px; }
.chart-card { min-width: 0; border-radius: var(--radius-card); padding: 16px; box-shadow: var(--card-shadow); }
.chart-card header h3 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
.chart-card header p { color: var(--muted); font-size: 13px; margin: 0; }
.pie-layout { display: flex; align-items: center; }
.pie-chart { width: 58%; position: relative; }
.pie-chart > span { position: absolute; inset: 0; display: grid; place-content: center; text-align: center; color: var(--muted); font-size: 13px; pointer-events: none; }
.pie-chart > span b { display: block; color: var(--text); font-size: 20px; }
.chart-legend { flex: 1; display: grid; gap: 8px; min-width: 100px; }
.chart-legend > div { display: grid; grid-template-columns: 7px 1fr auto; gap: 8px; align-items: center; font-size: 13px; }
.chart-legend i { width: 7px; height: 7px; }
.chart-legend span { color: var(--text-soft); }
.empty-chart { height: 220px; display: flex; align-items: end; justify-content: center; gap: 8px; position: relative; padding-bottom: 46px; }
.empty-chart span { width: 25px; border-radius: var(--radius-card); background: var(--surface-hover); }
.empty-chart span:nth-child(1) { height: 38px; }
.empty-chart span:nth-child(2) { height: 68px; }
.empty-chart span:nth-child(3) { height: 50px; }
.empty-chart p { position: absolute; bottom: 12px; color: var(--muted); font-size: 13px; }
.chart-loading { min-height: 180px; margin-bottom: 24px; display: flex; align-items: center; justify-content: center; gap: 8px; border-radius: var(--radius-card); color: var(--muted); font-size: 13px; }

/* Planner */
.section-hero { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: var(--space-5); min-height: 0; }
.section-hero h1 { margin: 0 0 8px; font-size: 34px; letter-spacing: -.045em; }
.section-hero > div > p:last-child { margin: 0; max-width: 620px; color: var(--muted); line-height: 1.7; }
.trip-grid { display: grid; gap: 12px; }
.trip-card { width: 100%; position: relative; display: grid; gap: 16px; align-items: center; padding: 16px; border-radius: var(--radius-card); text-align: left; color: var(--text); transition: background-color var(--duration) var(--ease), border-color var(--duration) var(--ease), color var(--duration) var(--ease), opacity var(--duration) var(--ease); }
.trip-card:hover { transform: none; border-color: color-mix(in srgb, var(--accent) 21%, transparent); }
.trip-card-icon { width: 50px; height: 50px; display: grid; place-items: center; border-radius: var(--radius-card); color: var(--accent); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.trip-card p { margin: 0 0 4px; font-size: 13px; }
.trip-card h3 { margin: 0 0 8px; font-size: 18px; font-weight: 600; }
.trip-card div > span { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 13px; flex-wrap: wrap; }
.trip-progress { text-align: right; }
.trip-progress b { display: block; font-size: 16px; }
.trip-progress small { color: var(--muted); font-size: 13px; }
.trip-card > svg { color: var(--muted); }
.empty-planner { grid-column: 1 / -1; padding: 65px 24px; border-radius: var(--radius-card); text-align: center; }
.empty-planner .secondary-button { margin-top: 12px; }
.modal-backdrop { position: fixed; inset: 0; z-index: 80; display: grid; place-items: center; padding: 16px; background: var(--backdrop); }
.modal-card { width: min(500px, 100%); border-radius: var(--radius-card); }
.modal-card header { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--space-3); margin-bottom: var(--space-5); }
.modal-card h2 { margin: 0; font-size: 20px; line-height: 1.4; font-weight: 600; }
.modal-card input { width: 100%; height: 45px; display: block; margin-top: 8px; padding: 0 12px; border-radius: var(--radius-control); border: 1px solid var(--border); background: var(--field-bg); color: var(--text); outline: 0; }
.modal-card > label { display: block; color: var(--text-soft); font-size: 13px; font-weight: 600; margin-bottom: 16px; }
.form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.modal-card footer { display: flex; justify-content: flex-end; margin-top: 16px; flex-wrap: wrap; gap: var(--space-2); }
.trip-board-header { display: grid; grid-template-columns: 130px 1fr auto; gap: 16px; align-items: center; padding: 8px 0 24px; }
.back-button { align-self: start; display: flex; align-items: center; gap: 8px; padding: 0; border: 0; background: transparent; color: var(--muted); font-size: 13px; }
.trip-board-header p { margin: 0 0 4px; color: var(--accent); font-size: 13px; font-weight: 700; }
.trip-board-header h1 { margin: 0 0 8px; font-size: 30px; letter-spacing: -.04em; }
.trip-board-header div > span { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
.trip-board-header i { font-style: normal; opacity: .5; }
.trip-completion { text-align: right; }
.trip-completion b { display: block; font-size: 24px; }
.trip-completion span { color: var(--muted); font-size: 13px; }
.day-board { display: grid; gap: 24px; }
.day-column { min-height: 110px; padding-left: 115px; position: relative; transition: background-color var(--duration) var(--ease), border-color var(--duration) var(--ease), color var(--duration) var(--ease), opacity var(--duration) var(--ease); }
.day-column.drag-over { border-radius: var(--radius-card); }
.day-column > header { position: absolute; left: 0; top: 0; width: 96px; display: flex; justify-content: space-between; align-items: flex-start; }
.day-column > header strong { display: block; font-size: 15px; }
.day-column > header span { display: block; color: var(--muted); font-size: 13px; margin-top: 4px; }
.day-column > header .icon-button { width: 28px; height: 28px; }
.plan-list { display: grid; gap: 8px; position: relative; }
.plan-list::before { content: ""; position: absolute; left: -18px; top: 17px; bottom: -24px; width: 1px; background: var(--border); }
.plan-item { border-radius: var(--radius-card); }
.plan-item.dragging { opacity: .55; }
.plan-item.completed:not(.transport-plan) .plan-content strong { text-decoration: line-through; color: var(--muted); }
.plan-item.cancelled { opacity: .55; }
.plan-summary { min-height: 72px; display: grid; align-items: center; padding: 8px 12px; grid-template-columns: 28px 28px 52px minmax(0, 1fr) 44px; gap: var(--space-2); }
.drag-handle { width: 28px; height: 40px; display: grid; place-items: center; border: 0; background: transparent; color: var(--muted); touch-action: none; }
.plan-check { width: 24px; height: 24px; display: grid; place-items: center; border: 1px solid var(--border-strong); background: transparent; color: var(--green); border-radius: var(--radius-badge); }
.plan-time { color: var(--accent); font-size: 13px; font-weight: 700; }
.plan-time small { display: block; color: var(--muted); font-size: 11px; margin-top: 4px; }
.plan-content { min-width: 0; padding: 4px 0; border: 0; background: transparent; text-align: left; min-height: 44px; }
.plan-content strong { display: block; font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
.plan-content > span { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; line-height: 1.5; }
.plan-content em { font-style: normal; overflow: hidden; text-overflow: ellipsis; }
.plan-content > .plan-completed-badge { color: var(--green); font-weight: 600; }
.plan-flight-carryover { margin: 0; padding: 0 12px 12px; color: var(--muted); font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.plan-expanded { border-top: 1px solid var(--border); padding: 12px 16px 16px 84px; }
.actual-heading { display: flex; justify-content: space-between; margin-bottom: 8px; color: var(--text-soft); font-size: 13px; }
.actual-heading small { color: var(--muted); }
.actual-row { display: grid; grid-template-columns: 42px 1fr auto; gap: 8px; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border); }
.actual-row > span { padding: 4px 4px; border-radius: var(--radius-card); text-align: center; font-size: 13px; }
.actual-row.expense > span { color: var(--coral); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.actual-row.note > span { color: var(--violet); background: color-mix(in srgb, var(--accent) 10%, transparent); }
.actual-row b { display: block; font-size: 13px; }
.actual-row small { color: var(--muted); font-size: 13px; }
.actual-row strong { font-size: 13px; }
.add-actual { display: flex; align-items: center; gap: 4px; padding: 8px 0; border: 0; background: transparent; color: var(--accent); font-size: 13px; }
.plan-status-actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 8px; }
.plan-status-actions button { height: 30px; display: flex; align-items: center; gap: 4px; padding: 0 8px; border-radius: var(--radius-badge); border: 1px solid var(--border); background: transparent; color: var(--muted); font-size: 13px; min-height: 44px; }
.empty-day { min-height: 84px; display: flex; flex-direction: column; align-items: center; justify-content: center; border: 1px dashed var(--border-strong); border-radius: var(--radius-card); background: transparent; color: var(--muted); }
.empty-day svg { color: var(--accent); margin-bottom: 4px; }
.empty-day span { font-size: 13px; }
.empty-day small { font-size: 13px; margin-top: 4px; }
.plan-form { border: 1px solid color-mix(in srgb, var(--accent) 20%, transparent); border-radius: var(--radius-card); padding: 12px; margin-bottom: 8px; }
.plan-form > input { width: 100%; border: 0; border-bottom: 1px solid var(--border); background: transparent; color: var(--text); padding: 8px; outline: 0; font-size: 13px; }
.plan-form textarea { width: 100%; border: 0; border-bottom: 1px solid var(--border); background: transparent; color: var(--text); padding: 8px; outline: 0; font-size: 13px; }
.plan-form > div { display: grid; grid-template-columns: 120px 1fr; gap: 8px; margin-top: 8px; }
.plan-form label { height: 38px; display: flex; align-items: center; gap: 4px; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--radius-card); color: var(--muted); }
.plan-form label input { width: 100%; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text-soft); font-size: 13px; }
.plan-form footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.plan-form footer button { border: 0; background: transparent; color: var(--muted); font-size: 13px; }
.plan-form footer button:last-child { color: var(--accent); font-weight: 700; }

/* Settings */
.settings-layout { display: grid; grid-template-columns: 1fr 270px; gap: 16px; align-items: start; }
.settings-main { display: grid; gap: 12px; }
.settings-card { border-radius: var(--radius-card); box-shadow: var(--card-shadow); }
.settings-card > header { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.settings-card h2 { margin: 0 0 4px; font-size: 18px; }
.settings-card header p { margin: 0; color: var(--muted); font-size: 13px; }
.settings-icon { width: 38px; height: 38px; display: grid; place-items: center; flex: none; border-radius: var(--radius-card); }
.settings-icon svg { width: 18px; }
.settings-icon.blue, .settings-icon.violet, .settings-icon.coral, .settings-icon.green { color: var(--muted); background: transparent; }
.currency-grid { display: grid; gap: 8px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.currency-grid button { position: relative; display: grid; gap: 4px; align-items: center; border: 1px solid var(--border); border-radius: var(--radius-control); text-align: left; }
.currency-grid button.active { border-color: color-mix(in srgb, var(--accent) 30%, transparent); }
.currency-grid b { display: block; font-size: 15px; font-weight: 600; }
.currency-grid small { display: block; color: var(--muted); font-size: 13px; white-space: normal; }
.currency-grid button > svg { color: var(--accent); }
.theme-options { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.theme-options button { display: grid; grid-template-columns: 1fr auto; align-items: center; border: 1px solid var(--border); border-radius: var(--radius-control); background: transparent; text-align: left; height: auto; min-height: 76px; padding: var(--space-3); font-size: 14px; }
.theme-options button > svg:first-child { color: var(--muted); }
.theme-options button span { grid-column: 1 / -1; font-size: 13px; }
.settings-row { width: 100%; display: grid; gap: 8px; align-items: center; border: 0; border-bottom: 1px solid var(--border); background: transparent; text-align: left; grid-template-columns: 20px minmax(0, 1fr) auto; padding: var(--space-4) 0; column-gap: var(--space-3); }
.settings-row:last-child { border-bottom: 0; }
.settings-row b { display: block; font-size: 16px; font-weight: 600; }
.settings-row small { color: var(--muted); font-size: 13px; line-height: 1.5; }
.settings-row em { color: var(--muted); font-size: 13px; font-style: normal; }
.settings-row > svg { color: var(--muted); width: 20px; height: 20px; }
.account-card { position: sticky; top: 88px; border-radius: var(--radius-card); text-align: center; box-shadow: var(--card-shadow); }
.avatar { width: 64px; height: 64px; margin: 0 auto 12px; display: grid; place-items: center; border-radius: 50%; background: var(--accent); border: 1px solid var(--border-strong); font-size: 21px; font-weight: 700; }
.account-card h3 { margin: 0 0 4px; }
.account-card > p { margin: 0; display: flex; align-items: center; justify-content: center; gap: 4px; color: var(--muted); font-size: 13px; }
.sync-state { display: flex; align-items: center; gap: 8px; padding: 12px; margin: 16px 0 8px; border-radius: var(--radius-card); text-align: left; }
.sync-state > svg { color: var(--green); }
.sync-state.offline > svg { color: var(--coral); }
.sync-state b { display: block; font-size: 13px; }
.sync-state small { color: var(--muted); font-size: 13px; }
.signout-button { width: 100%; height: 40px; display: flex; align-items: center; justify-content: center; gap: 8px; border-radius: var(--radius-control); border: 1px solid var(--border); background: transparent; font-size: 13px; }

/* Utilities */
.loading-screen { min-height: 100vh; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--muted); }
.loading-screen > span { width: 52px; height: 52px; display: grid; place-items: center; border-radius: var(--radius-card); background: color-mix(in srgb, var(--accent) 10%, transparent); color: var(--accent); }
.loading-screen > svg { width: 17px; }
.loading-screen p { font-size: 13px; }
.toast { position: fixed; left: 50%; bottom: 28px; z-index: 100; transform: translateX(-50%); display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-radius: var(--radius-card); font-size: 13px; font-weight: 700; animation: toast-in var(--duration) var(--ease) both; }
@keyframes toast-in {
from { transform: translate(-50%, 8px); opacity: 0; } }
.sync-loader { position: fixed; right: 18px; top: 78px; z-index: 60; display: flex; align-items: center; gap: 4px; padding: 8px 8px; border-radius: var(--radius-card); background: var(--surface-solid); border: 1px solid var(--border); color: var(--muted); font-size: 13px; }
.mobile-nav { display: none; }

@media (max-width: 860px) {
.login-layout { grid-template-columns: 1fr; max-width: 520px; gap: 40px; }
.login-story { text-align: center; }
.login-story > p { margin-left: auto; margin-right: auto; }
.feature-row { justify-content: center; }
.login-story h1 { font-size: 48px; margin-top: 32px; }
.app-header { padding: 0 16px; }
.desktop-nav { display: none; }
.app-main { width: min(100% - 28px, 720px); }
.connection { display: none; }
.settings-layout { grid-template-columns: 1fr; }
.account-card { position: static; }
.charts-grid { grid-template-columns: 1fr; }
.summary-grid { grid-template-columns: 1.4fr 1fr; }
.trip-board-header { grid-template-columns: 1fr auto; }
.trip-board-header .back-button { grid-column: 1 / -1; }
.day-column { padding-left: 92px; }
.day-column > header { width: 76px; }
.plan-expanded { padding-left: 24px; }
}

@media (max-width: 620px) {
.login-shell { padding: 24px 16px; align-items: start; }
.login-layout { gap: 24px; }
.login-story h1 { font-size: 38px; margin: 24px 0 16px; }
.feature-row { margin-top: 24px; }
.feature-icon { width: 34px; height: 34px; }
.feature-row small { display: none; }
.login-card { border-radius: var(--radius-card); }
.app-header { height: 58px; padding: 0 12px; }
.app-brand b { font-size: 14px; }
.header-actions .icon-button { display: none; }
.app-main { width: calc(100% - 22px); padding: 12px 0 100px; }
.offline-banner { font-size: 13px; padding: 8px 12px; }
.current-trip { padding: 12px; border-radius: var(--radius-card); }
.current-trip p { display: none; }
.quick-collapsed { min-height: 82px; }
.quick-plus { width: 44px; height: 44px; }
.quick-types { display: none; }
.type-switch button { padding: 0 8px; }
.composer-main-input { height: 58px; }
.expense-fields { grid-template-columns: 1.1fr .9fr; }
.category-picker { grid-template-columns: repeat(3, 1fr); }
.composer-grid { grid-template-columns: 1fr; }
.composer-actions > span { max-width: 45%; }
.composer-modal { align-items: end; padding: 8px; }
.composer-modal-inner { border-radius: var(--radius-card); }
.filter-tabs { width: 100%; }
.filter-tabs button { padding: 0 8px; }
.filter-tabs button svg { display: none; }
.planner-link { display: none; }
.timeline-day { grid-template-columns: 1fr; gap: 8px; }
.day-label { position: static; padding-left: 4px; }
.day-label span { display: inline; margin-right: 4px; }
.day-label small { display: inline; margin-right: 4px; }
.day-records::before { display: none; }
.record-card::before { display: none; }
.record-card { min-height: 100px; }
.record-icon { width: 34px; height: 34px; }
.record-amount { position: absolute; right: 13px; top: 13px; }
.record-expense .record-main { padding-right: 70px; }
.record-actions { position: absolute; right: 12px; bottom: 12px; }
.done-stamp { position: absolute; right: 12px; bottom: 12px; }
.stats-toolbar { align-items: center; }
.summary-grid { grid-template-columns: 1fr; }
.insight-card { min-height: 100px; }
.pie-layout { flex-direction: column; }
.pie-chart { width: 100%; }
.chart-legend { width: 100%; grid-template-columns: repeat(2, 1fr); }
.section-hero { display: block; padding: 16px 4px 24px; }
.section-hero h1 { font-size: 28px; }
.section-hero .primary-button { margin-top: 16px; width: 100%; }
.trip-card { padding: 12px; }
.trip-card-icon { width: 42px; height: 42px; }
.trip-progress { display: none; }
.trip-board-header { padding: 4px 4px 24px; }
.trip-board-header h1 { font-size: 25px; }
.trip-completion { display: none; }
.day-column { padding-left: 0; padding-top: 45px; }
.day-column > header { width: 100%; }
.plan-list::before { display: none; }
.plan-summary { padding: 8px; }
.drag-handle { width: 22px; }
.plan-content > span em { display: none; }
.plan-expanded { padding: 12px; }
.plan-form > div { grid-template-columns: 100px 1fr; }
.settings-page .section-hero { padding-top: 8px; }
.theme-options { grid-template-columns: 1fr; }
.theme-options button { grid-template-columns: 30px 1fr 18px; }
.theme-options button span { grid-column: auto; }
.floating-add { display: none; }
.mobile-nav { position: fixed; z-index: 65; left: 10px; right: 10px; bottom: max(10px, env(safe-area-inset-bottom)); height: 64px; display: grid; grid-template-columns: repeat(5, 1fr); align-items: center; padding: 4px 8px; border-radius: var(--radius-card); background: color-mix(in srgb, var(--surface-solid) 90%, transparent); border: 1px solid var(--border-strong); box-shadow: var(--card-shadow); }
.mobile-nav button { height: 48px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; border: 0; background: transparent; color: var(--muted); font-size: 13px; }
.mobile-nav button svg { width: 19px; }
.mobile-nav button.active { color: var(--accent); }
.mobile-nav .mobile-add { width: 48px; height: 48px; justify-self: center; border-radius: var(--radius-card); color: var(--on-accent); background: var(--accent); box-shadow: var(--card-shadow); }
.mobile-nav .mobile-add svg { width: 24px; }
.toast { bottom: 84px; white-space: nowrap; }
.form-row { grid-template-columns: 1fr; }
}

/* Profiles, onboarding, and release notes */
.profile-avatar { display: inline-grid; place-items: center; flex: none; overflow: hidden; border-radius: 50%; color: var(--on-accent); background: var(--avatar-color, var(--accent)); font-variant-numeric: tabular-nums; font-weight: 700; }
.profile-avatar img { width: 100%; height: 100%; display: block; object-fit: cover; }
.profile-avatar.mini-avatar { width: 32px; height: 32px; font-size: 13px; }
.profile-avatar.avatar { width: 72px; height: 72px; margin: 0 auto 12px; font-size: 24px; }
.account-profile-button { width: 100%; padding: 0; border: 0; background: transparent; color: var(--text); }
.account-profile-button h3 { margin: 0 0 4px; font-size: 17px; }
.edit-profile-link { display: inline-flex; align-items: center; gap: 4px; color: var(--accent); font-size: 13px; font-weight: 600; }
.account-card > p { margin-top: 8px; }
.profile-editor { width: min(520px, 100%); }
.profile-preview { display: flex; align-items: center; gap: 16px; padding: 4px 0 16px; }
.profile-preview .profile-preview-avatar { width: 88px; height: 88px; margin: 0; font-size: 28px; }
.profile-preview .secondary-button { min-height: 40px; padding: 8px 16px; }
.avatar-color-field { padding: 0; margin: 4px 0 0; border: 0; }
.avatar-color-field legend { color: var(--text-soft); font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.avatar-color-field > div { display: flex; flex-wrap: wrap; gap: 8px; }
.avatar-color-field button { width: 38px; height: 38px; display: grid; place-items: center; padding: 0; border: 2px solid var(--surface); border-radius: 50%; color: var(--on-accent); box-shadow: 0 0 0 1px var(--border-strong); }
.avatar-color-field button.active { box-shadow: 0 0 0 2px var(--accent); }
.profile-hint { margin: 12px 0 0; color: var(--muted); font-size: 13px; }
.visually-hidden { position: absolute !important; width: 1px !important; height: 1px !important; padding: 0 !important; margin: -1px !important; overflow: hidden !important; clip: rect(0, 0, 0, 0) !important; white-space: nowrap !important; border: 0 !important; }
.guidance-backdrop { position: fixed; inset: 0; z-index: 95; display: grid; place-items: center; padding: 16px; background: var(--backdrop); }
.guidance-card { width: min(430px, 100%); border-radius: var(--radius-card); max-height: calc(100dvh - 48px); overflow-y: auto; padding: var(--space-5); }
.guidance-card > header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 32px; }
.guidance-card > header span { color: var(--muted); font-size: 13px; }
.guidance-card > header button { padding: 0; border: 0; background: transparent; color: var(--accent); font-size: 13px; }
.guidance-icon { display: flex; align-items: center; color: var(--muted); background: transparent; width: 24px; height: 24px; margin-bottom: var(--space-5); }
.guidance-icon svg { stroke-width: 1.7; width: 20px; height: 20px; }
.guidance-step { margin: 0 0 8px !important; color: var(--accent) !important; font-size: 13px !important; font-variant-numeric: tabular-nums; font-weight: 600; }
.guidance-card h2 { margin: 0 0 8px; letter-spacing: -.02em; font-size: 24px; line-height: 1.35; }
.guidance-card > p { margin: 0; color: var(--muted); font-size: 15px; line-height: 1.65; }
.guidance-dots { display: flex; gap: 4px; margin: 24px 0 16px; }
.guidance-dots span { width: 18px; height: 3px; border-radius: 3px; background: var(--border-strong); }
.guidance-dots span.active { background: var(--accent); }
.whats-new-card .guidance-icon { height: 54px; }
.whats-new-card .eyebrow { margin-bottom: 8px; }
.whats-new-card ul { display: grid; gap: 12px; margin: 24px 0; padding: 0; list-style: none; }
.whats-new-card li { display: grid; grid-template-columns: 20px 1fr; gap: 8px; align-items: start; color: var(--text-soft); font-size: 15px; line-height: 1.65; }
.whats-new-card li svg { margin-top: 4px; color: var(--green); }

@media (max-width: 620px) {
.profile-preview { align-items: flex-start; }
.guidance-backdrop { align-items: end; padding: 8px; }
.guidance-card { border-radius: var(--radius-card); }
}
body { font-family: var(--font-ui); font-size: 15px; line-height: 1.5; }
button { font-family: var(--font-ui); -webkit-tap-highlight-color: transparent; }
input { font-family: var(--font-ui); -webkit-tap-highlight-color: transparent; font-size: 16px; }
textarea { font-family: var(--font-ui); -webkit-tap-highlight-color: transparent; font-size: 16px; }
select { font-family: var(--font-ui); -webkit-tap-highlight-color: transparent; font-size: 16px; }
.glass-card { background: var(--surface); border: 1px solid var(--card-border); box-shadow: var(--card-shadow); min-width: 0; border-radius: var(--radius-card); }
.primary-button { min-height: 44px; border-radius: var(--radius-control); box-shadow: none; font-weight: 600; transition: background-color var(--duration) var(--ease), border-color var(--duration) var(--ease), color var(--duration) var(--ease), opacity var(--duration) var(--ease); color: var(--on-accent); background: var(--accent); filter: none; transform: none; font-size: 15px; padding: var(--space-3) var(--space-4); }
.primary-button:hover { color: var(--on-accent); background: var(--accent); box-shadow: none; filter: none; transform: none; }
.secondary-button { min-height: 44px; border-radius: var(--radius-control); box-shadow: none; font-weight: 600; transition: background-color var(--duration) var(--ease), border-color var(--duration) var(--ease), color var(--duration) var(--ease), opacity var(--duration) var(--ease); color: var(--accent); background: transparent; border: 1px solid var(--border-strong); font-size: 15px; padding: var(--space-3) var(--space-4); }
.app-shell { background: var(--bg); }
.login-shell { background: var(--bg); }
.login-layout { gap: 56px; min-width: 0; align-items: start; }
.section-hero h1 { font-size: 32px; letter-spacing: -.02em; font-weight: 700; line-height: 1.25; }
.login-story h1 { font-size: 32px; letter-spacing: -.02em; font-weight: 700; margin: 32px 0 16px; line-height: 1.25; }
.login-story h1 span { color: var(--accent); background: none; }
.login-story > p { color: var(--muted); font-weight: 400; font-size: 15px; }
.section-hero > div > p:last-child { color: var(--muted); font-weight: 400; font-size: 15px; }
.login-card-heading p { color: var(--muted); font-weight: 400; font-size: 14px; line-height: 1.6; }
.brand-mark svg { color: var(--accent); }
.feature-icon { width: auto; height: auto; padding: 0; border: 0; border-radius: 0; color: var(--muted) !important; background: transparent !important; }
.current-trip-icon { width: auto; height: auto; padding: 0; border: 0; border-radius: 0; color: var(--muted) !important; background: transparent !important; }
.record-icon { width: auto; height: auto; padding: 0; border: 0; border-radius: 0; color: var(--muted) !important; background: transparent !important; }
.trip-card-icon { width: auto; height: auto; padding: 0; border: 0; border-radius: 0; color: var(--muted) !important; background: transparent !important; }
.loading-screen > span { width: auto; height: auto; padding: 0; border: 0; border-radius: 0; color: var(--muted) !important; background: transparent !important; }
.feature-icon svg { width: 20px; height: 20px; stroke-width: 1.8; }
.mail-badge svg { width: 20px; height: 20px; stroke-width: 1.8; }
.current-trip-icon svg { width: 20px; height: 20px; stroke-width: 1.8; }
.record-icon svg { width: 20px; height: 20px; stroke-width: 1.8; }
.trip-card-icon svg { width: 20px; height: 20px; stroke-width: 1.8; }
.settings-icon svg { width: 20px; height: 20px; stroke-width: 1.8; }
.composer { box-shadow: var(--card-shadow); border-radius: var(--radius-card); padding: var(--space-4); }
.total-card { border-radius: var(--radius-card); box-shadow: var(--card-shadow); }
.insight-card { border-radius: var(--radius-card); box-shadow: var(--card-shadow); }
.chart-card { border-radius: var(--radius-card); box-shadow: var(--card-shadow); }
.chart-loading { border-radius: var(--radius-card); box-shadow: var(--card-shadow); }
.empty-planner { border-radius: var(--radius-card); box-shadow: var(--card-shadow); }
.modal-card { border-radius: var(--radius-card); box-shadow: var(--card-shadow); max-height: calc(100dvh - 48px); overflow-y: auto; padding: var(--space-5); }
.empty-timeline { border-radius: var(--radius-card); box-shadow: var(--card-shadow); }
.login-card { border-radius: var(--radius-card); box-shadow: var(--card-shadow); padding: var(--space-5); }
.mail-badge { width: auto; height: auto; padding: 0; border: 0; border-radius: 0; color: var(--muted); background: transparent !important; }
.email-field { background: var(--field-bg); border-color: var(--border-strong); border-radius: var(--radius-control); }
.amount-box { background: var(--field-bg); border-color: var(--border-strong); border-radius: var(--radius-control); padding-top: 24px; padding-bottom: 8px; height: 76px; }
.select-field { background: var(--field-bg); border-color: var(--border-strong); border-radius: var(--radius-control); padding-top: 8px; }
.soft-field { background: var(--field-bg); border-color: var(--border-strong); border-radius: var(--radius-control); height: 48px; }
.composer textarea { background: var(--field-bg); border-color: var(--border-strong); border-radius: var(--radius-control); font-size: 15px; }
.modal-card input { background: var(--field-bg); border-color: var(--border-strong); border-radius: var(--radius-control); }
.privacy-note { color: var(--text-soft); font-size: 15px; line-height: 1.55; }
.privacy-note svg { color: var(--green); }
.success-ring { color: var(--green); background: transparent; border-color: var(--green); }
.app-header { background: var(--surface-solid); border-bottom-color: var(--border); }
.app-brand > span { width: auto; height: auto; border-radius: 0; color: var(--accent); background: transparent; box-shadow: none; }
.desktop-nav button.active { color: var(--accent); }
.desktop-nav button.active::after { left: 12px; right: 12px; background: var(--accent); }
.icon-button:hover { color: var(--accent); background: transparent; border-color: transparent; }
.icon-button.active { color: var(--accent); background: transparent; border-color: transparent; }
.mini-avatar { background: var(--accent); border: 0; color: var(--on-accent); box-shadow: none; }
.avatar { background: var(--accent); border: 0; color: var(--on-accent); box-shadow: none; }
.connection.offline svg { color: var(--warning); }
.sync-state.offline > svg { color: var(--warning); }
.offline-banner { color: var(--warning); background: color-mix(in srgb, var(--warning) 10%, var(--bg)); border-bottom-color: color-mix(in srgb, var(--warning) 24%, transparent); }
.setup-banner { background: var(--surface); color: var(--text-soft); }
.setup-banner b { color: var(--warning); }
.current-trip { border-radius: var(--radius-card); box-shadow: var(--card-shadow); transition: background-color var(--duration) var(--ease), border-color var(--duration) var(--ease), color var(--duration) var(--ease), opacity var(--duration) var(--ease); }
.quick-collapsed { box-shadow: var(--card-shadow); transition: background-color var(--duration) var(--ease), border-color var(--duration) var(--ease), color var(--duration) var(--ease), opacity var(--duration) var(--ease); border-radius: var(--radius-card); padding: var(--space-4); }
.current-trip:hover { transform: none; border-color: var(--border-strong); }
.quick-collapsed:hover { transform: none; border-color: var(--border-strong); }
.trip-card:hover { transform: none; border-color: var(--border-strong); }
.current-trip small { color: var(--accent); }
.trip-card p { color: var(--muted); }
.record-details .status.planned { color: var(--accent); }
.quick-plus { width: 40px; height: 40px; color: var(--accent); background: transparent; border-radius: 0; }
.quick-types svg { width: 20px; height: 20px; padding: 0; border-radius: 0; color: var(--muted); background: transparent; }
.type-switch { padding: 0; background: transparent; border: 0; border-radius: 0; gap: var(--space-4); }
.type-switch button { position: relative; padding: 0 4px; border-radius: 0; min-height: 44px; font-size: 15px; }
.type-switch button.active { color: var(--accent); background: transparent; }
.type-switch button.active::after { content: ""; position: absolute; left: 2px; right: 2px; bottom: -1px; height: 2px; background: var(--accent); }
.type-switch button.active.expense svg { color: var(--accent); }
.type-switch button.active.trip svg { color: var(--accent); }
.type-switch button.active.note svg { color: var(--accent); }
.amount-box > span { color: var(--accent); }
.amount-box input { font-variant-numeric: tabular-nums; font-weight: 600; }
.record-amount { font-variant-numeric: tabular-nums; font-weight: 600; font-size: 18px; white-space: nowrap; }
.insight-card > strong { font-variant-numeric: tabular-nums; font-weight: 600; }
.trip-progress b { font-variant-numeric: tabular-nums; font-weight: 600; }
.trip-completion b { font-variant-numeric: tabular-nums; font-weight: 600; }
.plan-time { color: var(--accent); font-weight: 600; font-variant-numeric: tabular-nums; }
.actual-row strong { font-variant-numeric: tabular-nums; font-weight: 600; }
.category-picker button:hover { color: var(--accent); background: transparent; border-color: var(--accent); }
.category-picker button.active { color: var(--accent); background: transparent; border-color: var(--accent); }
.floating-add { color: var(--on-accent); background: var(--accent); border-radius: var(--radius-card); box-shadow: none; }
.mobile-nav .mobile-add { color: var(--on-accent); background: var(--accent); border-radius: var(--radius-card); box-shadow: none; }
.floating-add:hover { transform: none; }
.filter-row { margin: var(--space-5) 0 var(--space-4); }
.filter-tabs { gap: var(--space-5); }
.filter-tabs button { position: relative; padding: 0 4px; border: 0; border-radius: 0; min-height: 44px; font-size: 15px; }
.filter-tabs button span { color: var(--muted); background: transparent; padding: 0; }
.filter-tabs button.active { color: var(--accent); background: transparent; border: 0; }
.filter-tabs button.active::after { content: ""; position: absolute; left: 2px; right: 2px; bottom: 0; height: 2px; background: var(--accent); }
.planner-link { color: var(--accent); }
.planner-link svg:first-child { color: var(--accent); }
.timeline { gap: 16px; }
.day-records { gap: 12px; min-width: 0; }
.day-records::before { background: var(--border); }
.record-card { border-radius: var(--radius-card); box-shadow: var(--card-shadow); transition: background-color var(--duration) var(--ease), border-color var(--duration) var(--ease), color var(--duration) var(--ease), opacity var(--duration) var(--ease); padding: var(--space-4); gap: var(--space-3); }
.record-card::before { border-color: var(--accent); }
.record-card.record-expense::before { border-color: var(--accent); }
.record-card.record-trip::before { border-color: var(--accent); }
.record-card.record-note::before { border-color: var(--accent); }
.record-expense .record-icon { color: var(--muted); background: transparent; }
.record-trip .record-icon { color: var(--muted); background: transparent; }
.record-note .record-icon { color: var(--muted); background: transparent; }
.record-details .status.completed { color: var(--green); }
.record-details .status.cancelled { color: var(--warning); }
.done-stamp { color: var(--green); background: transparent; white-space: nowrap; }
.empty-timeline > span { width: auto; height: auto; padding: 0; border: 0; border-radius: 0; color: var(--muted); background: transparent !important; }
.empty-planner > span { width: auto; height: auto; padding: 0; border: 0; border-radius: 0; color: var(--muted); background: transparent !important; }
.total-card::after { display: none; }
.summary-icon { color: var(--muted); }
.insight-card svg { color: var(--muted); }
.total-card > strong { font-variant-numeric: tabular-nums; font-weight: 600; color: var(--accent); }
.total-card > small { color: var(--warning); }
.range-switch { background: transparent; }
.range-switch button.active { color: var(--accent); background: transparent; border-radius: 0; border-bottom: 2px solid var(--accent); }
.chart-legend i { border-radius: var(--radius-card); }
.trip-grid { gap: 12px; }
.settings-main { gap: 12px; min-width: 0; }
.trip-card { border-radius: var(--radius-card); box-shadow: var(--card-shadow); transition: background-color var(--duration) var(--ease), border-color var(--duration) var(--ease), color var(--duration) var(--ease), opacity var(--duration) var(--ease); grid-template-columns: 24px minmax(0, 1fr) auto 20px; }
.day-column.drag-over { background: color-mix(in srgb, var(--accent) 7%, transparent); }
.plan-item { border-radius: var(--radius-card); box-shadow: var(--card-shadow); }
.plan-item.dragging { box-shadow: var(--card-shadow); }
.plan-item.completed .plan-check { background: transparent; border-color: var(--green); }
.actual-row.expense > span { color: var(--muted); background: transparent; border: 1px solid var(--border); }
.actual-row.note > span { color: var(--muted); background: transparent; border: 1px solid var(--border); }
.plan-form { border-color: var(--accent); background: transparent; }
.plan-status-actions button.active { color: var(--accent); background: transparent; border-color: var(--accent); }
.settings-card { border-radius: var(--radius-card); box-shadow: var(--card-shadow); padding: var(--space-5); }
.account-card { border-radius: var(--radius-card); box-shadow: var(--card-shadow); padding: var(--space-5); }
.settings-icon { width: auto; height: auto; padding: 0; border: 0; border-radius: 0; color: var(--muted); background: transparent; margin-right: 0; }
.currency-grid button { background: var(--surface); border-color: var(--border-strong); grid-template-columns: 40px minmax(0, 1fr); min-height: 76px; padding: var(--space-3); }
.currency-grid button.active { background: var(--surface); border: 1.5px solid var(--accent); }
.currency-grid button > span { color: var(--muted); font-size: 16px; }
.currency-grid button > svg { color: var(--accent); position: absolute; top: 6px; right: 6px; width: 13px; height: 13px; }
.theme-options button.active { color: var(--accent); background: transparent; border-color: var(--accent); }
.theme-options button.active > svg:first-child { color: var(--accent); }
.sync-state { background: transparent; border: 1px solid var(--border); }
.signout-button { border-color: var(--border-strong); color: var(--muted); }
.signout-button:hover { color: var(--warning); border-color: var(--warning); }
.app-footer { position: absolute; left: 24px; right: 24px; bottom: 18px; color: var(--muted); font-size: 13px; text-align: center; }
.settings-footer { position: static; display: flex; justify-content: center; gap: 12px; flex-wrap: wrap; margin: 24px 0 0; }
.settings-footer span + span::before { content: "·"; margin-right: 12px; }
.toast { border: 1px solid var(--border); box-shadow: var(--card-shadow); max-width: calc(100vw - 32px); width: max-content; color: var(--toast-text); background: var(--toast-bg); }
.loading-screen { background: var(--bg); }
.release-history-modal { width: min(620px, 100%); max-height: min(820px, 90vh); display: flex; flex-direction: column; overflow: hidden; }
.release-history-modal > header { flex: none; }
.release-history-modal > header h2 { margin-bottom: 4px; }
.release-history-modal > header p:last-child { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
.release-history-list { display: grid; gap: 12px; overflow-y: auto; padding-right: 4px; overscroll-behavior: contain; min-height: 0; }
.release-entry { padding: 16px; border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--bg); }
.release-entry-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.release-entry-heading strong { display: block; font-size: 16px; letter-spacing: -.01em; }
.release-entry-heading time { display: block; margin-top: 4px; color: var(--muted); font-size: 13px; }
.release-entry-heading > span { flex: none; padding: 4px 8px; font-size: 13px; font-weight: 700; border-radius: var(--radius-badge); color: var(--text-soft); background: var(--surface-hover); }
.release-entry ul { display: grid; gap: 8px; margin: 16px 0 0; padding: 16px 0 0; border-top: 1px solid var(--border); list-style: none; }
.release-entry li { display: flex; align-items: flex-start; gap: 8px; color: var(--text-soft); font-size: 14px; line-height: 1.55; }
.release-entry li svg { flex: none; margin-top: 4px; color: var(--accent); }
.release-history-empty { margin: 12px 0; color: var(--muted); text-align: center; font-size: 14px; }
.release-history-modal > footer { flex: none; }
.usage-guide-modal { width: min(620px, 100%); max-height: min(820px, 90vh); display: flex; flex-direction: column; overflow: hidden; }
.usage-guide-modal > header { flex: none; }
.usage-guide-modal > header h2 { margin-bottom: 4px; }
.usage-guide-modal > header p:last-child { margin: 0; color: var(--muted); font-size: 14px; line-height: 1.5; }
.usage-guide-list { display: grid; gap: 12px; overflow-y: auto; padding-right: 4px; overscroll-behavior: contain; min-height: 0; }
.usage-guide-list article { display: grid; grid-template-columns: 40px 1fr; gap: 12px; padding: 16px; border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--surface-soft); }
.usage-guide-list h3 { margin: 4px 0 4px; font-size: 18px; }
.usage-guide-list p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.7; }
.usage-guide-list .settings-icon { width: 36px; height: 36px; }
.usage-guide-modal > footer { flex: none; }

@media (max-width: 620px) {
.login-shell { padding-bottom: 76px; }
.login-story h1 { font-size: 32px; }
.section-hero h1 { font-size: 32px; }
.login-card { border-radius: var(--radius-card); }
.feature-row { justify-content: space-between; }
.quick-collapsed { min-height: 76px; }
.quick-plus { width: 28px; height: 28px; }
.record-icon { width: 22px; height: 28px; }
.mobile-nav { border-radius: var(--radius-card); background: var(--surface-solid); box-shadow: var(--card-shadow); }
.mobile-nav button.active { color: var(--accent); }
.mobile-nav .mobile-add { border-radius: var(--radius-card); }
.settings-footer { flex-direction: column; gap: 4px; }
.settings-footer span + span::before { display: none; }
.release-history-modal { max-height: calc(100vh - 20px); padding: 16px; }
.usage-guide-modal { max-height: calc(100vh - 20px); padding: 16px; }
.release-entry { padding: 16px; }
}
.profile-avatar.mini-avatar { background: var(--avatar-color, var(--accent)); }
.profile-avatar.avatar { background: var(--avatar-color, var(--accent)); }
.profile-avatar.profile-preview-avatar { background: var(--avatar-color, var(--accent)); }
.brand-logo { display: block; flex: none; object-fit: cover; user-select: none; -webkit-user-drag: none; }
.header-brand-logo { width: 30px; height: 30px; border-radius: var(--radius-card); }
.login-brand-logo { width: 28px; height: 28px; border-radius: var(--radius-card); }
.loading-brand-logo { width: 56px; height: 56px; border-radius: var(--radius-card); box-shadow: var(--card-shadow); }
.transport-plan-form { position: relative; margin-bottom: 8px; padding: 16px; border: 1px solid var(--border-strong); border-radius: var(--radius-card); background: var(--surface-solid); box-shadow: var(--card-shadow); }
.transport-plan-form.transport-editor-modal { width: min(760px, 100%); max-height: min(900px, calc(100dvh - 32px)); overflow-y: auto; }
.plan-type-switch { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-bottom: 16px; }
.plan-type-switch button { min-height: 44px; display: flex; align-items: center; justify-content: center; gap: 8px; padding: 8px; border: 0; border-bottom: 2px solid transparent; border-radius: 0; background: transparent; color: var(--muted); font-size: 15px; font-weight: 600; }
.plan-type-switch button.active { color: var(--accent); border-bottom-color: var(--accent); background: transparent; }
.transport-fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
.transport-fields > label { min-width: 0; display: flex; flex-direction: column; gap: 8px; color: var(--text-soft); font-size: 13px; font-weight: 700; }
.transport-stop label { min-width: 0; display: flex; flex-direction: column; gap: 8px; color: var(--text-soft); font-size: 13px; font-weight: 700; }
.gate-editor label { min-width: 0; display: flex; flex-direction: column; gap: 8px; color: var(--text-soft); font-size: 13px; font-weight: 700; }
.transport-fields input { width: 100%; min-width: 0; border: 1px solid var(--border-strong); border-radius: var(--radius-control); color: var(--text); outline: 0; padding: 0 12px; height: 48px; background: var(--field-bg); }
.transport-fields select { width: 100%; min-width: 0; border: 1px solid var(--border-strong); border-radius: var(--radius-control); color: var(--text); outline: 0; padding: 0 12px; height: 48px; background: var(--field-bg); }
.gate-editor input { width: 100%; min-width: 0; border: 1px solid var(--border-strong); border-radius: var(--radius-control); color: var(--text); outline: 0; padding: 0 12px; height: 48px; background: var(--field-bg); }
.transport-fields textarea { width: 100%; min-width: 0; border: 1px solid var(--border-strong); border-radius: var(--radius-control); color: var(--text); outline: 0; resize: vertical; padding: 8px 12px; line-height: 1.55; background: var(--field-bg); font-size: 16px; }
.transport-fields input:focus { border-color: var(--accent); }
.transport-fields select:focus { border-color: var(--accent); }
.transport-fields textarea:focus { border-color: var(--accent); }
.transit-ai-modal textarea:focus { border-color: var(--accent); }
.gate-editor input:focus { border-color: var(--accent); }
.transport-fields .field-span-2 { grid-column: 1 / -1; }
.field-hint { margin-left: 4px; color: var(--muted); font-size: 13px; font-weight: 500; }
.field-help { display: block; margin-top: 4px; color: var(--muted); font-size: 13px; font-weight: 500; line-height: 1.45; }
.trip-form select { width: 100%; height: 45px; display: block; margin-top: 8px; padding: 0 12px; border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--field-bg); color: var(--text); outline: 0; }
.trip-form select:focus { border-color: var(--accent); }
.transport-stop { grid-column: 1 / -1; margin: 0; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-control); background: var(--surface-soft); }
.transport-stop legend { padding: 0 8px; color: var(--accent); font-size: 13px; font-weight: 700; }
.transport-stop > div { display: grid; gap: 8px; grid-template-columns: minmax(0, 1fr) minmax(0, .8fr) minmax(0, 1.4fr) minmax(0, .7fr); }
.transport-stop > div > .flight-timezone-field { grid-column: 1 / -1; }
.transport-stop > .rail-stop-grid { grid-template-columns: minmax(0, 1fr) minmax(0, .8fr) minmax(0, 1.6fr); }
.flight-lookup-action { display: grid; grid-template-columns: auto 1fr; gap: 8px 12px; align-items: center; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--surface-hover); }
.flight-lookup-action .secondary-button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; }
.flight-lookup-action > span { color: var(--muted); font-size: 13px; line-height: 1.45; }
.flight-lookup-action .field-error { grid-column: 1 / -1; margin: 0; }
.route-description-field > span { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.ai-route-button { display: inline-flex; align-items: center; gap: 4px; padding: 0 8px; border: 1px solid color-mix(in srgb, var(--accent) 42%, var(--border)); border-radius: var(--radius-control); background: transparent; color: var(--accent); font-size: 13px; font-weight: 700; min-height: 44px; }
.transport-form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
.nested-modal-backdrop { position: fixed; inset: 0; z-index: 110; display: grid; place-items: center; padding: 16px; background: var(--backdrop); }
.transit-ai-modal { width: min(560px, 100%); }
.transit-ai-modal > label { min-width: 0; display: flex; flex-direction: column; gap: 8px; color: var(--text-soft); font-size: 13px; font-weight: 700; margin-bottom: 12px; }
.transit-ai-modal textarea { width: 100%; min-width: 0; border: 1px solid var(--border-strong); border-radius: var(--radius-control); color: var(--text); outline: 0; resize: vertical; padding: 8px 12px; line-height: 1.55; margin-top: 8px; background: var(--field-bg); font-size: 16px; }
.ai-query-submit { width: 100%; margin: 4px 0 12px; }
.ai-disclaimer { margin: -2px 0 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
.flight-lookup-modal { width: min(680px, 100%); max-height: min(840px, calc(100dvh - 32px)); overflow-y: auto; }
.flight-lookup-intro { margin: 0 0 12px; color: var(--muted); font-size: 13px; line-height: 1.6; }
.flight-candidate-list { display: grid; gap: 8px; }
.flight-candidate-list article { padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--bg); }
.flight-candidate-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.flight-candidate-heading > div { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.flight-candidate-heading strong { font-size: 16px; }
.flight-candidate-heading span { color: var(--accent); font-size: 14px; font-weight: 700; }
.flight-candidate-heading em { padding: 4px 8px; border-radius: var(--radius-badge); background: var(--surface-hover); color: var(--muted); font-size: 13px; font-style: normal; }
.flight-candidate-route { display: grid; gap: 8px; align-items: center; grid-template-columns: minmax(0, 1fr) 20px minmax(0, 1fr); }
.flight-candidate-route > svg { justify-self: center; color: var(--muted); }
.flight-candidate-route > div:last-child { text-align: right; }
.flight-candidate-route small { display: block; color: var(--muted); font-size: 13px; font-style: normal; }
.flight-candidate-route span { display: block; color: var(--muted); font-size: 13px; font-style: normal; }
.flight-candidate-route i { display: block; color: var(--muted); font-size: 13px; font-style: normal; overflow-wrap: anywhere; }
.flight-candidate-route b { display: block; margin: 4px 0; font-size: 15px; overflow-wrap: anywhere; }
.flight-candidate-list article > button { width: 100%; margin-top: 12px; }
.flight-lookup-modal > footer { justify-content: flex-end; }
.transport-details-panel { margin-bottom: 16px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--bg); }
.transport-details-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.transport-details-heading span { display: block; color: var(--accent); font-size: 13px; font-weight: 700; }
.transport-details-heading strong { display: block; margin-top: 4px; font-size: 16px; }
.edit-plan-button { flex: none; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--radius-control); background: transparent; color: var(--text-soft); font-size: 13px; font-weight: 700; min-height: 44px; }
.transport-route-grid { display: grid; gap: 8px; align-items: center; grid-template-columns: minmax(0, 1fr) 20px minmax(0, 1fr); }
.transport-route-grid > svg { justify-self: center; color: var(--muted); }
.transport-route-grid > div:last-child { text-align: right; }
.transport-route-grid small { display: block; color: var(--muted); font-size: 13px; }
.transport-route-grid b { display: block; margin: 4px 0; font-size: 15px; overflow-wrap: anywhere; }
.transport-route-grid span { color: var(--muted); font-size: 13px; }
.transport-route-grid i { display: block; margin-top: 4px; color: var(--muted); font-size: 13px; font-style: normal; overflow-wrap: anywhere; }
.transport-facts { display: flex; flex-wrap: wrap; gap: 8px 12px; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); color: var(--muted); font-size: 13px; }
.transport-facts b { color: var(--text-soft); }
.gate-editor { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: end; margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border); }
.gate-editor .secondary-button { min-height: 43px; }
.route-description-preview { display: flex; align-items: flex-start; gap: 8px; margin-top: 12px; padding: 12px; border-radius: var(--radius-control); background: var(--surface-hover); color: var(--text-soft); }
.route-description-preview svg { flex: none; margin-top: 4px; color: var(--accent); }
.route-description-preview p { margin: 0; font-size: 13px; line-height: 1.6; white-space: pre-wrap; }
.actual-actions { display: flex; flex-wrap: wrap; gap: 12px; }
.route-actual { color: var(--violet); }
.credits-card > header { margin-bottom: 8px; }
.credits-card > p { margin: 0; color: var(--text-soft); line-height: 1.7; font-size: 15px; overflow-wrap: anywhere; }
.optional-tag { display: inline-flex; margin-left: 4px; padding: 4px 4px; color: var(--muted); background: var(--surface-hover); font-size: 13px; font-weight: 600; vertical-align: middle; border-radius: var(--radius-badge); }
.flight-planning-note { display: flex; align-items: flex-start; gap: 8px; padding: 12px; border: 1px solid color-mix(in srgb, var(--accent) 25%, var(--border)); border-radius: var(--radius-card); background: transparent; color: var(--accent); }
.flight-planning-note svg { flex: none; margin-top: 4px; }
.flight-planning-note p { margin: 0; }
.flight-planning-note b { display: block; color: var(--text); font-size: 13px; }
.flight-planning-note span { display: block; margin-top: 4px; color: var(--muted); font-size: 13px; line-height: 1.55; }
.flight-duration-summary { display: flex; align-items: flex-start; gap: 8px; margin-top: 12px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-card); }
.transport-fields > .flight-duration-summary { margin-top: 0; }
.flight-duration-summary > svg { flex: none; margin-top: 4px; color: var(--accent); }
.flight-duration-summary > div { min-width: 0; }
.flight-duration-summary b { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 12px; color: var(--text); font-size: 14px; }
.flight-duration-summary strong { color: var(--accent); font-size: 16px; font-variant-numeric: tabular-nums; }
.flight-duration-summary p { margin: 4px 0 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
.flight-duration-summary.invalid p { color: var(--warning); }
.airport-autocomplete { position: relative; z-index: 4; }
.airport-options { position: absolute; z-index: 20; top: calc(100% + 5px); left: 0; right: 0; max-height: 260px; overflow-y: auto; padding: 4px; border: 1px solid var(--border-strong); border-radius: var(--radius-card); background: var(--surface-solid); box-shadow: var(--card-shadow); }
.airport-options button { width: 100%; display: grid; grid-template-columns: 42px 1fr; gap: 8px; padding: 8px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--text); text-align: left; }
.airport-options button:hover { background: var(--surface-hover); }
.airport-options button > b { color: var(--accent); font-size: 13px; }
.airport-options button > span { min-width: 0; font-size: 13px; font-weight: 600; }
.airport-options small { display: block; margin-top: 4px; overflow: hidden; color: var(--muted); font-size: 13px; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }
.aircraft-autocomplete { position: relative; z-index: 3; }
.aircraft-options { position: absolute; z-index: 20; top: calc(100% + 5px); left: 0; right: 0; max-height: 230px; overflow-y: auto; padding: 4px; border: 1px solid var(--border-strong); border-radius: var(--radius-card); background: var(--surface-solid); box-shadow: var(--card-shadow); }
.aircraft-options button { width: 100%; display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--text); text-align: left; }
.aircraft-options button:hover { background: var(--surface-hover); }
.aircraft-options b { color: var(--accent); font-size: 13px; }
.aircraft-options small { overflow: hidden; color: var(--muted); font-size: 13px; text-overflow: ellipsis; white-space: nowrap; }
.flight-match-card { display: grid; gap: 8px; margin-top: 12px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--surface-soft); }
.flight-match-card > div > b { font-size: 16px; }
.flight-match-card p { margin: 4px 0 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
.flight-match-card small { color: var(--muted); font-size: 13px; line-height: 1.5; }
.flight-match-card .secondary-button { justify-self: start; display: inline-flex; align-items: center; gap: 4px; }
.match-success { display: flex; align-items: center; gap: 8px; color: var(--green); }
.match-success span { display: block; }
.match-success small { display: block; }
.match-success b { display: block; color: var(--text); font-size: 13px; }
.actual-flight-summary { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.actual-flight-summary span { display: flex; justify-content: space-between; gap: 8px; padding: 8px 8px; border-radius: var(--radius-card); background: var(--bg); color: var(--muted); font-size: 13px; }
.actual-flight-summary b { color: var(--text-soft); text-align: right; font-variant-numeric: tabular-nums; }
.flight-compare-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.flight-compare-grid article { display: grid; gap: 8px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--bg); }
.flight-compare-grid article > b { color: var(--accent); font-size: 13px; }
.flight-compare-grid span { color: var(--text-soft); font-size: 13px; overflow-wrap: anywhere; }
.trip-edit-link { display: inline-flex; align-items: center; gap: 4px; margin-top: 8px; padding: 0; border: 0; background: transparent; color: var(--accent); font-size: 13px; font-weight: 700; }
.trip-recap-card { display: grid; gap: 12px; margin-bottom: 16px; padding: 16px; }
.trip-recap-card > div { display: flex; align-items: center; gap: 8px; color: var(--accent); }
.trip-recap-card > div span { display: block; }
.trip-recap-card > div b { display: block; color: var(--text); font-size: 13px; }
.trip-recap-card > div small { display: block; margin-top: 4px; color: var(--muted); font-size: 13px; }
.trip-recap-card > p { margin: 0; color: var(--text-soft); line-height: 1.8; white-space: pre-wrap; font-size: 15px; overflow-wrap: anywhere; }
.trip-recap-card .secondary-button { justify-self: start; display: inline-flex; align-items: center; gap: 4px; }
.trip-range-warning { margin-bottom: 16px; padding: 12px 16px; border: 1px solid color-mix(in srgb, var(--warning) 45%, var(--border)); border-radius: var(--radius-card); background: color-mix(in srgb, var(--warning) 6%, transparent); }
.trip-range-warning b { color: var(--warning); font-size: 13px; }
.trip-range-warning p { margin: 4px 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
.trip-range-warning ul { margin: 8px 0 0; padding-left: 16px; color: var(--text-soft); font-size: 13px; line-height: 1.7; }
.trip-range-warning li { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.record-controls { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.record-controls .done-stamp { position: static; }
.record-control-buttons { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
.record-control-button { display: inline-flex; align-items: center; justify-content: center; gap: 4px; min-height: 44px; padding: 8px 12px; border: 1px solid var(--border); border-radius: var(--radius-control); background: transparent; color: var(--text-soft); font-size: 13px; white-space: nowrap; }
.record-control-button:hover { color: var(--accent); border-color: var(--accent); }
.airline-autocomplete { position: relative; }
.airline-options { position: absolute; top: 100%; left: 0; right: 0; z-index: 10; max-height: 280px; overflow-y: auto; background: var(--surface-solid); border: 1px solid var(--border-strong); border-radius: var(--radius-control); }
.airline-options button { width: 100%; min-height: 52px; display: flex; align-items: center; gap: 12px; padding: 8px 12px; text-align: left; background: transparent; border: 0; color: var(--text); }
.airline-options button:hover, .airline-options button[aria-selected="true"] { background: var(--surface-hover); }
.airline-options b { color: var(--accent); font-size: 14px; flex: none; min-width: 24px; }
.airline-options span { min-width: 0; font-size: 14px; overflow-wrap: anywhere; }
.airline-options small { display: block; color: var(--muted); font-size: 13px; }
.flight-number-input { display: flex; align-items: center; margin-top: 4px; border: 1px solid var(--border-strong); border-radius: var(--radius-control); background: var(--surface); overflow: hidden; }
.flight-number-input:focus-within { border-color: var(--accent); }
.flight-number-input > span { flex: none; padding: 0 12px; color: var(--accent); font-size: 15px; font-weight: 600; }
.transport-fields .flight-number-input input { flex: 1; min-width: 0; width: 100%; margin: 0; border: 0; background: transparent; }
.composer-ai-input { display: flex; align-items: center; gap: 8px; }
.composer-ai-input .composer-main-input { min-width: 0; flex: 1; }
.ai-inline-button { flex: none; display: inline-flex; align-items: center; gap: 4px; padding: 0 8px; border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border)); border-radius: var(--radius-control); background: transparent; color: var(--accent); font-size: 13px; font-weight: 700; min-height: 44px; }
.composer-ai-error { margin: -5px 0 8px; }
.ai-preview-modal { width: min(560px, 100%); }
.ai-preview-fields { display: grid; gap: 8px; grid-template-columns: repeat(2, minmax(0, 1fr)); }
.ai-preview-fields span { display: flex; justify-content: space-between; gap: 8px; padding: 8px; border-radius: var(--radius-control); background: var(--surface-hover); color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.ai-preview-fields span:last-child { grid-column: 1 / -1; }
.ai-preview-fields b { color: var(--text); text-align: right; }
.note-compare { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.note-compare article { padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--bg); }
.note-compare b { color: var(--accent); font-size: 13px; }
.note-compare p { margin: 8px 0 0; color: var(--text-soft); font-size: 13px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
.login-limits { display: flex; align-items: flex-start; gap: 8px; margin-top: 12px; padding: 8px; border-radius: var(--radius-card); background: var(--surface-hover); color: var(--accent); }
.login-limits svg { flex: none; margin-top: 4px; }
.login-limits p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.6; }
.demo-entry { display: grid; gap: 8px; margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--border); text-align: center; }
.demo-entry > span { color: var(--muted); font-size: 13px; line-height: 1.5; }
.demo-entry small { color: var(--muted); font-size: 13px; line-height: 1.5; }
.demo-entry .secondary-button { display: flex; align-items: center; justify-content: center; gap: 8px; }
.daily-summary { display: flex; align-items: flex-start; gap: 8px; margin: 0 12px 12px 58px; padding: 8px; border-radius: var(--radius-card); background: var(--surface-hover); color: var(--accent); }
.daily-summary svg { flex: none; margin-top: 4px; }
.daily-summary p { margin: 0; color: var(--text-soft); font-size: 13px; line-height: 1.65; }
.smart-service-card > header { margin-bottom: 12px; }
.tier-heading { display: flex; justify-content: space-between; padding: 12px; border-radius: var(--radius-card); background: var(--surface-hover); align-items: flex-start; gap: var(--space-3); }
.tier-heading > span { padding: 4px 8px; font-size: 13px; font-weight: 700; border-radius: var(--radius-badge); background: var(--surface-hover); color: var(--text-soft); }
.tier-heading small { max-width: 70%; color: var(--muted); font-size: 13px; line-height: 1.5; text-align: right; }
.quota-overview { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 8px; }
.quota-overview > div { display: grid; border: 1px solid var(--border); border-radius: var(--radius-card); gap: var(--space-3); padding: var(--space-4); }
.quota-overview > div > b { color: var(--text-soft); font-size: 13px; }
.quota-overview span { display: flex; justify-content: space-between; color: var(--text); font-size: 13px; font-weight: 700; font-variant-numeric: tabular-nums; flex-wrap: wrap; gap: var(--space-2); }
.quota-overview span small { color: var(--muted); font-size: 13px; font-weight: 500; }
.quota-overview p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
.quota-cooldown { grid-column: 1 / -1; color: var(--warning) !important; }
.owner-quota-overview > div { align-content: start; }
.owner-quota-overview > div > p { padding-top: 4px; }
.owner-admin-card { padding-top: 4px; padding-bottom: 4px; }
.owner-admin-card .settings-row { border-bottom: 0; }
.privacy-modal { width: min(540px, 100%); }
.privacy-copy { display: grid; gap: 12px; }
.privacy-copy p { margin: 0; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--surface-hover); color: var(--text-soft); line-height: 1.75; font-size: 15px; overflow-wrap: anywhere; }
.owner-admin-modal { width: min(760px, 100%); max-height: min(860px, calc(100dvh - 32px)); display: flex; flex-direction: column; overflow: hidden; }
.owner-admin-modal > header { flex: none; }
.owner-admin-modal > header p:last-child { margin: 4px 0 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
.owner-user-search { flex: none; display: grid; grid-template-columns: 1fr auto; gap: 8px; }
.owner-user-search label { min-width: 0; height: 44px; display: flex; align-items: center; gap: 8px; padding: 0 12px; border: 1px solid var(--border); border-radius: var(--radius-card); color: var(--muted); background: var(--surface-soft); }
.owner-user-search input { min-width: 0; width: 100%; height: auto; margin: 0; padding: 0; border: 0; border-radius: 0; background: transparent; color: var(--text); }
.owner-user-list { display: grid; gap: 8px; margin-top: 12px; padding-right: 4px; overflow-y: auto; overscroll-behavior: contain; min-height: 0; }
.owner-admin-state { min-height: 110px; display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--muted); font-size: 13px; }
.owner-user-card { display: grid; gap: 12px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--surface-soft); }
.owner-user-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.owner-user-heading strong { display: block; overflow-wrap: anywhere; color: var(--text); font-size: 13px; }
.owner-user-heading span { display: block; margin-top: 4px; color: var(--muted); font-size: 13px; line-height: 1.5; }
.owner-tier-badge { flex: none; padding: 4px 8px; font-size: 13px; font-style: normal; font-weight: 700; background: var(--surface-hover); color: var(--text-soft); border-radius: var(--radius-badge); }
.owner-tier-badge.tier-owner { color: var(--text-soft); background: var(--surface-hover); }
.owner-tier-badge.tier-friend { color: var(--text-soft); background: var(--surface-hover); }
.owner-user-usage { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.owner-user-usage span { display: grid; gap: 4px; padding: 8px; border-radius: var(--radius-card); background: var(--surface-hover); color: var(--muted); font-size: 13px; }
.owner-user-usage b { color: var(--text); font-size: 13px; font-variant-numeric: tabular-nums; }
.owner-tier-actions { display: flex; align-items: center; gap: 8px; }
.owner-tier-actions button { padding: 8px 8px; border: 1px solid var(--border); border-radius: var(--radius-control); background: transparent; color: var(--text-soft); font-size: 13px; font-weight: 700; }
.owner-tier-actions button.active { border-color: color-mix(in srgb, var(--accent) 45%, var(--border)); background: color-mix(in srgb, var(--accent) 9%, transparent); color: var(--accent); }
.owner-tier-actions button:disabled { cursor: default; opacity: .55; }
.owner-tier-actions small { color: var(--muted); font-size: 13px; }
.owner-audit-note { flex: none; display: flex; align-items: flex-start; gap: 8px; margin: 12px 0 0; color: var(--muted); font-size: 13px; line-height: 1.55; }
.owner-audit-note svg { flex: none; color: var(--green); }
.owner-admin-modal > footer { flex: none; }
.invite-form { display: grid; grid-template-columns: 1fr auto; gap: 8px; margin-top: 12px; }
.invite-form label { min-width: 0; display: flex; align-items: center; gap: 8px; height: 42px; padding: 0 8px; border: 1px solid var(--border); border-radius: var(--radius-card); color: var(--muted); }
.invite-form input { min-width: 0; flex: 1; border: 0; background: transparent; color: var(--text); outline: 0; }
.invite-message { margin: 8px 0 0; color: var(--accent); font-size: 13px; }
.reset-demo-button { display: inline-flex; align-items: center; gap: 4px; margin-top: 12px; }
.home-route-modal { width: min(620px, 100%); max-height: min(820px, calc(100dvh - 32px)); overflow-y: auto; }
.home-route-query { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.home-route-query label { display: grid; gap: 8px; color: var(--text-soft); font-size: 13px; font-weight: 700; }
.home-route-save label { display: grid; gap: 8px; color: var(--text-soft); font-size: 13px; font-weight: 700; }
.home-route-query label > span { display: flex; align-items: center; gap: 4px; color: var(--muted); }
.home-route-save label > span { display: flex; align-items: center; gap: 4px; color: var(--muted); }
.home-route-query input { width: 100%; min-width: 0; padding: 0 12px; border: 1px solid var(--border); border-radius: var(--radius-control); outline: 0; color: var(--text); height: 48px; background: var(--field-bg); }
.home-route-save input { width: 100%; min-width: 0; padding: 0 12px; border: 1px solid var(--border); border-radius: var(--radius-control); outline: 0; color: var(--text); height: 48px; background: var(--field-bg); }
.home-route-save select { width: 100%; min-width: 0; padding: 0 12px; border: 1px solid var(--border); border-radius: var(--radius-control); outline: 0; color: var(--text); height: 48px; background: var(--field-bg); }
.home-route-query input:focus { border-color: var(--accent); }
.home-route-save input:focus { border-color: var(--accent); }
.home-route-save select:focus { border-color: var(--accent); }
.home-route-query > button { grid-column: 1 / -1; display: inline-flex; align-items: center; gap: 4px; }
.home-route-result { display: grid; gap: 8px; margin-top: 16px; padding: 12px; border: 1px solid color-mix(in srgb, var(--violet) 28%, var(--border)); border-radius: var(--radius-card); background: color-mix(in srgb, var(--violet) 6%, var(--surface-soft)); }
.home-route-result > div { display: flex; align-items: center; gap: 8px; color: var(--violet); }
.home-route-result b { color: var(--text); font-size: 13px; }
.home-route-result p { margin: 0; color: var(--text-soft); line-height: 1.75; white-space: pre-wrap; font-size: 15px; overflow-wrap: anywhere; }
.home-route-result small { color: var(--muted); font-size: 13px; }
.home-route-save { display: grid; gap: 8px; margin-top: 12px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-card); background: var(--surface-soft); }
.home-route-save > div { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.home-route-save > button { display: inline-flex; align-items: center; gap: 4px; }
.home-route-actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 12px; }
.home-route-actions button { display: inline-flex; align-items: center; gap: 4px; }
.home-route-actions small { max-width: 270px; color: var(--muted); font-size: 13px; line-height: 1.5; text-align: right; }

/* Dynamic Island and standalone PWA safe areas. */
.app-shell { min-height: 100dvh; }
.login-shell { min-height: 100dvh; }
.loading-screen { min-height: 100dvh; }

@media (max-width: 620px) {
.login-shell { min-height: 100dvh; padding: calc(24px + env(safe-area-inset-top)) 16px calc(76px + env(safe-area-inset-bottom)); overflow-x: hidden; overflow-y: auto; }
.app-header { height: calc(58px + env(safe-area-inset-top)); padding-top: env(safe-area-inset-top); }
.app-main { padding-bottom: calc(100px + env(safe-area-inset-bottom)); }
.sync-loader { top: calc(68px + env(safe-area-inset-top)); }
.toast { bottom: calc(84px + env(safe-area-inset-bottom)); }
.login-shell > .app-footer { bottom: calc(18px + env(safe-area-inset-bottom)); }
.modal-backdrop { padding: max(12px, env(safe-area-inset-top)) 8px max(12px, env(safe-area-inset-bottom)); }
.nested-modal-backdrop { padding: max(12px, env(safe-area-inset-top)) 8px max(12px, env(safe-area-inset-bottom)); }
.transport-plan-form { padding: 12px; }
.transport-plan-form.transport-editor-modal { max-height: calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 24px); }
.plan-type-switch { grid-template-columns: repeat(2, 1fr); }
.transport-fields { grid-template-columns: 1fr; }
.transport-fields .field-span-2 { grid-column: 1; }
.transport-stop { grid-column: 1; }
.transport-stop label:last-child:nth-child(odd) { grid-column: 1 / -1; }
.transport-details-heading { align-items: center; }
.gate-editor { grid-template-columns: 1fr; }
.gate-editor .secondary-button { width: 100%; }
.transit-ai-modal { max-height: calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 24px); overflow-y: auto; }
.flight-lookup-action { grid-template-columns: 1fr; }
.flight-lookup-modal { max-height: calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 24px); }
.flight-compare-grid { grid-template-columns: 1fr; }
.note-compare { grid-template-columns: 1fr; }
.quota-overview { grid-template-columns: 1fr; }
.home-quick-grid { grid-template-columns: 1fr; }
.home-route-query { grid-template-columns: 1fr; }
.home-route-save > div { grid-template-columns: 1fr; }
.home-route-query > button { grid-column: 1; }
.home-route-actions { align-items: stretch; flex-direction: column-reverse; }
.home-route-actions button { width: 100%; }
.home-route-actions small { max-width: none; text-align: left; }
.composer-ai-input { align-items: stretch; flex-direction: column; }
.ai-inline-button { align-self: flex-start; }
.actual-flight-summary { grid-template-columns: 1fr; }
.owner-admin-modal { max-height: calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 24px); }
.owner-user-search { grid-template-columns: 1fr; }
.owner-user-search .secondary-button { width: 100%; }
.owner-user-heading { align-items: flex-start; }
.owner-user-usage { grid-template-columns: 1fr 1fr; }
.owner-user-usage span:last-child { grid-column: 1 / -1; }
.airport-options { position: fixed; left: 20px; right: 20px; top: 22%; max-height: 50dvh; }
}

@media (prefers-reduced-motion: reduce) {
* { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
*::before { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
*::after { scroll-behavior: auto !important; transition-duration: .01ms !important; animation-duration: .01ms !important; animation-iteration-count: 1 !important; }
}
button svg { flex-shrink: 0; }
input::placeholder { color: var(--muted); }
textarea::placeholder { color: var(--muted); }
.login-story { min-width: 0; padding-top: var(--space-6); }
.trip-card > div { min-width: 0; }
.secondary-button:hover:not(:disabled) { background: var(--surface-hover); }
.icon-button svg { width: 20px; height: 20px; }
.home-route-entry > span svg { width: 20px; height: 20px; }
.chart-card header { margin-bottom: var(--space-3); }
.settings-row:has(> em) { grid-template-columns: 20px minmax(0, 1fr) auto 20px; }
.currency-grid button.active > span { color: var(--accent); }
.theme-options button svg { width: 20px; height: 20px; }
.tier-heading > small { text-align: right; line-height: 1.6; }
.modal-card header > div { min-width: 0; }
.connection.demo { display: flex; color: var(--text-soft); }
.connection.demo svg { color: var(--muted); }
.empty-state > p { max-width: 420px; margin-inline: auto; line-height: 1.6; font-size: 15px; }

@media (max-width: 860px) {
.login-story { padding-top: 0; }
.login-layout { gap: var(--space-6); }
.currency-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}

@media (max-width: 620px) {
.app-header { padding-left: max(16px, env(safe-area-inset-left)); padding-right: max(16px, env(safe-area-inset-right)); }
.app-brand { gap: var(--space-2); font-size: 15px; }
.header-actions { gap: var(--space-1); }
.connection.demo { font-size: 13px; margin-right: 0; gap: 4px; }
.connection.demo svg { display: none; }
.login-shell { padding-bottom: calc(32px + env(safe-area-inset-bottom)); }
.login-shell > .app-footer { position: static; margin-top: var(--space-6); font-size: 13px; }
.login-card { padding: var(--space-4); }
.login-story h1, .section-hero h1, .trip-board-header h1 { font-size: 28px; }
.feature-row { justify-content: center; gap: var(--space-5); }
.feature-row > div { grid-template-columns: 20px auto; }
.settings-card, .account-card { padding: var(--space-4); }
.currency-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.theme-options { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-2); }
.theme-options button { position: relative; grid-template-columns: minmax(0, 1fr); gap: 8px; font-size: 13px; padding: var(--space-3); }
.theme-options button > span { grid-column: 1; white-space: normal; }
.theme-options button > svg:last-child:not(:first-child) { position: absolute; top: 8px; right: 8px; width: 14px; }
.settings-row > em { font-size: 13px; }
.tier-heading { flex-wrap: wrap; }
.tier-heading > small { text-align: left; }
.filter-tabs { gap: var(--space-4); }
.filter-row { gap: var(--space-2); }
.record-card { display: grid; grid-template-columns: 20px minmax(0, 1fr); }
.record-main { padding-right: 0; }
.record-expense .record-main { padding-right: 0; }
.record-amount, .record-actions, .done-stamp { position: static; grid-column: 2; justify-self: start; }
.record-controls { grid-column: 2; align-items: flex-start; }
.record-control-buttons { justify-content: flex-start; }
.record-amount { margin: 0; }
.stats-toolbar { align-items: start; gap: var(--space-3); flex-wrap: wrap; }
.summary-grid { grid-template-columns: minmax(0, 1fr); }
.total-card > strong { font-size: 32px; overflow-wrap: anywhere; }
.insight-card { min-height: 112px; }
.trip-card { grid-template-columns: 20px minmax(0, 1fr) 20px; gap: var(--space-3); }
.trip-progress { grid-column: 2; grid-row: 2; text-align: left; }
.trip-card > svg { grid-column: 3; grid-row: 1; }
.day-column > header { width: 100%; align-items: center; }
.day-column { padding-top: 56px; }
.day-column > header .icon-button { width: 44px; height: 44px; }
.plan-summary { grid-template-columns: 24px 24px minmax(0, 1fr) 36px; gap: var(--space-2); padding: var(--space-3) var(--space-2); }
.plan-time { grid-column: 3; grid-row: 1; font-size: 14px; }
.plan-content { grid-column: 3; grid-row: 2; }
.drag-handle { grid-column: 1; grid-row: 1 / span 2; width: 24px; min-height: 44px; }
.plan-check { grid-column: 2; grid-row: 1 / span 2; }
.plan-summary > .icon-button { grid-column: 4; grid-row: 1 / span 2; width: 36px; }
.plan-expanded { padding: var(--space-4); }
.actual-row { grid-template-columns: 40px minmax(0, 1fr); }
.actual-row strong { grid-column: 2; }
.modal-backdrop, .nested-modal-backdrop, .composer-modal, .guidance-backdrop { padding: max(12px, env(safe-area-inset-top)) 12px max(12px, env(safe-area-inset-bottom)); }
.modal-card, .guidance-card, .composer-modal-inner { padding: var(--space-4); max-height: calc(100dvh - env(safe-area-inset-top) - env(safe-area-inset-bottom) - 24px); }
.composer-modal-inner { padding: 0; }
.guidance-backdrop { align-items: center; }
.transport-stop > div, .transport-stop > .rail-stop-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.mobile-nav { left: 12px; right: 12px; padding: 4px; border-radius: var(--radius-card); }
.mobile-nav button { font-size: 13px; height: 56px; }
.mobile-nav .mobile-add { height: 48px; border-radius: var(--radius-control); }
.app-main { width: calc(100% - 32px); padding-top: var(--space-5); padding-bottom: calc(112px + env(safe-area-inset-bottom)); }
}

@media (max-width: 430px) {
.quick-types { display: none; }
.app-brand strong { font-size: 15px; }
.login-story > p { font-size: 14px; }
.feature-row { gap: var(--space-4); }
.flight-candidate-route { grid-template-columns: minmax(0, 1fr); }
.flight-candidate-route > svg { display: none; }
.flight-candidate-route > div:last-child { text-align: left; }
.form-row, .ai-preview-fields { grid-template-columns: minmax(0, 1fr); }
.currency-grid button { padding: var(--space-2); }
}

.schedule-day-section { margin-bottom: var(--space-4); border-bottom: 1px solid var(--border); padding-bottom: var(--space-4); }
.schedule-day-section > header { display: flex; justify-content: space-between; align-items: center; gap: var(--space-3); margin-bottom: var(--space-2); }
.schedule-day-section > header > span { display: flex; align-items: center; gap: var(--space-2); color: var(--muted); font-size: 13px; font-weight: 600; }
.schedule-day-section > header > .text-button { display: inline-flex; align-items: center; gap: var(--space-1); padding: var(--space-2); min-height: 44px; white-space: nowrap; }
.schedule-cards { display: grid; gap: var(--space-2); }
.schedule-card { padding: var(--space-4); border-radius: var(--radius-card); }
.schedule-card.cancelled { opacity: .55; }
.schedule-card-top { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); font-size: 13px; }
.schedule-phase { display: flex; align-items: center; gap: var(--space-2); color: var(--accent); font-weight: 600; }
.schedule-card.check_out .schedule-phase { color: var(--muted); }
.schedule-card h3 { font-size: 16px; margin: var(--space-3) 0 var(--space-2); overflow-wrap: anywhere; }
.schedule-card p, .schedule-card > small, .schedule-empty { color: var(--muted); font-size: 13px; line-height: 1.6; margin: var(--space-2) 0; overflow-wrap: anywhere; }
.schedule-card .schedule-notes, .flight-record-notes { white-space: pre-wrap; }
.schedule-card .record-control-buttons { margin-top: var(--space-3); justify-content: flex-start; }
.hotel-change-notice { padding: var(--space-3); border-left: 2px solid var(--accent); background: var(--surface); color: var(--text-soft); font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.flight-current-view { display: grid; gap: var(--space-3); }
.flight-view-status { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-3); align-items: center; font-size: 13px; }
.flight-view-status b { color: var(--green); }
.flight-view-status span, .flight-record-notes { color: var(--muted); font-size: 13px; line-height: 1.6; }
.transport-facts small { margin-left: var(--space-2); color: var(--muted); }
.flight-original-plan, .flight-provider-details { margin-top: var(--space-3); }
.flight-original-plan { padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-control); }
.flight-original-plan summary, .flight-provider-details summary { min-height: 44px; cursor: pointer; color: var(--muted); font-size: 13px; padding: 12px 0; }
.flight-original-plan[open] summary { margin-bottom: var(--space-2); }

@media (max-width: 620px) {
  .flight-current-view .transport-route-grid { grid-template-columns: minmax(0, 1fr); }
  .flight-current-view .transport-route-grid > svg { display: none; }
  .flight-current-view .transport-route-grid > div:last-child { text-align: left; padding-top: var(--space-3); }
  .plan-type-switch { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

````
