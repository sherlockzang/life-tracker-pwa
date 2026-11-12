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
          <h1>生活记录，<br /><span>行程规划。</span></h1>
          <div className="feature-row">
            <div><span className="feature-icon coral"><ReceiptText size={19} /></span><b>消费</b></div>
            <div><span className="feature-icon blue"><MapPinned size={19} /></span><b>行程</b></div>
            <div><span className="feature-icon violet"><NotebookPen size={19} /></span><b>随记</b></div>
          </div>
        </div>

        <div className="glass-card login-card">
          <div className="login-card-heading">
            <span className="mail-badge"><Mail size={22} /></span>
            <div><h2>邮箱登录</h2><p>使用邮箱验证码，无需密码。</p></div>
          </div>
          {status === "code" || status === "verifying" ? (
            <div className="sent-state">
              <span className="success-ring"><KeyRound size={28} /></span>
              <h3>验证码已发送</h3>
              <p>输入发送至 <strong>{email}</strong> 的 6 位验证码。</p>
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
              <p className="form-hint">首次登录将自动创建账号。</p>
              <div className="login-limits"><Sparkles size={15} /><p>普通账号每天可查航班 2 次，AI 功能共 15 次。邀请码可在登录后的设置中兑换；手动记录不限次数。</p></div>
            </form>
          )}
          <div className="demo-entry"><button className="secondary-button full" disabled={demoLoading} onClick={async () => { setDemoLoading(true); setError(""); try { await onStartDemo(); } catch (demoError) { setError(demoError instanceof Error ? demoError.message : "暂时无法进入演示模式"); } finally { setDemoLoading(false); } }}><FlaskConical size={17} />{demoLoading ? "正在准备演示…" : "试用演示模式"}</button><small>演示数据保存在本机；航班为模拟信息，AI 每台设备每天 2 次。</small></div>
          <div className="privacy-note"><ShieldCheck size={17} /><span>账号数据相互隔离，不与其他用户共享。</span></div>
        </div>
      </section>
      <footer className="app-footer">© 2026 Sherlock Zang.</footer>
    </main>
  );
}
