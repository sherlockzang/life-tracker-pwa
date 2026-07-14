const BRAND_LOGO_URL = `${import.meta.env.BASE_URL}life-tracker-logo-v112.png`;

export function BrandLogo({ className = "" }: { className?: string }) {
  return <img className={`brand-logo ${className}`.trim()} src={BRAND_LOGO_URL} alt="" aria-hidden="true" draggable={false} />;
}
