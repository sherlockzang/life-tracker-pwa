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
      <div className="login-orb login-orb-one" />
      <div className="login-orb login-orb-two" />
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
      <footer className="app-footer">© 2026 Sherlock Zang. 联系邮箱：sherlockzang8818@gmail.com</footer>
    </main>
  );
}
