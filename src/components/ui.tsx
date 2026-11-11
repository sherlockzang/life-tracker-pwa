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
