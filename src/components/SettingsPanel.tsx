import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { Bell, BookOpen, Bot, Check, ChevronRight, Cloud, HeartHandshake, History, ImagePlus, LogOut, Mail, Moon, Palette, Pencil, ShieldCheck, Smartphone, Sun, WalletCards, X } from "lucide-react";
import type { User } from "@supabase/supabase-js";
import type { Changelog, Currency, ThemeMode, UserProfile, UserSettings } from "../types";
import { CURRENCIES } from "../types";
import { APP_VERSION } from "../version";
import { ProfileAvatar } from "./ProfileAvatar";

interface Props {
  user: User;
  settings: UserSettings;
  profile: UserProfile;
  changelogs: Changelog[];
  online: boolean;
  onUpdate: (settings: UserSettings) => void;
  onUpdateProfile: (profile: UserProfile, avatar?: Blob) => Promise<void>;
  onSignOut: () => void;
}

const AVATAR_COLORS = ["#0A84FF", "#1C1C1E", "#3A3A3C", "#636366", "#8E8E93", "#D1D1D6"];

export function SettingsPanel({ user, settings, profile, changelogs, online, onUpdate, onUpdateProfile, onSignOut }: Props) {
  const [editingProfile, setEditingProfile] = useState(false);
  const [showingReleaseHistory, setShowingReleaseHistory] = useState(false);
  const [showingUsageGuide, setShowingUsageGuide] = useState(false);
  const update = (patch: Partial<UserSettings>) => onUpdate({ ...settings, ...patch, updated_at: new Date().toISOString() });

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
            <button className="settings-row"><span className="settings-icon coral"><Bell /></span><div><b>行程提醒</b><small>即将到来的计划与每日摘要</small></div><em>稍后开放</em><ChevronRight /></button>
            <button className="settings-row" onClick={() => setShowingUsageGuide(true)}><span className="settings-icon violet"><BookOpen /></span><div><b>使用说明</b><small>快速记录、交通模板与 AI 路线查询</small></div><ChevronRight /></button>
            <button className="settings-row" onClick={() => setShowingReleaseHistory(true)}><span className="settings-icon blue"><History /></span><div><b>更新记录</b><small>查看 Life Tracker 的所有版本与新功能</small></div><em>v{APP_VERSION}</em><ChevronRight /></button>
            <button className="settings-row"><span className="settings-icon green"><ShieldCheck /></span><div><b>隐私与数据</b><small>所有云端数据均受账号隔离保护</small></div><ChevronRight /></button>
          </section>
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
          <div className={`sync-state ${online ? "online" : "offline"}`}><Cloud size={17} /><span><b>{online ? "云端已连接" : "离线模式"}</b><small>{online ? "记录会自动同步" : "恢复网络后自动同步"}</small></span></div>
          <button className="signout-button" onClick={onSignOut}><LogOut size={17} />退出登录</button>
        </aside>
      </div>
      <footer className="app-footer settings-footer"><span>版本 {APP_VERSION}</span><span>© 2026 Sherlock Zang. 联系邮箱：sherlockzang8818@gmail.com</span></footer>
      {editingProfile && <ProfileEditor profile={profile} onClose={() => setEditingProfile(false)} onSave={onUpdateProfile} />}
      {showingUsageGuide && <UsageGuide onClose={() => setShowingUsageGuide(false)} />}
      {showingReleaseHistory && <ReleaseHistory changelogs={changelogs} onClose={() => setShowingReleaseHistory(false)} />}
    </section>
  );
}

function UsageGuide({ onClose }: { onClose: () => void }) {
  return (
    <div className="modal-backdrop">
      <section className="modal-card usage-guide-modal glass-card" role="dialog" aria-modal="true" aria-labelledby="usage-guide-title">
        <header><div><p className="eyebrow">使用说明</p><h2 id="usage-guide-title">记录与规划指南</h2><p>从快速记录到交通安排，都可以在这里随时回看。</p></div><button type="button" className="icon-button" aria-label="关闭使用说明" onClick={onClose}><X /></button></header>
        <div className="usage-guide-list">
          <article><span className="settings-icon blue"><BookOpen /></span><div><h3>日常记录</h3><p>从首页顶部或底部加号添加消费、行程和随记。日常内容建议优先使用文字，必要时再补充图片，让长期记录保持轻巧、清晰，也更方便检索和回顾。</p></div></article>
          <article><span className="settings-icon green"><Smartphone /></span><div><h3>交通计划</h3><p>进入行程规划并选择飞机、铁路或市内交通模板。飞机模板可输入航班号后主动查询并确认填入；起飞和降落分别使用当地时区。时间线会自动提炼航班号、车次、站点与时间，登机口和实际乘车路线也可以稍后补记。</p></div></article>
          <article><span className="settings-icon violet"><Bot /></span><div><h3>AI 路线查询</h3><p>配置 DeepSeek 后，在市内交通模板填写起点、终点和预计时间，点击“AI 查询路线”。先检查并编辑返回内容，再点击“填入路线”，最后保存计划；AI 结果不会自动写入记录。</p></div></article>
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

function ProfileEditor({ profile, onClose, onSave }: { profile: UserProfile; onClose: () => void; onSave: Props["onUpdateProfile"] }) {
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
        <div className="profile-preview"><ProfileAvatar profile={{ display_name: displayName, avatar_color: avatarColor, avatar_url: avatarUrl }} imageUrl={previewUrl ?? avatarUrl} className="avatar profile-preview-avatar" /><button type="button" className="secondary-button" onClick={() => fileInput.current?.click()}><ImagePlus size={16} />上传图片</button><input ref={fileInput} className="visually-hidden" type="file" accept="image/jpeg,image/png,image/webp" onChange={chooseFile} /></div>
        <label>显示昵称<input value={displayName} maxLength={40} onChange={(event) => setDisplayName(event.target.value)} placeholder="输入你的昵称" required /></label>
        <fieldset className="avatar-color-field"><legend>首字母头像颜色</legend><div>{AVATAR_COLORS.map((color) => <button type="button" key={color} className={!avatarUrl && !previewUrl && avatarColor === color ? "active" : ""} style={{ backgroundColor: color }} aria-label={`选择头像颜色 ${color}`} onClick={() => chooseColor(color)}>{!avatarUrl && !previewUrl && avatarColor === color && <Check size={15} />}</button>)}</div></fieldset>
        <p className="profile-hint">图片会自动居中裁剪为正方形，最大 2MB。</p>
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
