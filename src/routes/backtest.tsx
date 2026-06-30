import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { SYMBOLS, TIMEFRAMES, type Interval, fetchKlines, fmtPrice } from "@/lib/binance";
import {
  runBacktest, DEFAULT_BT_PARAMS, backtestToCSV, applyPreset, autoCalibrate,
  type BacktestParams, type BacktestResult, type MarketPreset, type AutoCalibResult,
} from "@/lib/backtest";
import { useSession } from "@/lib/session-store";
import {
  ArrowLeft, Play, Loader2, TrendingUp, TrendingDown,
  Download, FileText, Info, BookOpen, Wand2, CheckCircle2,
  TrendingUp as TrendUp, TrendingDown as TrendDn, Minus,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Signature } from "@/components/ui/Signature";

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
  const [calibrating, setCalibrating] = useState(false);
  const [calibResult, setCalibResult] = useState<AutoCalibResult | null>(null);
  const [error, setError] = useState<string>("");
  const [showGuide, setShowGuide] = useState(true);

  const result = useSession((s) => s.lastBacktest);
  const prev = useSession((s) => s.previousBacktest);
  const saveBacktest = useSession((s) => s.saveBacktest);

  const run = async () => {
    setRunning(true);
    setError("");
    try {
      const k = await fetchKlines(symbol, interval, Math.min(1000, Math.max(120, limit)));
      if (k.length < params.warmup + 10)
        throw new Error("بيانات تاريخية غير كافية لهذا الإطار.");
      const r = runBacktest(k, symbol, interval, params);
      saveBacktest(r);
    } catch (e: any) {
      setError(e?.message ?? "خطأ غير متوقع");
    } finally {
      setRunning(false);
    }
  };

  const applyP = (p: MarketPreset) => setParams((cur) => applyPreset(cur, p));

  const runCalibrate = async () => {
    setCalibrating(true);
    setError("");
    setCalibResult(null);
    try {
      const k = await fetchKlines(symbol, interval, Math.min(600, Math.max(120, limit)));
      if (k.length < 80) throw new Error("بيانات غير كافية للتشخيص (< 80 شمعة)");
      const cr = autoCalibrate(k, params);
      setCalibResult(cr);
      setParams(cr.params);
    } catch (e: any) {
      setError(e?.message ?? "خطأ في التشخيص التلقائي");
    } finally {
      setCalibrating(false);
    }
  };

  return (
    <div dir="rtl" className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border bg-card/40 backdrop-blur sticky top-0 z-30">
        <div className="container py-3 flex items-center justify-between gap-3">
          <h1 className="text-lg md:text-xl font-bold">
            <span className="text-primary">WhaleEye</span> / Backtest — اختبار رجعي
          </h1>
          <div className="flex gap-2">
            <Link to="/compare" className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-border hover:bg-card">
              مقارنة Live vs Backtest
            </Link>
            <Link to="/" className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-border hover:bg-card">
              <ArrowLeft className="size-3" /> العودة للوحة
            </Link>
          </div>
        </div>
      </header>

      <main className="container py-4 space-y-4">
        {/* Usage guide */}
        <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4">
          <button onClick={() => setShowGuide((v) => !v)}
                  className="flex items-center gap-2 text-sm font-semibold text-primary">
            <BookOpen className="size-4" /> دليل استخدام الـ Backtest وآلية عمله
            <span className="text-[11px] mono opacity-70">[{showGuide ? "إخفاء" : "إظهار"}]</span>
          </button>
          {showGuide && (
            <div className="mt-3 grid md:grid-cols-3 gap-3 text-[12px] leading-relaxed">
              <Card title="ما هو الباك تيست؟">
                محرك يطبّق نفس منطق الإشارات (المناطق السائلة + الزخم + RSI + ATR) على
                <strong> بيانات Binance التاريخية</strong> لشمعة بعد شمعة، ويحاكي صفقات بدخول/ستوب/هدف،
                ثم يحسب نسبة الفوز، معامل الربح، أقصى تراجع، والتوقع لكل صفقة.
                هدفه: قياس <strong>جودة الاستراتيجية</strong> قبل المخاطرة بمال حقيقي.
              </Card>
              <Card title="كيف أستخدمه؟">
                <ol className="list-decimal mr-4 space-y-1">
                  <li>اختر الزوج والفريم.</li>
                  <li>اختر إعداد جاهز (اتجاهي/متذبذب/متقلب) أو خصِّص يدوياً.</li>
                  <li>اضبط RSI/ATR وعتبة الإشارة (minScore).</li>
                  <li>شغّل، قارن النتائج مع الجولة السابقة، صدّر CSV/PDF.</li>
                </ol>
              </Card>
              <Card title="القيم الموصى بها حسب السوق">
                <ul className="space-y-1">
                  <li><span className="text-bull font-semibold">صاعد/هابط بقوة (Trending):</span> minScore 25، TP 2.6×ATR، احتفاظ 40 شمعة، RSI 80/20.</li>
                  <li><span className="text-gold font-semibold">متذبذب (Ranging):</span> minScore 38، TP 1.4×ATR، احتفاظ 14، RSI 68/32.</li>
                  <li><span className="text-bear font-semibold">متقلب (Volatile):</span> minScore 45، SL 1.6× / TP 2.2×، احتفاظ 12، RSI 75/25، ATR(10).</li>
                </ul>
                <div className="mt-1 text-muted-foreground">معامل ربح ≥ 1.3 ونسبة فوز ≥ 50% مع MaxDD &lt; 15% = استراتيجية صحية.</div>
              </Card>
            </div>
          )}
          <div className="mt-3 flex flex-wrap gap-2 text-[11px] mono">
            <span className="text-muted-foreground self-center">إعدادات جاهزة:</span>
            <PresetBtn current={params.preset} value="trending" label="سوق اتجاهي" onClick={applyP} tone="bull" />
            <PresetBtn current={params.preset} value="ranging"  label="سوق متذبذب" onClick={applyP} tone="gold" />
            <PresetBtn current={params.preset} value="volatile" label="سوق متقلب"  onClick={applyP} tone="bear" />
            <PresetBtn current={params.preset} value="custom"   label="مخصّص"      onClick={applyP} tone="neutral" />
          </div>
        </div>

        {/* Controls */}
        <div className="rounded-2xl border border-border bg-card/40 p-4 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
            <Field label="الزوج">
              <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm mono">
                {SYMBOLS.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="الفريم">
              <select value={interval} onChange={(e) => setInterval(e.target.value as Interval)} className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm mono">
                {TIMEFRAMES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </Field>
            <Field label="عدد الشموع"><Num v={limit} set={setLimit} min={120} max={1000} step={20}/></Field>
            <Field label="حد الإشارة |Score|"><Num v={params.minScore} set={(v) => setParams({...params, minScore: v, preset: "custom"})} min={10} max={80} step={5}/></Field>
            <Field label="SL × ATR"><Num v={params.rrStop} set={(v) => setParams({...params, rrStop: v, preset: "custom"})} min={0.3} max={3} step={0.1}/></Field>
            <Field label="TP × ATR"><Num v={params.rrTarget} set={(v) => setParams({...params, rrTarget: v, preset: "custom"})} min={0.5} max={6} step={0.1}/></Field>
            <Field label="حد الاحتفاظ"><Num v={params.maxHoldBars} set={(v) => setParams({...params, maxHoldBars: v, preset: "custom"})} min={3} max={100}/></Field>
            <Field label="رسوم/طرف %"><Num v={params.fee*100} set={(v) => setParams({...params, fee: v/100, preset: "custom"})} min={0} max={0.2} step={0.01}/></Field>

            <Field label="RSI period"><Num v={params.rsiPeriod} set={(v) => setParams({...params, rsiPeriod: v, preset: "custom"})} min={5} max={30}/></Field>
            <Field label="RSI تشبع شراء"><Num v={params.rsiOverbought} set={(v) => setParams({...params, rsiOverbought: v, preset: "custom"})} min={55} max={90}/></Field>
            <Field label="RSI تشبع بيع"><Num v={params.rsiOversold} set={(v) => setParams({...params, rsiOversold: v, preset: "custom"})} min={10} max={45}/></Field>
            <Field label="ATR period"><Num v={params.atrPeriod} set={(v) => setParams({...params, atrPeriod: v, preset: "custom"})} min={5} max={30}/></Field>
            <Field label="عمق المناطق (شموع)"><Num v={params.zoneLookback} set={(v) => setParams({...params, zoneLookback: v, preset: "custom"})} min={30} max={300} step={10}/></Field>
            <Field label="قرب المنطقة %"><Num v={params.zonePct} set={(v) => setParams({...params, zonePct: v, preset: "custom"})} min={0.1} max={3} step={0.1}/></Field>
            <Field label="فترة الإحماء"><Num v={params.warmup} set={(v) => setParams({...params, warmup: v, preset: "custom"})} min={20} max={200}/></Field>
          </div>

          <div className="flex items-center justify-between flex-wrap gap-2">
            <div className="text-[11px] text-muted-foreground flex items-center gap-1.5">
              <Info className="size-3" />
              يستخدم: المناطق السائلة + الزخم + RSI + ATR للستوب/الهدف. النتيجة الجديدة تُحفظ، والقديمة تُحفظ كـ«جولة سابقة» للمقارنة.
            </div>
            <div className="flex gap-2">
              <button onClick={runCalibrate} disabled={running || calibrating}
                className="inline-flex items-center gap-2 bg-gold/10 text-gold border border-gold/40 px-4 py-2 rounded text-sm font-semibold hover:bg-gold/20 disabled:opacity-50 transition-colors">
                {calibrating ? <Loader2 className="size-4 animate-spin" /> : <Wand2 className="size-4" />}
                {calibrating ? "جاري التشخيص…" : "تشخيص تلقائي"}
              </button>
              <button onClick={run} disabled={running || calibrating}
                className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded text-sm font-semibold hover:opacity-90 disabled:opacity-50">
                {running ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
                {running ? "جارٍ التشغيل…" : "تشغيل Backtest"}
              </button>
            </div>
          </div>
        </div>

        {error && <div className="rounded-xl border border-bear/40 bg-bear/10 text-bear p-3 text-sm">{error}</div>}

        {/* Auto-calibration results */}
        {calibResult && (
          <div className={cn(
            "rounded-2xl border p-4 space-y-3",
            calibResult.regime === "volatile" ? "border-bear/40 bg-bear/5"
            : calibResult.regime === "trending" ? "border-bull/40 bg-bull/5"
            : "border-gold/40 bg-gold/5"
          )}>
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <Wand2 className={cn("size-5",
                  calibResult.regime === "volatile" ? "text-bear"
                  : calibResult.regime === "trending" ? "text-bull" : "text-gold"
                )} />
                <span className="font-bold text-sm">
                  نتيجة التشخيص التلقائي — تم ضبط الإعدادات تلقائياً
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className={cn("text-[11px] font-bold px-2.5 py-1 rounded-full border",
                  calibResult.regime === "volatile" ? "text-bear border-bear/40 bg-bear/10"
                  : calibResult.regime === "trending" ? "text-bull border-bull/40 bg-bull/10"
                  : "text-gold border-gold/40 bg-gold/10"
                )}>
                  {calibResult.regime === "volatile" ? "متقلب" : calibResult.regime === "trending" ? "اتجاهي" : "متذبذب"}
                </span>
                <span className="text-[11px] text-muted-foreground mono">
                  ثقة {calibResult.confidence}%
                </span>
                <div className="flex items-center gap-1 text-[11px]">
                  {calibResult.emaDirection === "up" ? <TrendUp className="size-3.5 text-bull" />
                    : calibResult.emaDirection === "down" ? <TrendDn className="size-3.5 text-bear" />
                    : <Minus className="size-3.5 text-muted-foreground" />}
                  <span className="text-muted-foreground">
                    {calibResult.emaDirection === "up" ? "صاعد" : calibResult.emaDirection === "down" ? "هابط" : "جانبي"}
                  </span>
                </div>
              </div>
            </div>
            <div className="grid md:grid-cols-2 gap-1.5">
              {calibResult.reasoning.map((line, i) => (
                <div key={i} className="text-[12px] text-foreground/80 leading-relaxed">{line}</div>
              ))}
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-bull">
              <CheckCircle2 className="size-3.5" />
              تم تطبيق الإعدادات المثلى للنظام المكتشف — اضغط "تشغيل Backtest" لاختبارها
            </div>
          </div>
        )}

        {result && <ResultView r={result} prev={prev} />}

        {!result && !error && (
          <div className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
            اضبط الإعدادات ثم اضغط <strong className="text-foreground">تشغيل Backtest</strong>.
          </div>
        )}
      </main>
      <footer className="border-t border-border mt-8">
        <Signature />
      </footer>
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
function Num({ v, set, min, max, step = 1 }: { v: number; set: (n: number) => void; min?: number; max?: number; step?: number; }) {
  return (
    <input type="number" value={v} min={min} max={max} step={step}
      onChange={(e) => set(+e.target.value)}
      className="w-full bg-background border border-border rounded px-2 py-1.5 text-sm mono" />
  );
}
function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-border bg-card/40 p-3">
      <div className="font-semibold text-sm text-primary mb-1">{title}</div>
      <div className="text-foreground/85">{children}</div>
    </div>
  );
}
function PresetBtn({ current, value, label, onClick, tone }: {
  current: MarketPreset; value: MarketPreset; label: string;
  onClick: (v: MarketPreset) => void; tone: "bull" | "bear" | "gold" | "neutral";
}) {
  const active = current === value;
  const toneCls =
    tone === "bull" ? "border-bull/40 text-bull" :
    tone === "bear" ? "border-bear/40 text-bear" :
    tone === "gold" ? "border-gold/40 text-gold" : "border-border text-foreground";
  return (
    <button onClick={() => onClick(value)}
      className={cn("px-2.5 py-1 rounded border", toneCls,
        active ? "bg-card font-bold" : "bg-card/40 opacity-80 hover:opacity-100")}>
      {label}
    </button>
  );
}

// ───────────────────────────────────────────────────────────────────────
function ResultView({ r, prev }: { r: BacktestResult; prev: BacktestResult | null }) {
  const equityPath = useMemo(() => {
    if (r.equity.length < 2) return null;
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
  const downloadCSV = () => {
    const csv = backtestToCSV(r);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `whaleeye-backtest-${r.symbol}-${r.interval}-${r.runAt}.csv`;
    a.click(); URL.revokeObjectURL(url);
  };
  const downloadPDF = async () => {
    const { jsPDF } = await import("jspdf");
    const doc = new jsPDF({ orientation: "landscape", unit: "pt", format: "a4" });
    doc.setFont("helvetica");
    doc.setFontSize(14);
    doc.text(`WhaleEye Backtest - ${r.symbol} ${r.interval}`, 30, 30);
    doc.setFontSize(9);
    let y = 50;
    const kpis = [
      ["Trades", r.trades.length],
      ["WinRate %", r.winRate.toFixed(2)],
      ["Total Return %", r.totalReturnPct.toFixed(2)],
      ["Avg Trade %", r.avgTradePct.toFixed(2)],
      ["Profit Factor", isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "Inf"],
      ["Max DD %", r.maxDrawdownPct.toFixed(2)],
      ["Expectancy %", r.expectancy.toFixed(3)],
      ["RunAt", new Date(r.runAt).toISOString()],
    ];
    kpis.forEach(([k, v]) => { doc.text(`${k}: ${v}`, 30, y); y += 12; });
    y += 8;
    doc.text(`Params: ${JSON.stringify(r.params)}`, 30, y, { maxWidth: 780 });
    y += 30;
    doc.setFontSize(10); doc.text("Trades", 30, y); y += 10;
    doc.setFontSize(7);
    const header = "#  side  score  entry  exit  pnl%  reason  signal";
    doc.text(header, 30, y); y += 10;
    r.trades.forEach((t, i) => {
      if (y > 560) { doc.addPage(); y = 30; }
      const row = `${i+1}  ${t.side}  ${t.score}  ${t.entry.toFixed(4)}  ${t.exit.toFixed(4)}  ${t.pnlPct.toFixed(2)}  ${t.reason}  ${t.signalReason}`;
      doc.text(row.slice(0, 180), 30, y); y += 9;
    });
    doc.save(`whaleeye-backtest-${r.symbol}-${r.interval}-${r.runAt}.pdf`);
  };

  return (
    <>
      {/* Top bar: KPIs vs previous + export */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-[11px] mono text-muted-foreground">
          الجولة الحالية: {new Date(r.runAt).toLocaleString("en-GB")}
          {prev && <> · سابقة: {new Date(prev.runAt).toLocaleString("en-GB")} ({prev.symbol}/{prev.interval})</>}
        </div>
        <div className="flex gap-2">
          <button onClick={downloadCSV} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-border bg-card/60 hover:bg-card">
            <Download className="size-3.5" /> تصدير CSV
          </button>
          <button onClick={downloadPDF} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded border border-border bg-card/60 hover:bg-card">
            <FileText className="size-3.5" /> تصدير PDF
          </button>
        </div>
      </div>

      {/* KPIs — Row 1: core */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
        <Kpi label="الصفقات" value={`${r.trades.length}`} delta={prev ? r.trades.length - prev.trades.length : null} />
        <Kpi label="رابحة ✓ / خاسرة ✗" value={`${r.wins} / ${r.losses}`} />
        <Kpi label="نسبة الفوز"
             value={`${r.winRate.toFixed(1)}%`}
             tone={r.winRate >= 55 ? "ok" : r.winRate >= 45 ? "warn" : "bad"}
             delta={prev ? r.winRate - prev.winRate : null} suffix="%" />
        <Kpi label="إجمالي العائد"
             value={`${pos ? "+" : ""}${r.totalReturnPct.toFixed(2)}%`}
             tone={pos ? "ok" : "bad"}
             delta={prev ? r.totalReturnPct - prev.totalReturnPct : null} suffix="%" />
        <Kpi label="متوسط الصفقة"
             value={`${r.avgTradePct >= 0 ? "+" : ""}${r.avgTradePct.toFixed(2)}%`}
             tone={r.avgTradePct >= 0 ? "ok" : "bad"}
             delta={prev ? r.avgTradePct - prev.avgTradePct : null} suffix="%" />
        <Kpi label="معامل الربح"
             value={isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "∞"}
             tone={r.profitFactor >= 1.3 ? "ok" : r.profitFactor >= 1 ? "warn" : "bad"}
             delta={prev && isFinite(r.profitFactor) && isFinite(prev.profitFactor) ? r.profitFactor - prev.profitFactor : null} />
        <Kpi label="أقصى تراجع"
             value={`-${r.maxDrawdownPct.toFixed(2)}%`}
             tone={r.maxDrawdownPct <= 10 ? "ok" : r.maxDrawdownPct <= 20 ? "warn" : "bad"}
             delta={prev ? prev.maxDrawdownPct - r.maxDrawdownPct : null} suffix="%" />
        <Kpi label="التوقع/صفقة"
             value={`${r.expectancy >= 0 ? "+" : ""}${r.expectancy.toFixed(3)}%`}
             tone={r.expectancy >= 0 ? "ok" : "bad"}
             delta={prev ? r.expectancy - prev.expectancy : null} suffix="%" />
      </div>

      {/* KPIs — Row 2: risk-adjusted ratios */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
        <Kpi label="Sharpe Ratio"
             value={r.sharpeRatio.toFixed(2)}
             tone={r.sharpeRatio >= 1.5 ? "ok" : r.sharpeRatio >= 0.8 ? "warn" : "bad"}
             delta={prev ? r.sharpeRatio - prev.sharpeRatio : null} />
        <Kpi label="Sortino Ratio"
             value={r.sortinoRatio.toFixed(2)}
             tone={r.sortinoRatio >= 2 ? "ok" : r.sortinoRatio >= 1 ? "warn" : "bad"}
             delta={prev ? r.sortinoRatio - prev.sortinoRatio : null} />
        <Kpi label="Calmar Ratio"
             value={r.calmarRatio.toFixed(2)}
             tone={r.calmarRatio >= 0.5 ? "ok" : r.calmarRatio >= 0.2 ? "warn" : "bad"}
             delta={prev ? r.calmarRatio - prev.calmarRatio : null} />
        <Kpi label="WR Long / Short"
             value={`${r.longWinRate.toFixed(0)}% / ${r.shortWinRate.toFixed(0)}%`}
             tone={Math.min(r.longWinRate, r.shortWinRate) >= 50 ? "ok" : "warn"} />
        <Kpi label="متوسط الاحتفاظ"
             value={`${r.avgHoldBars.toFixed(1)} شمعة`}
             tone="neutral" />
        <Kpi label="أفضل / أسوأ"
             value={`+${r.bestPct.toFixed(1)}% / ${r.worstPct.toFixed(1)}%`}
             tone="neutral" />
        <Kpi label="أطول سلسلة ربح"
             value={`${r.maxConsecWins} تتالي`}
             tone={r.maxConsecWins >= 5 ? "ok" : "neutral"} />
        <Kpi label="أطول سلسلة خسارة"
             value={`${r.maxConsecLosses} تتالي`}
             tone={r.maxConsecLosses <= 3 ? "ok" : r.maxConsecLosses <= 6 ? "warn" : "bad"} />
      </div>

      {/* Equity curve */}
      <div className="rounded-2xl border border-border bg-card/40 p-4">
        <div className="text-sm font-semibold mb-2">منحنى الإكويتي (تراكمي %)</div>
        {equityPath ? (
          <svg viewBox="0 0 900 200" className="w-full h-52" preserveAspectRatio="none">
            <line x1="0" y1={equityPath.zeroY} x2="900" y2={equityPath.zeroY}
                  stroke="hsl(var(--border))" strokeDasharray="2 4" />
            <path d={equityPath.d} fill="none"
                  stroke={pos ? "hsl(var(--bull))" : "hsl(var(--bear))"}
                  strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
          </svg>
        ) : <div className="text-xs text-muted-foreground">لا توجد بيانات.</div>}
        <div className="text-[10px] text-muted-foreground mt-1 mono">
          {r.symbol} · {r.interval} · {r.barsAnalyzed} شمعة · أفضل: +{r.bestPct.toFixed(2)}% · أسوأ: {r.worstPct.toFixed(2)}%
        </div>
      </div>

      {/* Trades table */}
      <div className="rounded-2xl border border-border bg-card/40 overflow-hidden">
        <div className="px-4 py-3 border-b border-border text-sm font-semibold flex justify-between">
          <span>سجل الصفقات (مع سبب الإشارة، الجدران، خطة ATR، سبب الخروج)</span>
          <span className="text-[11px] text-muted-foreground mono">{r.trades.length} صفقة</span>
        </div>
        <div className="overflow-x-auto max-h-[480px]">
          <table className="w-full text-[11px] mono">
            <thead className="sticky top-0 bg-card/90 backdrop-blur">
              <tr className="text-muted-foreground text-right">
                <th className="px-2 py-2">#</th>
                <th className="px-2 py-2">اتجاه</th>
                <th className="px-2 py-2">Score</th>
                <th className="px-2 py-2">سبب الإشارة</th>
                <th className="px-2 py-2">دخول</th>
                <th className="px-2 py-2">SL/TP (ATR)</th>
                <th className="px-2 py-2">أقرب جدار</th>
                <th className="px-2 py-2">خروج</th>
                <th className="px-2 py-2">سبب الخروج</th>
                <th className="px-2 py-2">PnL %</th>
              </tr>
            </thead>
            <tbody>
              {r.trades.map((t, i) => (
                <tr key={i} className="border-t border-border/60 hover:bg-card/60">
                  <td className="px-2 py-1.5">{i + 1}</td>
                  <td className="px-2 py-1.5">
                    {t.side === "long"
                      ? <span className="text-bull inline-flex items-center gap-1"><TrendingUp className="size-3" />L</span>
                      : <span className="text-bear inline-flex items-center gap-1"><TrendingDown className="size-3" />S</span>}
                  </td>
                  <td className="px-2 py-1.5">{t.score}</td>
                  <td className="px-2 py-1.5 text-foreground/80">{t.signalReason}</td>
                  <td className="px-2 py-1.5">{fmtPrice(t.entry)}</td>
                  <td className="px-2 py-1.5 text-muted-foreground">
                    SL {fmtPrice(t.stop)} / TP {fmtPrice(t.tp)}
                    <div className="opacity-60">atr={t.atrUsed.toFixed(4)}</div>
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground">
                    {t.nearestSupport ? <>↓ {fmtPrice(t.nearestSupport)}</> : "—"}
                    {" "}
                    {t.nearestResistance ? <>↑ {fmtPrice(t.nearestResistance)}</> : ""}
                  </td>
                  <td className="px-2 py-1.5">{fmtPrice(t.exit)}</td>
                  <td className={cn("px-2 py-1.5", t.reason === "tp" ? "text-bull" : t.reason === "sl" ? "text-bear" : "text-muted-foreground")}>
                    {t.exitReason}
                  </td>
                  <td className={cn("px-2 py-1.5 font-semibold", t.pnlPct >= 0 ? "text-bull" : "text-bear")}>
                    {t.pnlPct >= 0 ? "+" : ""}{t.pnlPct.toFixed(2)}%
                  </td>
                </tr>
              ))}
              {r.trades.length === 0 && (
                <tr><td colSpan={10} className="text-center py-8 text-muted-foreground">لا توجد إشارات بهذه الإعدادات.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Kpi({ label, value, tone = "neutral", delta = null, suffix = "" }: {
  label: string; value: string; tone?: "ok" | "warn" | "bad" | "neutral";
  delta?: number | null; suffix?: string;
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
      {delta != null && Number.isFinite(delta) && (
        <div className={cn("text-[10px] mono mt-0.5",
          delta > 0 ? "text-bull" : delta < 0 ? "text-bear" : "text-muted-foreground")}>
          Δ مقابل السابقة: {delta >= 0 ? "+" : ""}{delta.toFixed(2)}{suffix}
        </div>
      )}
    </div>
  );
}
