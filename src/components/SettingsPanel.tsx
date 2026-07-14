import { Bell, Check, ChevronRight, Cloud, LogOut, Mail, Moon, Palette, ShieldCheck, Smartphone, Sun, WalletCards } from "lucide-react";
import type { User } from "@supabase/supabase-js";
import type { Currency, ThemeMode, UserSettings } from "../types";
import { CURRENCIES } from "../types";

interface Props {
  user: User;
  settings: UserSettings;
  online: boolean;
  onUpdate: (settings: UserSettings) => void;
  onSignOut: () => void;
}

export function SettingsPanel({ user, settings, online, onUpdate, onSignOut }: Props) {
  const update = (patch: Partial<UserSettings>) => onUpdate({ ...settings, ...patch, updated_at: new Date().toISOString() });
  return (
    <section className="settings-page">
      <div className="section-hero"><div><p className="eyebrow">设置</p><h1>让记录更像你。</h1><p>选择常用币种和显示方式，数据会跟随你的账号。</p></div></div>
      <div className="settings-layout">
        <div className="settings-main">
          <section className="settings-card glass-card"><header><span className="settings-icon blue"><WalletCards /></span><div><h2>主币种</h2><p>统计图表会统一换算到这个币种</p></div></header><div className="currency-grid">{CURRENCIES.map((currency) => <button className={settings.base_currency === currency.code ? "active" : ""} key={currency.code} onClick={() => update({ base_currency: currency.code as Currency })}><span>{currency.symbol}</span><div><b>{currency.code}</b><small>{currency.label}</small></div>{settings.base_currency === currency.code && <Check size={16} />}</button>)}</div></section>
          <section className="settings-card glass-card"><header><span className="settings-icon violet"><Palette /></span><div><h2>外观</h2><p>可以跟随设备，也可以固定选择</p></div></header><div className="theme-options">{([{"value":"system","label":"跟随系统","icon":Smartphone},{"value":"dark","label":"深色","icon":Moon},{"value":"light","label":"浅色","icon":Sun}] as const).map((item) => { const Icon = item.icon; return <button className={settings.theme === item.value ? "active" : ""} onClick={() => update({ theme: item.value as ThemeMode })} key={item.value}><Icon /><span>{item.label}</span>{settings.theme === item.value && <Check size={16} />}</button>; })}</div></section>
          <section className="settings-card glass-card"><button className="settings-row"><span className="settings-icon coral"><Bell /></span><div><b>行程提醒</b><small>即将到来的计划与每日摘要</small></div><em>稍后开放</em><ChevronRight /></button><button className="settings-row"><span className="settings-icon green"><ShieldCheck /></span><div><b>隐私与数据</b><small>所有云端数据均受账号隔离保护</small></div><ChevronRight /></button></section>
        </div>
        <aside className="account-card glass-card"><div className="avatar">{user.email?.slice(0, 1).toUpperCase()}</div><h3>{user.email?.split("@")[0]}</h3><p><Mail size={14} />{user.email}</p><div className={`sync-state ${online ? "online" : "offline"}`}><Cloud size={17} /><span><b>{online ? "云端已连接" : "离线模式"}</b><small>{online ? "记录会自动同步" : "恢复网络后自动同步"}</small></span></div><button className="signout-button" onClick={onSignOut}><LogOut size={17} />退出登录</button></aside>
      </div>
    </section>
  );
}
