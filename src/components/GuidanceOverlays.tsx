import { useState } from "react";
import { ArrowRight, Check, ListFilter, MapPinned, Plus, Settings, SlidersHorizontal, Sparkles } from "lucide-react";
import type { Changelog } from "../types";

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
  const item = ONBOARDING_STEPS[step];
  const Icon = item.icon;

  async function complete() {
    setSaving(true);
    try { await onComplete(); } finally { setSaving(false); }
  }

  return (
    <div className="guidance-backdrop" role="presentation">
      <section className="guidance-card glass-card" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <header><span>第一次使用</span><button onClick={() => void complete()} disabled={saving}>跳过</button></header>
        <div className="guidance-icon"><Icon /></div>
        <p className="guidance-step">{step + 1} / {ONBOARDING_STEPS.length}</p>
        <h2 id="onboarding-title">{item.title}</h2>
        <p>{item.description}</p>
        <div className="guidance-dots" aria-hidden="true">{ONBOARDING_STEPS.map((_, index) => <span className={index === step ? "active" : ""} key={index} />)}</div>
        <button className="primary-button full" disabled={saving} onClick={() => step === ONBOARDING_STEPS.length - 1 ? void complete() : setStep(step + 1)}>{step === ONBOARDING_STEPS.length - 1 ? <><Check size={17} />开始记录</> : <>下一步<ArrowRight size={17} /></>}</button>
      </section>
    </div>
  );
}

export function WhatsNew({ changelog, onDismiss }: { changelog: Changelog; onDismiss: () => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  async function dismiss() {
    setSaving(true);
    try { await onDismiss(); } finally { setSaving(false); }
  }
  return (
    <div className="guidance-backdrop" role="presentation">
      <section className="guidance-card whats-new-card glass-card" role="dialog" aria-modal="true" aria-labelledby="whats-new-title">
        <div className="guidance-icon"><Sparkles /></div>
        <p className="eyebrow">版本 {changelog.version}</p>
        <h2 id="whats-new-title">Life Tracker 更新了</h2>
        <ul>{changelog.summary.map((item) => <li key={item}><Check size={16} /><span>{item}</span></li>)}</ul>
        <button className="primary-button full" disabled={saving} onClick={() => void dismiss()}>{saving ? "保存中…" : "知道了"}</button>
      </section>
    </div>
  );
}
