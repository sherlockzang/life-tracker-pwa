/** Persisted avatar choices must remain byte-for-byte compatible with 1.4.1. */
export const AVATAR_COLORS = ["#0A84FF", "#1C1C1E", "#3A3A3C", "#636366", "#8E8E93", "#D1D1D6"];

/** Styling only; category keys, chart data and currency math are unchanged. */
export const CHART_COLORS = Array.from({ length: 6 }, (_, index) => `var(--chart-${index + 1})`);
export const CHART_TOOLTIP_STYLE = { background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border)", borderRadius: 10, fontSize: 13 };
