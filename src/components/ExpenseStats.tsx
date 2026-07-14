import { useMemo, useState } from "react";
import { ArrowUpRight, RefreshCw, WalletCards } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { Currency, ExchangeRate, LifeRecord } from "../types";
import { CATEGORY_META, formatMoney } from "../types";

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
  const categoryData = Object.entries(CATEGORY_META).map(([key, meta]) => ({
    key,
    name: meta.label,
    color: meta.color,
    value: expenses.filter((record) => record.expense_category === key).reduce((sum, record) => sum + convertExpense(record, baseCurrency, rates), 0)
  })).filter((item) => item.value > 0);

  const dailyMap = new Map<string, number>();
  expenses.forEach((record) => {
    const key = record.event_at.slice(0, 10);
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
          {categoryData.length ? <div className="pie-layout"><div className="pie-chart"><ResponsiveContainer width="100%" height={220}><PieChart><Pie data={categoryData} dataKey="value" innerRadius={58} outerRadius={84} paddingAngle={4} stroke="none">{categoryData.map((item) => <Cell key={item.key} fill={item.color} />)}</Pie><Tooltip formatter={(value) => formatMoney(Number(value), baseCurrency)} contentStyle={{ background: "#171922", border: "1px solid #2d3140", borderRadius: 12 }} /></PieChart></ResponsiveContainer><span><b>{expenses.length}</b>笔</span></div><div className="chart-legend">{categoryData.map((item) => <div key={item.key}><i style={{ background: item.color }} /><span>{item.name}</span><b>{total ? Math.round(item.value / total * 100) : 0}%</b></div>)}</div></div> : <EmptyChart />}
        </article>
        <article className="chart-card glass-card">
          <header><div><h3>每日趋势</h3><p>每一天的消费节奏</p></div></header>
          {dailyData.length ? <ResponsiveContainer width="100%" height={235}><BarChart data={dailyData} margin={{ top: 10, right: 4, left: -22, bottom: 0 }}><CartesianGrid vertical={false} stroke="#292c37" strokeDasharray="4 4" /><XAxis dataKey="date" stroke="#858b9b" tickLine={false} axisLine={false} fontSize={11} /><YAxis stroke="#858b9b" tickLine={false} axisLine={false} fontSize={11} /><Tooltip formatter={(value) => formatMoney(Number(value), baseCurrency)} contentStyle={{ background: "#171922", border: "1px solid #2d3140", borderRadius: 12 }} /><Bar dataKey="value" fill="#6dc9ff" radius={[7, 7, 2, 2]} maxBarSize={28} /></BarChart></ResponsiveContainer> : <EmptyChart />}
        </article>
      </div>
    </section>
  );
}

function EmptyChart() {
  return <div className="empty-chart"><span /><span /><span /><p>有消费记录后，图表会在这里生长</p></div>;
}
