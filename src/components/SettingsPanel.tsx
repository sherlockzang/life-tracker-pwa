import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Bell, BookOpen, Bot, Check, ChevronRight, Cloud, HeartHandshake, History, ImagePlus, KeyRound, LoaderCircle, LogOut, Mail, Moon, Palette, Pencil, RefreshCcw, Search, ShieldCheck, Smartphone, Sparkles, Sun, Users, WalletCards, X } from "lucide-react";
import type { User } from "@supabase/supabase-js";
import type { ApiQuotaSnapshot, Changelog, Currency, OwnerManagedUser, ThemeMode, UserProfile, UserSettings } from "../types";
import { CURRENCIES } from "../types";
import { APP_VERSION } from "../version";
import { ProfileAvatar } from "./ProfileAvatar";
import { generateDailySummary } from "../lib/ai";
import { getApiQuota, getOwnerManagedUsers, redeemInvite, setOwnerManagedUserTier } from "../lib/account";

interface Props {
  user: User;
  settings: UserSettings;
  profile: UserProfile;
  changelogs: Changelog[];
  online: boolean;
  onUpdate: (settings: UserSettings) => void;
  onUpdateProfile: (profile: UserProfile, avatar?: Blob) => Promise<void>;
  onSignOut: () => void;
  isDemo?: boolean;
  onResetDemo?: () => void;
}

const AVATAR_COLORS = ["#0A84FF", "#1C1C1E", "#3A3A3C", "#636366", "#8E8E93", "#D1D1D6"];

export function SettingsPanel({ user, settings, profile, changelogs, online, onUpdate, onUpdateProfile, onSignOut, isDemo = false, onResetDemo }: Props) {
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
    try { const result = await generateDailySummary(); setSummary(result.skipped ? "今天没有待进行的行程计划，不会调用 AI。" : result.result); }
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
            <button className="settings-row" disabled={isDemo || summaryLoading} onClick={() => void loadDailySummary()}><span className="settings-icon coral"><Bell /></span><div><b>今日计划摘要</b><small>{isDemo ? "演示模式暂不开放" : "当天首次打开时按需生成并缓存"}</small></div>{summaryLoading ? <LoaderCircle className="spin" /> : <ChevronRight />}</button>
            {summary && <div className="daily-summary"><Sparkles size={16} /><p>{summary}</p></div>}
            <button className="settings-row" onClick={() => setShowingUsageGuide(true)}><span className="settings-icon violet"><BookOpen /></span><div><b>使用说明</b><small>快速记录、交通模板与 AI 路线查询</small></div><ChevronRight /></button>
            <button className="settings-row" onClick={() => setShowingReleaseHistory(true)}><span className="settings-icon blue"><History /></span><div><b>更新记录</b><small>查看 Life Tracker 的所有版本与新功能</small></div><em>v{APP_VERSION}</em><ChevronRight /></button>
            <button className="settings-row" onClick={() => setShowingPrivacy(true)}><span className="settings-icon green"><ShieldCheck /></span><div><b>隐私与数据</b><small>所有云端数据均受账号隔离保护</small></div><ChevronRight /></button>
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
          <div className={`sync-state ${online ? "online" : "offline"}`}><Cloud size={17} /><span><b>{isDemo ? "本地演示模式" : online ? "云端已连接" : "离线模式"}</b><small>{isDemo ? "不会读取或写入真实账号数据" : online ? "记录会自动同步" : "恢复网络后自动同步"}</small></span></div>
          <button className="signout-button" onClick={onSignOut}><LogOut size={17} />{isDemo ? "退出演示" : "退出登录"}</button>
        </aside>
      </div>
      <footer className="app-footer settings-footer"><span>版本 {APP_VERSION}</span><span>© 2026 Sherlock Zang. 联系邮箱：sherlockzang8818@gmail.com</span></footer>
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
