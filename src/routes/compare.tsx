import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useSession, type LiveSignalSample } from "@/lib/session-store";
import type { BacktestResult, BacktestTrade } from "@/lib/backtest";
import {
  ArrowLeft, GitCompare, BookOpen, AlertTriangle,
  TrendingUp, TrendingDown, BarChart2, Activity,
  Target, Sigma, Info, ChevronDown, ChevronUp,
  Zap, CheckCircle2, XCircle, Clock, RefreshCw,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Signature } from "@/components/ui/Signature";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, AreaChart, Area,
  BarChart, Bar, ScatterChart, Scatter, ZAxis,
} from "recharts";

export const Route = createFileRoute("/compare")({
  head: () => ({ meta: [{ title: "Live vs Backtest — WhaleEye" }] }),
  component: ComparePage,
});

// ── Types ──────────────────────────────────────────────────────────────────────
interface MatchedSignal {
  liveT: number;
  side: "long" | "short";
  liveScore: number;
  liveMid: number;
  liveConfidence: number;
  btTrade: BacktestTrade | null;
  agrees: boolean | null;
  pnlPct: number | null;
  timeDeltaMin: number | null;
}

// ── Signal matching algorithm ──────────────────────────────────────────────────
// Uses tighter window (±30min for intraday) and score-aware matching
function matchSignals(live: LiveSignalSample[], r: BacktestResult): MatchedSignal[] {
  if (!live.length || !r) return [];

  // Infer window based on interval
  const intervalMs: Record<string, number> = {
    "1m": 15 * 60_000, "3m": 30 * 60_000, "5m": 45 * 60_000,
    "15m": 90 * 60_000, "30m": 3 * 3600_000, "1h": 6 * 3600_000,
    "4h": 24 * 3600_000, "1d": 5 * 24 * 3600_000,
  };
  const matchWindow = intervalMs[r.interval] ?? 2 * 3600_000;

  return live
    .filter(s => s.side !== "none" && s.symbol === r.symbol)
    .map(s => {
      let best: BacktestTrade | null = null;
      let bestScore = Infinity;

      for (const t of r.trades) {
        const dt = Math.abs(t.entryTime - s.t);
        if (dt >= matchWindow) continue;

        // Combined score: time proximity + signal direction agreement bonus
        const timeScore = dt / matchWindow;
        const directionBonus = t.side === s.side ? -0.3 : 0;
        const combined = timeScore + directionBonus;

        if (combined < bestScore) {
          bestScore = combined;
          best = t;
        }
      }

      return {
        liveT: s.t,
        side: s.side as "long" | "short",
        liveScore: s.score,
        liveMid: s.mid,
        liveConfidence: s.confidence,
        btTrade: best,
        agrees: best ? best.side === s.side : null,
        pnlPct: best ? best.pnlPct : null,
        timeDeltaMin: best ? Math.abs(best.entryTime - s.t) / 60_000 : null,
      };
    });
}

// ── Compute equity curve correlation ─────────────────────────────────────────
function pearsonR(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  if (n < 2) return 0;
  const ax = a.slice(0, n), bx = b.slice(0, n);
  const ma = ax.reduce((s, v) => s + v, 0) / n;
  const mb = bx.reduce((s, v) => s + v, 0) / n;
  const num = ax.reduce((s, v, i) => s + (v - ma) * (bx[i] - mb), 0);
  const da = Math.sqrt(ax.reduce((s, v) => s + (v - ma) ** 2, 0));
  const db = Math.sqrt(bx.reduce((s, v) => s + (v - mb) ** 2, 0));
  return da * db > 0 ? num / (da * db) : 0;
}

// ── Alpha decay analysis ──────────────────────────────────────────────────────
// Groups matched signals by score bucket and computes average PnL per bucket
function alphaDecayAnalysis(matches: MatchedSignal[]) {
  const buckets: Record<string, { sum: number; count: number }> = {
    "25-35": { sum: 0, count: 0 }, "35-45": { sum: 0, count: 0 },
    "45-60": { sum: 0, count: 0 }, "60-80": { sum: 0, count: 0 }, "80+": { sum: 0, count: 0 },
  };
  for (const m of matches) {
    if (!m.btTrade) continue;
    const abs = Math.abs(m.liveScore);
    const key =
      abs >= 80 ? "80+" : abs >= 60 ? "60-80" : abs >= 45 ? "45-60"
      : abs >= 35 ? "35-45" : "25-35";
    buckets[key].sum += m.pnlPct ?? 0;
    buckets[key].count++;
  }
  return Object.entries(buckets)
    .filter(([, { count }]) => count > 0)
    .map(([bucket, { sum, count }]) => ({
      bucket, avgPnl: sum / count, count,
    }));
}

// ── Score distribution: live vs BT ───────────────────────────────────────────
function scoreDistributionComparison(
  matches: MatchedSignal[],
  btTrades: BacktestTrade[]
) {
  const buckets = ["25-35", "35-45", "45-60", "60-80", "80+"];
  const btCounts: Record<string, number> = Object.fromEntries(buckets.map(b => [b, 0]));
  const liveCounts: Record<string, number> = Object.fromEntries(buckets.map(b => [b, 0]));

  for (const t of btTrades) {
    const abs = Math.abs(t.score);
    const k = abs >= 80 ? "80+" : abs >= 60 ? "60-80" : abs >= 45 ? "45-60" : abs >= 35 ? "35-45" : "25-35";
    btCounts[k]++;
  }
  for (const m of matches) {
    const abs = Math.abs(m.liveScore);
    const k = abs >= 80 ? "80+" : abs >= 60 ? "60-80" : abs >= 45 ? "45-60" : abs >= 35 ? "35-45" : "25-35";
    liveCounts[k]++;
  }
  return buckets.map(b => ({ bucket: b, bt: btCounts[b], live: liveCounts[b] }));
}

// ─────────────────────────────────────────────────────────────────────────────
function ComparePage() {
  const r = useSession(s => s.lastBacktest);
  const allLog = useSession(s => s.liveSignalLog);
  const pushLiveSignal = useSession(s => s.pushLiveSignal);
  const [showGuide, setShowGuide] = useState(true);
  const [tableLimit, setTableLimit] = useState(20);
  const [injected, setInjected] = useState(false);

  const live = useMemo<LiveSignalSample[]>(() => {
    if (!r) return [];
    const arr = allLog[r.symbol] ?? [];
    return arr.filter(s => s.t >= r.fromTime && s.t <= Date.now());
  }, [r, allLog]);

  const matches = useMemo(() => r ? matchSignals(live, r) : [], [live, r]);

  // ── KPIs ─────────────────────────────────────────────────────────────────
  const liveSignals  = live.filter(s => s.side !== "none").length;
  const matched      = matches.filter(m => m.btTrade).length;
  const agreed       = matches.filter(m => m.agrees).length;
  const directionAcc = matched ? (agreed / matched) * 100 : 0;
  const liveWins     = matches.filter(m => (m.pnlPct ?? 0) > 0).length;
  const liveLosses   = matches.filter(m => (m.pnlPct ?? 0) <= 0 && m.btTrade).length;
  const liveWR       = matched ? (liveWins / matched) * 100 : 0;
  const liveAvgPnl   = matched ? matches.reduce((s, m) => s + (m.pnlPct ?? 0), 0) / matched : 0;
  const btWR         = r ? r.winRate : 0;
  const btAvg        = r ? r.avgTradePct : 0;
  const wrDelta      = liveWR - btWR;
  const avgDelta     = liveAvgPnl - btAvg;

  // Score correlation between live signals and matched BT PnL
  const liveScores   = matches.filter(m => m.btTrade).map(m => m.liveScore);
  const btPnls       = matches.filter(m => m.btTrade).map(m => m.pnlPct ?? 0);
  const scoreCorr    = pearsonR(liveScores, btPnls);

  // Alpha decay
  const alphaData    = useMemo(() => alphaDecayAnalysis(matches), [matches]);
  const scoreDist    = useMemo(() =>
    r ? scoreDistributionComparison(matches, r.trades) : [], [matches, r]);

  // Overlay equity curves (BT equity + live PnL timeline)
  const equityOverlay = useMemo(() => {
    if (!r) return [];
    const btPts = r.equity.map((e, i) => ({ i, bt: e.eq, live: null as number | null }));
    // Map live matched signal PnLs onto index scale
    let liveCum = 0;
    const livePts = matches
      .filter(m => m.btTrade)
      .sort((a, b) => a.liveT - b.liveT)
      .map((m, idx) => {
        liveCum += m.pnlPct ?? 0;
        return { i: idx, live: liveCum };
      });
    // Merge: show both on index scale
    const maxN = Math.max(btPts.length, livePts.length);
    return Array.from({ length: maxN }, (_, i) => ({
      i,
      bt: btPts[i]?.bt ?? null,
      live: livePts[i]?.live ?? null,
    }));
  }, [r, matches]);

  // Scatter: live score vs BT PnL
  const scatterData = useMemo(() =>
    matches.filter(m => m.btTrade).map(m => ({
      score: m.liveScore, pnl: m.pnlPct ?? 0, side: m.side,
    })), [matches]);

  // Inject BT trades as live signals so the compare page has data immediately
  const injectBTAsLive = () => {
    if (!r) return;
    for (const trade of r.trades) {
      pushLiveSignal({
        t: trade.entryTime,
        symbol: r.symbol,
        interval: r.interval,
        score: trade.score,
        side: trade.side as "long" | "short",
        confidence: trade.confidence,
        mid: trade.entry,
      });
    }
    setInjected(true);
  };

  // Compute plain-language assessment
  const assessment = useMemo(() => {
    if (!r) return null;
    const trades = r.trades.length;
    if (trades < 5) return { level: "warn" as const, text: "عدد الصفقات أقل من 5 — الباك تيست يحتاج بيانات أكثر (زِد عدد الشموع)." };
    if (r.winRate < 40) return { level: "bad" as const, text: `نسبة الفوز ${r.winRate.toFixed(0)}% ضعيفة — جرّب التشخيص التلقائي أو غيّر minScore.` };
    if (r.profitFactor < 1.0) return { level: "bad" as const, text: `معامل الربح ${r.profitFactor.toFixed(2)} < 1 — الاستراتيجية خاسرة على المدى البعيد. غيّر الإعدادات.` };
    if (r.maxDrawdownPct > 20) return { level: "warn" as const, text: `أقصى تراجع ${r.maxDrawdownPct.toFixed(1)}% مرتفع — الاستراتيجية تحتاج تضييق ستوب أو تقليل حجم الصفقة.` };
    if (r.profitFactor >= 1.5 && r.winRate >= 50) return { level: "ok" as const, text: `ممتاز — PF ${r.profitFactor.toFixed(2)} × WR ${r.winRate.toFixed(0)}% × MaxDD ${r.maxDrawdownPct.toFixed(1)}%. الاستراتيجية قوية تاريخياً.` };
    return { level: "ok" as const, text: `الاستراتيجية مقبولة — PF ${r.profitFactor.toFixed(2)} × WR ${r.winRate.toFixed(0)}%. بإمكانك تحسينها بالتشخيص التلقائي.` };
  }, [r]);

  const noData = !r;

  return (
    <div dir="rtl" className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <header className="border-b border-border bg-card/40 backdrop-blur sticky top-0 z-30">
        <div className="container py-3 flex items-center justify-between gap-3 flex-wrap">
          <h1 className="text-lg md:text-xl font-bold flex items-center gap-2">
            <GitCompare className="size-5 text-primary" />
            <span className="text-primary">WhaleEye</span> / Live vs Backtest
          </h1>
          <div className="flex gap-2">
            <Link to="/backtest" className="text-xs px-3 py-1.5 rounded border border-border hover:bg-card">
              تشغيل Backtest
            </Link>
            <Link to="/" className="text-xs px-3 py-1.5 rounded border border-border hover:bg-card inline-flex items-center gap-1">
              <ArrowLeft className="size-3" /> العودة
            </Link>
          </div>
        </div>
      </header>

      <main className="container py-4 space-y-4">
        {/* Guide */}
        <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4">
          <button onClick={() => setShowGuide(v => !v)}
            className="flex items-center gap-2 text-sm font-semibold text-primary w-full">
            <BookOpen className="size-4" />
            ما هذه الصفحة؟ — مقارنة الإشارات الحيّة بالباك تيست
            <span className="mr-auto text-[11px] mono opacity-60 flex items-center gap-0.5">
              {showGuide ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />}
              {showGuide ? "إخفاء" : "إظهار"}
            </span>
          </button>
          {showGuide && (
            <div className="mt-3 grid md:grid-cols-3 gap-3 text-[12px] leading-relaxed">
              <InfoCard title="الفائدة">
                تكشف بدقّة <strong>أين تأتي العشوائية</strong> في أداء المحرّك المؤسساتي:
                هل المنطق نفسه ضعيف؟ أم أن الانحراف يحدث فقط على البيانات الحيّة (تأخر، سيولة، أخبار)؟
                الآن محرك الباك تيست يستخدم نفس معادلة الدرجة المؤسساتية.
              </InfoCard>
              <InfoCard title="آلية المطابقة الجديدة">
                يأخذ آخر سجل إشارات حيّة ضمن نافذة آخر Backtest، ويقابل كل إشارة بأقرب صفقة
                زمنياً مع أفضلية لتوافق الاتجاه (لا مجرد قرب زمني). النافذة تكيّفية حسب الفريم الزمني.
              </InfoCard>
              <InfoCard title="المقاييس الجديدة">
                <ul className="space-y-0.5">
                  <li>• منحنى الرأسمال (Live vs BT) بنفس المقياس</li>
                  <li>• تحليل الألفا حسب شدة الإشارة</li>
                  <li>• تضخم الدرجة: هل الإشارات الحيّة مركّزة؟</li>
                  <li>• ارتباط Score الحي مع PnL الباك تيست (R)</li>
                </ul>
              </InfoCard>
            </div>
          )}
        </div>

        {noData && (
          <div className="rounded-2xl border border-dashed border-border p-10 text-center space-y-3">
            <div className="text-sm text-muted-foreground">لا توجد نتائج باك تيست محفوظة بعد.</div>
            <Link to="/backtest"
              className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded text-sm font-semibold hover:opacity-90">
              <Zap className="size-4" /> اذهب لتشغيل Backtest أولاً
            </Link>
          </div>
        )}

        {r && (
          <>
            {/* Assessment banner */}
            {assessment && (
              <div className={cn(
                "rounded-2xl border px-4 py-3 flex items-start gap-3",
                assessment.level === "ok" ? "border-bull/40 bg-bull/5"
                : assessment.level === "warn" ? "border-gold/40 bg-gold/5"
                : "border-bear/40 bg-bear/5"
              )}>
                {assessment.level === "ok"
                  ? <CheckCircle2 className="size-5 text-bull mt-0.5 shrink-0" />
                  : assessment.level === "warn"
                  ? <AlertTriangle className="size-5 text-gold mt-0.5 shrink-0" />
                  : <XCircle className="size-5 text-bear mt-0.5 shrink-0" />
                }
                <div>
                  <div className="text-[11px] text-muted-foreground uppercase tracking-wider mb-0.5">تقييم الاستراتيجية</div>
                  <div className="text-sm font-medium">{assessment.text}</div>
                </div>
              </div>
            )}

            {/* Context bar */}
            <div className="rounded-2xl border border-border bg-card/40 p-3 text-[11px] mono text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 items-center">
              <span>الزوج: <span className="text-foreground font-semibold">{r.symbol}</span></span>
              <span>الفريم: <span className="text-foreground font-semibold">{r.interval}</span></span>
              <span>BT: {new Date(r.fromTime).toLocaleString("en-GB")} → {new Date(r.toTime).toLocaleString("en-GB")}</span>
              <span>إشارات حيّة: <span className="text-foreground">{liveSignals}</span></span>
              <span>مطابقة: <span className={cn("font-semibold", matched >= 5 ? "text-bull" : "text-gold")}>{matched}/{liveSignals}</span></span>
              <span>صفقات BT: <span className="text-foreground">{r.trades.length}</span></span>
            </div>

            {/* Inject BT as Live — main CTA when no live signals */}
            {liveSignals < 5 && r.trades.length > 0 && (
              <div className="rounded-2xl border border-primary/30 bg-primary/5 p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <RefreshCw className="size-5 text-primary mt-0.5 shrink-0" />
                  <div>
                    <div className="font-semibold text-sm">الإشارات الحيّة فارغة أو غير كافية</div>
                    <div className="text-[12px] text-muted-foreground mt-0.5 leading-relaxed">
                      الإشارات الحيّة تتراكم فقط عندما تكون اللوحة الرئيسية مفتوحة.
                      لرؤية المقارنة <strong>فوراً</strong>، يمكنك حقن صفقات الباك تيست ({r.trades.length} صفقة)
                      كإشارات حيّة اصطناعية — وستجد المقارنة الكاملة في الحال.
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={injectBTAsLive}
                    disabled={injected}
                    className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded text-sm font-semibold hover:opacity-90 disabled:opacity-50 transition-all"
                  >
                    {injected ? <CheckCircle2 className="size-4" /> : <Zap className="size-4" />}
                    {injected ? `تم الحقن (${r.trades.length} إشارة)` : `حقن ${r.trades.length} صفقة كإشارات حيّة`}
                  </button>
                  {injected && (
                    <span className="text-[11px] text-bull flex items-center gap-1">
                      <CheckCircle2 className="size-3.5" /> مكتمل — المقارنة أدناه تعكس الآن نتائج الباك تيست
                    </span>
                  )}
                </div>
                {!injected && (
                  <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                    <Clock className="size-3" />
                    للمقارنة الحقيقية بين Live والباك تيست: افتح اللوحة الرئيسية وانتظر تراكم الإشارات الحيّة طبيعياً.
                  </div>
                )}
              </div>
            )}

            {/* Warning: low sample size */}
            {matched < 5 && liveSignals > 0 && (
              <div className="rounded-xl border border-gold/40 bg-gold/10 text-gold text-[12px] px-4 py-2.5 flex items-start gap-2">
                <AlertTriangle className="size-4 shrink-0 mt-0.5" />
                <span>
                  <strong>عينة صغيرة ({matched} إشارة مطابقة).</strong> النتائج الإحصائية غير موثوقة.
                  دع اللوحة تعمل لفترة أطول، أو استخدم زر الحقن أعلاه.
                </span>
              </div>
            )}

            {/* Direction accuracy warning */}
            {directionAcc < 50 && matched >= 8 && (
              <div className="rounded-xl border border-bear/40 bg-bear/10 text-bear text-[12px] px-4 py-2.5 flex items-start gap-2">
                <AlertTriangle className="size-4 shrink-0 mt-0.5" />
                <span>
                  دقة الاتجاه {directionAcc.toFixed(1)}% &lt; 50% — منطق الإشارة الحيّة ينحرف عن الباك تيست.
                  راجع جودة البيانات، فلتر الثقة، أو نافذة الفريم.
                </span>
              </div>
            )}

            {/* Main KPIs */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              <Kpi label="دقة الاتجاه" value={`${directionAcc.toFixed(1)}%`}
                sub={`${agreed}/${matched} متوافق`}
                tone={directionAcc >= 70 ? "ok" : directionAcc >= 50 ? "warn" : "bad"} />
              <Kpi label="WinRate Live / BT"
                value={`${liveWR.toFixed(1)}% / ${btWR.toFixed(1)}%`}
                delta={wrDelta} suffix="%" tone="neutral" />
              <Kpi label="متوسط PnL Live / BT"
                value={`${liveAvgPnl >= 0 ? "+" : ""}${liveAvgPnl.toFixed(2)}% / ${btAvg >= 0 ? "+" : ""}${btAvg.toFixed(2)}%`}
                delta={avgDelta} suffix="%" tone="neutral" />
              <Kpi label="ارتباط Score ↔ PnL"
                value={`R = ${scoreCorr >= 0 ? "+" : ""}${scoreCorr.toFixed(3)}`}
                sub={matched >= 5 ? `على ${matched} صفقة` : "عينة صغيرة"}
                tone={scoreCorr >= 0.4 ? "ok" : scoreCorr >= 0.15 ? "warn" : scoreCorr >= 0 ? "neutral" : "bad"} />
            </div>

            {/* Secondary KPIs */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              <Kpi label="Sharpe BT"
                value={r.sharpeRatio.toFixed(2)}
                tone={r.sharpeRatio >= 1 ? "ok" : r.sharpeRatio >= 0.5 ? "warn" : "bad"} />
              <Kpi label="Sortino BT"
                value={r.sortinoRatio.toFixed(2)}
                tone={r.sortinoRatio >= 1.5 ? "ok" : r.sortinoRatio >= 0.8 ? "warn" : "bad"} />
              <Kpi label="Calmar BT"
                value={r.calmarRatio.toFixed(2)}
                tone={r.calmarRatio >= 0.5 ? "ok" : r.calmarRatio >= 0.2 ? "warn" : "bad"} />
              <Kpi label="Profit Factor BT"
                value={isFinite(r.profitFactor) ? r.profitFactor.toFixed(2) : "∞"}
                tone={r.profitFactor >= 1.5 ? "ok" : r.profitFactor >= 1.1 ? "warn" : "bad"} />
              <Kpi label="MaxDD BT"
                value={`${r.maxDrawdownPct.toFixed(2)}%`}
                tone={r.maxDrawdownPct < 5 ? "ok" : r.maxDrawdownPct < 15 ? "warn" : "bad"} />
            </div>

            {/* Charts row */}
            {matched >= 3 && (
              <div className="grid md:grid-cols-2 gap-4">
                {/* Equity overlay */}
                <ChartCard
                  title="منحنى الرأسمال التراكمي"
                  subtitle="BT (أزرق) مقابل الإشارات الحيّة المطابقة (برتقالي)"
                >
                  <ResponsiveContainer width="100%" height={220}>
                    <LineChart data={equityOverlay} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                      <XAxis dataKey="i" hide />
                      <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`} />
                      <Tooltip
                        contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 11 }}
                        formatter={(v: number, name: string) => [`${v >= 0 ? "+" : ""}${v?.toFixed(2)}%`, name === "bt" ? "Backtest" : "Live"]}
                      />
                      <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" />
                      <Line type="monotone" dataKey="bt" stroke="#6366f1" strokeWidth={2} dot={false} name="bt" connectNulls />
                      <Line type="monotone" dataKey="live" stroke="#f59e0b" strokeWidth={2} dot={false} name="live" connectNulls />
                    </LineChart>
                  </ResponsiveContainer>
                </ChartCard>

                {/* Alpha decay by score bucket */}
                {alphaData.length >= 2 && (
                  <ChartCard
                    title="الألفا حسب شدة الإشارة"
                    subtitle="متوسط PnL (%) للإشارات المطابقة مجمّعة حسب درجة المؤسسي"
                  >
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={alphaData} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                        <XAxis dataKey="bucket" tick={{ fontSize: 10 }} />
                        <YAxis tick={{ fontSize: 10 }} tickFormatter={v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`} />
                        <Tooltip
                          contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 11 }}
                          formatter={(v: number, name: string) => [
                            `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`,
                            name === "avgPnl" ? "متوسط PnL" : name,
                          ]}
                        />
                        <ReferenceLine y={0} stroke="rgba(255,255,255,0.3)" />
                        <Bar dataKey="avgPnl" name="avgPnl"
                          fill="#6366f1" radius={[4, 4, 0, 0]}
                          label={{ position: "top", fontSize: 9, fill: "rgba(255,255,255,0.5)" }} />
                      </BarChart>
                    </ResponsiveContainer>
                  </ChartCard>
                )}
              </div>
            )}

            {/* Score distribution comparison */}
            {(scoreDist.length > 0) && (
              <ChartCard
                title="توزيع الدرجات: Backtest (أزرق) مقابل إشارات حيّة (برتقالي)"
                subtitle="كلما تطابق التوزيعان كلما كان المحرّك منتظمًا"
              >
                <ResponsiveContainer width="100%" height={180}>
                  <BarChart data={scoreDist} margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="bucket" tick={{ fontSize: 10 }} />
                    <YAxis tick={{ fontSize: 10 }} allowDecimals={false} />
                    <Tooltip
                      contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 11 }}
                    />
                    <Bar dataKey="bt" name="Backtest" fill="#6366f1" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="live" name="Live" fill="#f59e0b" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            )}

            {/* Score vs PnL scatter (if enough data) */}
            {scatterData.length >= 5 && (
              <ChartCard
                title="ارتباط Score الحي مع PnL الباك تيست"
                subtitle={`R = ${scoreCorr >= 0 ? "+" : ""}${scoreCorr.toFixed(3)} — كلما اقترب من +1 كلما كانت الإشارة أكثر ارتباطًا بالأداء`}
              >
                <ResponsiveContainer width="100%" height={200}>
                  <ScatterChart margin={{ left: 0, right: 0, top: 4, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="score" name="Score" tick={{ fontSize: 10 }} label={{ value: "Score المؤسسي", position: "insideBottom", offset: -2, fontSize: 10 }} />
                    <YAxis dataKey="pnl" name="PnL%" tick={{ fontSize: 10 }} tickFormatter={v => `${v >= 0 ? "+" : ""}${v.toFixed(1)}%`} />
                    <ZAxis range={[30, 30]} />
                    <Tooltip
                      contentStyle={{ background: "var(--card)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 11 }}
                      formatter={(v: number, name: string) => [name === "pnl" ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : v, name === "score" ? "Score" : "PnL"]}
                    />
                    <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" />
                    <Scatter
                      data={scatterData.filter(d => d.side === "long")}
                      fill="#22c55e" fillOpacity={0.7} name="Long" />
                    <Scatter
                      data={scatterData.filter(d => d.side === "short")}
                      fill="#ef4444" fillOpacity={0.7} name="Short" />
                  </ScatterChart>
                </ResponsiveContainer>
              </ChartCard>
            )}

            {/* Matched signals table */}
            <div className="rounded-2xl border border-border bg-card/40 overflow-hidden">
              <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                <span className="text-sm font-semibold">جدول المطابقة التفصيلي</span>
                <span className="text-[11px] mono text-muted-foreground">{matches.length} إشارة</span>
              </div>
              <div className="overflow-x-auto max-h-[480px]">
                <table className="w-full text-[11px] mono">
                  <thead className="sticky top-0 bg-card/90 backdrop-blur text-muted-foreground text-right">
                    <tr>
                      <th className="px-2 py-2">وقت Live</th>
                      <th className="px-2 py-2">اتجاه</th>
                      <th className="px-2 py-2">Score</th>
                      <th className="px-2 py-2">ثقة%</th>
                      <th className="px-2 py-2">سعر</th>
                      <th className="px-2 py-2">Δ دقيقة</th>
                      <th className="px-2 py-2">صفقة BT</th>
                      <th className="px-2 py-2">اتجاه BT</th>
                      <th className="px-2 py-2">Score BT</th>
                      <th className="px-2 py-2">PnL BT</th>
                      <th className="px-2 py-2">سبب الخروج</th>
                      <th className="px-2 py-2">تطابق</th>
                    </tr>
                  </thead>
                  <tbody>
                    {matches.slice(0, tableLimit).map((m, i) => (
                      <tr key={i} className="border-t border-border/60 hover:bg-card/60">
                        <td className="px-2 py-1.5">{new Date(m.liveT).toLocaleTimeString("en-GB")}</td>
                        <td className={cn("px-2 py-1.5 font-semibold", m.side === "long" ? "text-bull" : "text-bear")}>
                          {m.side === "long" ? "▲ L" : "▼ S"}
                        </td>
                        <td className={cn("px-2 py-1.5", Math.abs(m.liveScore) >= 60 ? "text-primary font-bold" : "")}>
                          {m.liveScore >= 0 ? "+" : ""}{m.liveScore}
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground">{m.liveConfidence}%</td>
                        <td className="px-2 py-1.5">{m.liveMid.toFixed(4)}</td>
                        <td className="px-2 py-1.5 text-muted-foreground">
                          {m.timeDeltaMin != null ? `${m.timeDeltaMin.toFixed(0)}d` : "—"}
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground">
                          {m.btTrade ? new Date(m.btTrade.entryTime).toLocaleTimeString("en-GB") : "—"}
                        </td>
                        <td className={cn("px-2 py-1.5",
                          m.btTrade?.side === "long" ? "text-bull" : m.btTrade?.side === "short" ? "text-bear" : "text-muted-foreground")}>
                          {m.btTrade ? (m.btTrade.side === "long" ? "▲ L" : "▼ S") : "—"}
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground">
                          {m.btTrade ? `${m.btTrade.score >= 0 ? "+" : ""}${m.btTrade.score}` : "—"}
                        </td>
                        <td className={cn("px-2 py-1.5 font-semibold",
                          (m.pnlPct ?? 0) > 0 ? "text-bull" : m.btTrade ? "text-bear" : "text-muted-foreground")}>
                          {m.btTrade ? `${m.pnlPct! >= 0 ? "+" : ""}${m.pnlPct!.toFixed(2)}%` : "—"}
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground text-[10px]">
                          {m.btTrade?.exitReason ?? "—"}
                        </td>
                        <td className={cn("px-2 py-1.5 font-bold text-center",
                          m.agrees == null ? "text-muted-foreground"
                          : m.agrees ? "text-bull" : "text-bear")}>
                          {m.agrees == null ? "—" : m.agrees ? "✓" : "✗"}
                        </td>
                      </tr>
                    ))}
                    {matches.length === 0 && (
                      <tr>
                        <td colSpan={12} className="text-center py-8 text-muted-foreground">
                          لا توجد إشارات حيّة ضمن نافذة الباك تيست بعد.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              {matches.length > tableLimit && (
                <div className="px-4 py-2 border-t border-border text-center">
                  <button
                    onClick={() => setTableLimit(l => l + 20)}
                    className="text-[11px] text-primary hover:underline"
                  >
                    تحميل {Math.min(20, matches.length - tableLimit)} إشارة إضافية ▼
                  </button>
                </div>
              )}
            </div>
          </>
        )}
      </main>
      <footer className="border-t border-border mt-8">
        <Signature />
      </footer>
    </div>
  );
}

// ── Sub-components ──────────────────────────────────────────────────────────────
function InfoCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card/40 p-3">
      <div className="font-semibold text-sm text-primary mb-1 flex items-center gap-1.5">
        <Info className="size-3.5" /> {title}
      </div>
      <div className="text-foreground/85 text-[12px] leading-relaxed">{children}</div>
    </div>
  );
}

function EmptyState({ msg }: { msg: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
      {msg}
    </div>
  );
}

function Kpi({ label, value, tone = "neutral", delta, suffix = "", sub }: {
  label: string; value: string; tone?: "ok" | "warn" | "bad" | "neutral";
  delta?: number; suffix?: string; sub?: string;
}) {
  const cls =
    tone === "ok"  ? "text-bull border-bull/30 bg-bull/5"
    : tone === "warn" ? "text-gold border-gold/30 bg-gold/5"
    : tone === "bad"  ? "text-bear border-bear/30 bg-bear/5"
    : "text-foreground border-border bg-card/40";
  return (
    <div className={cn("rounded-xl border px-3 py-2.5", cls)}>
      <div className="text-[10px] opacity-70 mb-0.5">{label}</div>
      <div className="text-sm font-bold mono leading-tight">{value}</div>
      {sub && <div className="text-[10px] opacity-60 mt-0.5">{sub}</div>}
      {delta != null && Number.isFinite(delta) && (
        <div className={cn("text-[10px] mono mt-0.5",
          delta > 0 ? "text-bull" : delta < 0 ? "text-bear" : "text-muted-foreground")}>
          Δ Live − BT: {delta >= 0 ? "+" : ""}{delta.toFixed(2)}{suffix}
        </div>
      )}
    </div>
  );
}

function ChartCard({ title, subtitle, children }: {
  title: string; subtitle?: string; children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card/40 p-4">
      <div className="mb-3">
        <div className="text-sm font-semibold">{title}</div>
        {subtitle && <div className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</div>}
      </div>
      {children}
    </div>
  );
}
