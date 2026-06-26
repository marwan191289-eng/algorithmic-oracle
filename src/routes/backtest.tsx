import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { SYMBOLS, TIMEFRAMES, type Interval, fetchKlines, fmtPrice } from "@/lib/binance";
import {
  runBacktest,
  DEFAULT_BT_PARAMS,
  type BacktestParams,
  type BacktestResult,
} from "@/lib/backtest";
import { ArrowLeft, Play, Loader2, TrendingUp, TrendingDown } from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/backtest")({
  head: () => ({ meta: [{ title: "Backtest — WhaleEye" }] }),
  component: BacktestPage,
});

function BacktestPage() {
  const [symbol, setSymbol] = useState<string>("BTCUSDT");
  const [interval, setInterval] = useState<Interval>("15m");
  const [limit, setLimit] = useState<number>(500);
  const [params, setParams] = useState<BacktestParams>({ ...DEFAULT_BT_PARAMS });
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string>("");
  const [result, setResult] = useState<BacktestResult | null>(null);

  const run = async () => {
    setRunning(true);
    setError("");
    try {
      const k = await fetchKlines(symbol, interval, Math.min(1000, Math.max(120, limit)));
      if (k.length < params.warmup + 10) {
        throw new Error("بيانات تاريخية غير كافية لهذا الإطار.");
      }
      const r = runBacktest(k, symbol, interval, params);
      setResult(r);
    } catch (e: any) {
      setError(e?.message ?? "خطأ غير متوقع");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div dir="rtl" className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/40 backdrop-blur sticky top-0 z-30">
        <div className="container py-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h1 className="text-lg md:text-xl font-bold">
              <span className="text-primary">WhaleEye</span> / Backtest — اختبار رجعي
            </h1>
            <span className="text-[11px] text-muted-foreground mono">
              نفس منطق المناطق + الزخم + RSI على بيانات تاريخية
            </span>
          </div>
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-border hover:bg-card"
          >
            <ArrowLeft className="size-3" /> العودة للوحة
          </Link>
        </div>
      </header>

      <main className="container py-4 space-y-4">
        {/* Controls */}
        <div className="rounded-2xl border border-border bg-card/40 p-4 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
            <Field label="الزوج">
              <select
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm mono"
              >
                {SYMBOLS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="الفريم">
              <select
                value={interval}
                onChange={(e) => setInterval(e.target.value as Interval)}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm mono"
              >
                {TIMEFRAMES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>
            <Field label="عدد الشموع">
              <input type="number" min={120} max={1000} step={20}
                value={limit}
                onChange={(e) => setLimit(+e.target.value)}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm mono" />
            </Field>
            <Field label="حد الإشارة |Score|">
              <input type="number" min={10} max={80} step={5}
                value={params.minScore}
                onChange={(e) => setParams({ ...params, minScore: +e.target.value })}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm mono" />
            </Field>
            <Field label="SL × ATR">
              <input type="number" min={0.3} max={3} step={0.1}
                value={params.rrStop}
                onChange={(e) => setParams({ ...params, rrStop: +e.target.value })}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm mono" />
            </Field>
            <Field label="TP × ATR">
              <input type="number" min={0.5} max={6} step={0.1}
                value={params.rrTarget}
                onChange={(e) => setParams({ ...params, rrTarget: +e.target.value })}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm mono" />
            </Field>
            <Field label="حد الاحتفاظ (شموع)">
              <input type="number" min={3} max={100} step={1}
                value={params.maxHoldBars}
                onChange={(e) => setParams({ ...params, maxHoldBars: +e.target.value })}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm mono" />
            </Field>
            <Field label="رسوم/طرف %">
              <input type="number" min={0} max={0.2} step={0.01}
                value={params.fee * 100}
                onChange={(e) => setParams({ ...params, fee: +e.target.value / 100 })}
                className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm mono" />
            </Field>
          </div>

          <div className="flex items-center justify-between">
            <div className="text-[11px] text-muted-foreground">
              يستخدم: المناطق السائلة + الزخم + RSI mean-reversion + ATR للستوب/الهدف
            </div>
            <button
              onClick={run}
              disabled={running}
              className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded text-sm font-semibold hover:opacity-90 disabled:opacity-50"
            >
              {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              {running ? "جارٍ التشغيل…" : "تشغيل Backtest"}
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-bear/40 bg-bear/10 text-bear p-3 text-sm">
            {error}
          </div>
        )}

        {result && <ResultView r={result} />}

        {!result && !error && (
          <div className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            اضبط الإعدادات ثم اضغط <strong className="text-foreground">تشغيل Backtest</strong>.
          </div>
        )}
      </main>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[10px] text-muted-foreground mb-1">{label}</div>
      {children}
    </label>
  );
}

function ResultView({ r }: { r: BacktestResult }) {
  const equityPath = useMemo(() => {
    if (r.equity.length < 2) return "";
    const W = 900, H = 200;
    const ys = r.equity.map((e) => e.eq);
    const yMin = Math.min(0, ...ys);
    const yMax = Math.max(0, ...ys);
    const span = Math.max(1e-6, yMax - yMin);
    const pts = r.equity.map((e, i) => {
      const x = (i / (r.equity.length - 1)) * W;
      const y = H - ((e.eq - yMin) / span) * H;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    const zeroY = H - ((0 - yMin) / span) * H;
    return { d: "M" + pts.join(" L"), zeroY };
  }, [r]);

  const pos = r.totalReturnPct >= 0;
  return (
    <>
      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
        <Kpi label="الصفقات" value={`${r.trades.length}`} />
        <Kpi label="الرابحة / الخاسرة" value={`${r.wins} / ${r.losses}`} />
        <Kpi label="نسبة الفوز" value={`${r.winRate.toFixed(1)}%`}
             tone={r.winRate >= 55 ? "ok" : r.winRate >= 45 ? "warn" : "bad"} />
        <Kpi label="إجمالي العائد" value={`${r.totalReturnPct >= 0 ? "+" : ""}${r.totalReturnPct.toFixed(2)}%`}
             tone={pos ? "ok" : "bad"} />
        <Kpi label="متوسط الصفقة" value={`${r.avgTradePct >= 0 ? "+" : ""}${r.avgTradePct.toFixed(2)}%`}
             tone={r.avgTradePct >= 0 ? "ok" : "bad"} />
        <Kpi label="معامل الربح" value={isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "∞"}
             tone={r.profitFactor >= 1.3 ? "ok" : r.profitFactor >= 1 ? "warn" : "bad"} />
        <Kpi label="أقصى تراجع" value={`-${r.maxDrawdownPct.toFixed(2)}%`}
             tone={r.maxDrawdownPct <= 10 ? "ok" : r.maxDrawdownPct <= 20 ? "warn" : "bad"} />
        <Kpi label="التوقع/صفقة" value={`${r.expectancy >= 0 ? "+" : ""}${r.expectancy.toFixed(3)}%`}
             tone={r.expectancy >= 0 ? "ok" : "bad"} />
      </div>

      {/* Equity curve */}
      <div className="rounded-2xl border border-border bg-card/40 p-4">
        <div className="text-sm font-semibold mb-2">منحنى الإكويتي (تراكمي %)</div>
        {typeof equityPath === "object" && equityPath ? (
          <svg viewBox="0 0 900 200" className="w-full h-52" preserveAspectRatio="none">
            <line x1="0" y1={equityPath.zeroY} x2="900" y2={equityPath.zeroY}
                  stroke="hsl(var(--border))" strokeDasharray="2 4" />
            <path d={equityPath.d} fill="none"
                  stroke={pos ? "hsl(var(--bull))" : "hsl(var(--bear))"}
                  strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
          </svg>
        ) : (
          <div className="text-xs text-muted-foreground">لا توجد بيانات.</div>
        )}
        <div className="text-[10px] text-muted-foreground mt-1 mono">
          {r.symbol} · {r.interval} · {r.barsAnalyzed} شمعة · أفضل صفقة: +{r.bestPct.toFixed(2)}% · أسوأ: {r.worstPct.toFixed(2)}%
        </div>
      </div>

      {/* Trades table */}
      <div className="rounded-2xl border border-border bg-card/40 p-0 overflow-hidden">
        <div className="px-4 py-3 border-b border-border text-sm font-semibold flex justify-between">
          <span>سجل الصفقات</span>
          <span className="text-[11px] text-muted-foreground mono">{r.trades.length} صفقة</span>
        </div>
        <div className="overflow-x-auto max-h-[420px]">
          <table className="w-full text-[11px] mono">
            <thead className="sticky top-0 bg-card/90 backdrop-blur">
              <tr className="text-muted-foreground text-right">
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">الاتجاه</th>
                <th className="px-3 py-2">الإشارة</th>
                <th className="px-3 py-2">دخول</th>
                <th className="px-3 py-2">خروج</th>
                <th className="px-3 py-2">سبب</th>
                <th className="px-3 py-2">PnL %</th>
                <th className="px-3 py-2">وقت الدخول</th>
              </tr>
            </thead>
            <tbody>
              {r.trades.map((t, i) => (
                <tr key={i} className="border-t border-border/60 hover:bg-card/60">
                  <td className="px-3 py-1.5">{i + 1}</td>
                  <td className="px-3 py-1.5">
                    {t.side === "long"
                      ? <span className="text-bull inline-flex items-center gap-1"><TrendingUp className="size-3" />Long</span>
                      : <span className="text-bear inline-flex items-center gap-1"><TrendingDown className="size-3" />Short</span>}
                  </td>
                  <td className="px-3 py-1.5">{t.score}</td>
                  <td className="px-3 py-1.5">{fmtPrice(t.entry)}</td>
                  <td className="px-3 py-1.5">{fmtPrice(t.exit)}</td>
                  <td className={cn("px-3 py-1.5", t.reason === "tp" ? "text-bull" : t.reason === "sl" ? "text-bear" : "text-muted-foreground")}>
                    {t.reason === "tp" ? "هدف" : t.reason === "sl" ? "ستوب" : "انتهاء"}
                  </td>
                  <td className={cn("px-3 py-1.5 font-semibold", t.pnlPct >= 0 ? "text-bull" : "text-bear")}>
                    {t.pnlPct >= 0 ? "+" : ""}{t.pnlPct.toFixed(2)}%
                  </td>
                  <td className="px-3 py-1.5 text-muted-foreground">
                    {new Date(t.entryTime).toLocaleString("en-GB")}
                  </td>
                </tr>
              ))}
              {r.trades.length === 0 && (
                <tr><td colSpan={8} className="text-center py-8 text-muted-foreground">لا توجد إشارات بهذه الإعدادات.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Kpi({ label, value, tone = "neutral" }: {
  label: string; value: string; tone?: "ok" | "warn" | "bad" | "neutral";
}) {
  const cls =
    tone === "ok" ? "text-bull border-bull/30 bg-bull/5"
    : tone === "warn" ? "text-gold border-gold/30 bg-gold/5"
    : tone === "bad" ? "text-bear border-bear/30 bg-bear/5"
    : "text-foreground border-border bg-card/40";
  return (
    <div className={cn("rounded-xl border px-3 py-2", cls)}>
      <div className="text-[10px] opacity-70">{label}</div>
      <div className="text-base font-bold mono mt-0.5">{value}</div>
    </div>
  );
}
