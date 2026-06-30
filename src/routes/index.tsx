// index.tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  SYMBOLS,
  TIMEFRAMES,
  type Interval,
  fetchKlines,
  fmtPct,
  fmtPrice,
  fmtUsd,
} from "@/lib/binance";
import { useLiveDepth, useLiveTicker } from "@/hooks/useBinance";
import { useCVD } from "@/hooks/useCVD";
import { useOFI } from "@/hooks/useOFI";
import { CVDPanel } from "@/components/trading/CVDPanel";
import { OFIHeatmap } from "@/components/trading/OFIHeatmap";
import { detectSMC } from "@/lib/smc";
import { SMCPanel } from "@/components/trading/SMCPanel";
import {
  computeBookMetrics,
  computePriceMetrics,
  detectLiquidityZones,
  detectWalls,
  institutionalScoreV2,
} from "@/lib/analysis";
import { SymbolBar } from "@/components/trading/SymbolBar";
import { OrderBookHeatmap } from "@/components/trading/OrderBookHeatmap";
import { WallsPanel } from "@/components/trading/WallsPanel";
import { LiquidityZonesPanel } from "@/components/trading/LiquidityZonesPanel";
import { InstitutionalPanel } from "@/components/trading/InstitutionalPanel";
import { CandleChart } from "@/components/trading/CandleChart";
import { DataQualityBar, QualityBlockNotice } from "@/components/trading/DataQualityBar";
import { QualityHistoryChart, useQualityBlockDecision } from "@/components/trading/QualityHistoryChart";
import { WallSettingsPanel } from "@/components/trading/WallSettingsPanel";
import { AlertSettingsPanel } from "@/components/trading/AlertSettingsPanel";
import { AlertsCenter } from "@/components/trading/AlertsCenter";
import { QualityAlertPanel } from "@/components/trading/QualityAlertPanel";
import { useQualitySlopeAlert } from "@/hooks/useQualitySlopeAlert";
import { useSession } from "@/lib/session-store";
import { cn } from "@/lib/utils";
import { RLAgentPanel } from "@/components/trading/RLAgentPanel";
import { Radio, Zap, BookOpen, Crosshair, LineChart, FileText, Sliders, FlaskConical, AlertTriangle, GitCompare, Activity } from "lucide-react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "WhaleEye — منصة التحليل المؤسساتي للعملات الرقمية" },
      {
        name: "description",
        content:
          "خوارزمية تحليل مؤسساتية لدفتر الأوامر، الجدران السعرية، ومناطق صيد الستوبات لأهم العملات الرقمية على Binance.",
      },
    ],
  }),
  component: Dashboard,
});

function Dashboard() {
  const [symbol, setSymbol] = useState<string>(SYMBOLS[0]);
  const [interval, setInterval] = useState<Interval>("1h");
  const [showSettings, setShowSettings] = useState(false);

  return (
    <div className="min-h-screen text-foreground scan-line">
      <Header />
      <main className="max-w-[1600px] mx-auto px-4 md:px-6 pb-12 space-y-5">
        <SymbolBar active={symbol} onSelect={setSymbol} />

        <div className="flex items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1">
            {TIMEFRAMES.map((tf) => (
              <button
                key={tf.value}
                onClick={() => setInterval(tf.value)}
                className={cn(
                  "text-[11px] px-2.5 py-1 rounded-md mono font-semibold border transition",
                  interval === tf.value
                    ? "bg-primary text-primary-foreground border-primary"
                    : "border-border text-muted-foreground hover:text-foreground hover:border-accent"
                )}
              >
                {tf.label}
              </button>
            ))}
          </div>
          <button
            onClick={() => setShowSettings((v) => !v)}
            className={cn(
              "text-[11px] mono px-2.5 py-1.5 rounded-md border flex items-center gap-1.5 transition",
              showSettings
                ? "border-primary/50 bg-primary/15 text-primary"
                : "border-border bg-card/50 text-muted-foreground hover:text-foreground"
            )}
          >
            <Sliders className="size-3.5" /> الإعدادات
          </button>
        </div>

        <DataQualityBar symbol={symbol} />
        <QualityHistoryChart symbol={symbol} />

        {showSettings && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <WallSettingsPanel />
            <AlertSettingsPanel />
            <div className="lg:col-span-2"><QualityAlertPanel /></div>
          </div>
        )}

        <SymbolView symbol={symbol} interval={interval} onInterval={setInterval} />
      </main>
      <Footer />
    </div>
  );
}

function Header() {
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/70 backdrop-blur-xl">
      <div className="max-w-[1600px] mx-auto px-4 md:px-6 py-3 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="size-10 rounded-xl bg-gradient-to-br from-primary to-whale flex items-center justify-center glow-neon">
            <Zap className="size-5 text-primary-foreground" />
          </div>
          <div>
            <div className="font-extrabold text-lg leading-tight tracking-tight">
              WhaleEye <span className="text-primary">/ عين الحوت</span>
            </div>
            <div className="text-[11px] text-muted-foreground mono">
              Institutional Order-Flow Engine · Binance Live
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="hidden sm:flex items-center gap-2 text-[11px] mono text-muted-foreground">
            <Radio className="size-3 text-bull ticker-pulse" />
            البث المباشر مفعل
          </div>
          <Link
            to="/backtest"
            className="text-[11px] mono px-2.5 py-1.5 rounded-md border border-border bg-card/60 hover:bg-card flex items-center gap-1.5"
          >
            <FlaskConical className="size-3.5" /> Backtest
          </Link>
          <Link
            to="/compare"
            className="text-[11px] mono px-2.5 py-1.5 rounded-md border border-border bg-card/60 hover:bg-card flex items-center gap-1.5"
          >
            <GitCompare className="size-3.5" /> Live vs Backtest
          </Link>
          <Link
            to="/report"
            className="text-[11px] mono px-2.5 py-1.5 rounded-md border border-border bg-card/60 hover:bg-card flex items-center gap-1.5"
          >
            <FileText className="size-3.5" /> التقرير
          </Link>
          <div className="relative">
            <AlertsCenter />
          </div>
        </div>
      </div>
    </header>
  );
}

import { Signature } from "@/components/ui/Signature";

function Footer() {
  return (
    <footer className="border-t border-border mt-8">
      <div className="max-w-[1600px] mx-auto px-4 md:px-6 py-6 text-center">
        <Signature />
        <div className="text-[11px] text-muted-foreground mt-2">
          البيانات من Binance Public WebSocket · هذه أداة تحليلية ولا تُعد توصية
          استثمارية · إدارة المخاطر مسؤوليتك
        </div>
      </div>
    </footer>
  );
}

function SymbolView({
  symbol,
  interval,
  onInterval,
}: {
  symbol: string;
  interval: Interval;
  onInterval: (i: Interval) => void;
}) {
  const { book, connected } = useLiveDepth(symbol);
  const { ticker, flash } = useLiveTicker(symbol);

  // Compute mid directly from book (can't use metrics here — hooks must precede useMemo)
  const rawMid = book
    ? ((book.bids[0]?.price ?? 0) + (book.asks[0]?.price ?? 0)) / 2
    : 0;
  const cvdStats = useCVD(book, rawMid);
  const ofiStats = useOFI(book, rawMid);
  const wallSettings = useSession((s) => s.wallSettings);
  const quality = useSession((s) => s.quality.bySymbol[symbol]);
  const alertSettings = useSession((s) => s.alertSettings);
  const blockDecision = useQualityBlockDecision(symbol);
  useQualitySlopeAlert(symbol);

  const pushAlertRef = useRef(useSession.getState().pushAlert);
  const saveSnapshotRef = useRef(useSession.getState().saveSnapshot);
  const pushLiveSignalRef = useRef(useSession.getState().pushLiveSignal);
  useEffect(() => {
    pushAlertRef.current = useSession.getState().pushAlert;
    saveSnapshotRef.current = useSession.getState().saveSnapshot;
    pushLiveSignalRef.current = useSession.getState().pushLiveSignal;
  });

  const chartContainerRef = useRef<HTMLDivElement>(null);

  const { data: klines } = useQuery({
    queryKey: ["klines", symbol, interval],
    queryFn: () => fetchKlines(symbol, interval, 200),
    refetchInterval: 15000,
  });

  const metrics = useMemo(() => (book ? computeBookMetrics(book, 50) : null), [book]);
  const walls = useMemo(
    () =>
      book && metrics
        ? detectWalls(book, metrics.mid, {
            depth: wallSettings.depth,
            zThreshold: wallSettings.zThreshold,
            percentile: wallSettings.percentile,
            absoluteUsd: wallSettings.absoluteUsd,
            method: wallSettings.method,
            maxPerSide: wallSettings.maxPerSide,
          })
        : null,
    [book, metrics, wallSettings]
  );
  const priceMetrics = useMemo(
    () => (klines ? computePriceMetrics(klines) : null),
    [klines]
  );
  const zones = useMemo(
    () => (klines && metrics ? detectLiquidityZones(klines, metrics.mid, { walls: walls ?? undefined }) : []),
    [klines, metrics, walls]
  );
  const smcAnalysis = useMemo(
    () => (klines ? detectSMC(klines) : null),
    [klines]
  );
  const prevScoreRef = useRef<number | undefined>(undefined);
  const verdict = useMemo(() => {
    if (!metrics || !walls || !priceMetrics || !klines) return null;
    const v = institutionalScoreV2(metrics, walls, priceMetrics, klines, {
      prevScore: prevScoreRef.current,
      emaAlpha: 0.3,
    });
    prevScoreRef.current = v.score;
    return v;
  }, [metrics, walls, priceMetrics, klines]);

  // ─── Alerts engine ────────────────────────────────────────────────────
  useEffect(() => {
    if (!walls || !metrics) return;
    const big = [...walls.bidWalls, ...walls.askWalls]
      .filter((w) => w.usd >= alertSettings.wallUsdThreshold)
      .sort((a, b) => b.usd - a.usd)[0];
    if (big) {
      pushAlertRef.current({
        symbol,
        type: "wall",
        severity: big.usd > alertSettings.wallUsdThreshold * 3 ? "critical" : "warn",
        title: `جدار ${big.side === "bid" ? "شراء قوي" : "بيع قوي"}`,
        detail: `سعر ${fmtPrice(big.price)} · ${fmtUsd(big.usd)} · ${big.distancePct.toFixed(2)}% من السعر`,
        price: big.price,
      });
    }
    if (Math.abs(metrics.imbalance) >= alertSettings.imbalanceThreshold) {
      pushAlertRef.current({
        symbol,
        type: "imbalance",
        severity: Math.abs(metrics.imbalance) > 0.7 ? "critical" : "warn",
        title: `اختلال دفتر ${metrics.imbalance > 0 ? "شرائي" : "بيعي"}`,
        detail: `${(metrics.imbalance * 100).toFixed(1)}% · شراء ${fmtUsd(metrics.bidUsd)} / بيع ${fmtUsd(metrics.askUsd)}`,
        price: metrics.mid,
      });
    }
  }, [walls, metrics, alertSettings.wallUsdThreshold, alertSettings.imbalanceThreshold, symbol]);

  useEffect(() => {
    if (!zones.length) return;
    for (const z of zones) {
      const prob = (z as any).probability ?? (z as any).strength ?? 0;
      const p = typeof prob === "number" && prob <= 1 ? prob * 100 : prob;
      if (p >= alertSettings.stopHuntProbThreshold) {
        pushAlertRef.current({
          symbol,
          type: "stop_hunt",
          severity: p >= 85 ? "critical" : "warn",
          title: `منطقة استهداف ستوبات`,
          detail: `${(z as any).type ?? "zone"} · ${fmtPrice((z as any).price ?? (z as any).level ?? 0)} · احتمالية ${p.toFixed(0)}%`,
          price: (z as any).price ?? (z as any).level,
        });
      }
    }
  }, [zones, alertSettings.stopHuntProbThreshold, symbol]);

  // ─── Auto-save snapshot + log live signal ─────────────────────────────
  const latestRef = useRef({
    symbol, interval, metrics, walls, zones, priceMetrics,
    verdict, ticker, wallSettings, quality,
  });
  latestRef.current = {
    symbol, interval, metrics, walls, zones, priceMetrics,
    verdict, ticker, wallSettings, quality,
  };

  useEffect(() => {
    const id = setInterval(() => {
      const L = latestRef.current;
      if (!L.metrics || !L.walls || !L.priceMetrics || !L.verdict) return;
      saveSnapshotRef.current({
        symbol: L.symbol,
        interval: L.interval,
        capturedAt: Date.now(),
        mid: L.metrics.mid,
        ticker: L.ticker,
        metrics: L.metrics,
        walls: L.walls,
        zones: L.zones,
        priceMetrics: L.priceMetrics,
        verdict: L.verdict,
        wallSettings: L.wallSettings,
        quality: L.quality ?? null,
        chartImage: null,
      });
      pushLiveSignalRef.current({
        t: Date.now(),
        symbol: L.symbol,
        interval: L.interval,
        score: L.verdict.score,
        side: (L.verdict as any).targets?.side ?? "none",
        confidence: (L.verdict as any).confidence ?? 0,
        mid: L.metrics.mid,
      });
    }, 5000);
    return () => clearInterval(id);
  }, []);

  if (!book || !metrics) {
    return (
      <div className="space-y-5">
        <RLAgentPanel verdict={verdict as any} metrics={metrics} />
        <LoadingSkeleton symbol={symbol} />
      </div>
    );
  }

  const qScore = quality?.score ?? 100;
  const blocked = blockDecision.blocked;

  const up = (ticker?.changePct ?? 0) >= 0;

  return (
    <div className="space-y-5">
      {/* RL Agent — always visible at top */}
      <RLAgentPanel verdict={verdict as any} metrics={metrics} />

      {/* Symbol header card */}
      <div className="rounded-2xl border border-border glass p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <span className="font-extrabold text-3xl tracking-tight">
                {symbol.replace("USDT", "")}
                <span className="text-muted-foreground text-lg">/USDT</span>
              </span>
              <span
                className={cn(
                  "text-[10px] mono uppercase tracking-wider px-2 py-0.5 rounded border",
                  connected
                    ? "border-bull/40 text-bull bg-bull/10"
                    : "border-muted text-muted-foreground"
                )}
              >
                {connected ? "● مباشر" : "○ يتصل..."}
              </span>
              <span className="text-[10px] mono px-2 py-0.5 rounded border border-primary/30 text-primary bg-primary/10">
                {interval.toUpperCase()}
              </span>
            </div>
            <div
              className={cn(
                "mt-1 mono text-5xl font-bold tracking-tight",
                up ? "text-bull" : "text-bear",
                flash === "up" && "flash-up",
                flash === "down" && "flash-down"
              )}
            >
              {ticker ? fmtPrice(ticker.last) : fmtPrice(metrics.mid)}
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            <Stat label="تغير 24س" value={ticker ? fmtPct(ticker.changePct) : "—"} tone={up ? "bull" : "bear"} />
            <Stat label="أعلى 24س" value={ticker ? fmtPrice(ticker.high) : "—"} />
            <Stat label="أدنى 24س" value={ticker ? fmtPrice(ticker.low) : "—"} />
            <Stat label="حجم 24س" value={ticker ? fmtUsd(ticker.quoteVolume) : "—"} />
          </div>
        </div>
      </div>

      {blocked ? (
        <>
          <div className="rounded-xl border border-bear/40 bg-bear/10 text-bear text-sm p-3 flex items-start gap-2">
            <AlertTriangle className="size-4 mt-0.5" />
            <div>
              <div className="font-semibold">حُجبت النتائج بناءً على اتجاه جودة البيانات</div>
              <div className="mono text-[11px] opacity-90 mt-0.5">{blockDecision.reason}</div>
            </div>
          </div>
          <QualityBlockNotice symbol={symbol} />
        </>
      ) : (
        <>
          {/* Institutional verdict — hero */}
          {verdict && <InstitutionalPanel verdict={verdict} />}

          {/* Chart + Order book */}
          <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-5">
            <Panel
              icon={<LineChart className="size-4 text-primary" />}
              title={`الرسم البياني + الجدران + مناطق السيولة · ${interval.toUpperCase()}`}
              extra={
                <div className="flex gap-1">
                  {TIMEFRAMES.map((tf) => (
                    <button
                      key={tf.value}
                      onClick={() => onInterval(tf.value)}
                      className={cn(
                        "text-[11px] px-2.5 py-1 rounded-md mono font-semibold border",
                        interval === tf.value
                          ? "bg-primary text-primary-foreground border-primary"
                          : "border-border text-muted-foreground hover:text-foreground hover:border-accent"
                      )}
                    >
                      {tf.label}
                    </button>
                  ))}
                </div>
              }
            >
              <div ref={chartContainerRef} id="whaleeye-chart">
                {klines && walls ? (
                  <CandleChart klines={klines} walls={walls} zones={zones} mid={metrics.mid} />
                ) : (
                  <div className="h-64 flex items-center justify-center text-muted-foreground text-sm">
                    يحمل بيانات الشموع...
                  </div>
                )}
              </div>
            </Panel>

            <Panel
              icon={<BookOpen className="size-4 text-primary" />}
              title="دفتر الأوامر الحي"
              extra={<span className="text-[10px] mono text-muted-foreground">عمق 20 / تحديث 100ms</span>}
            >
              <OrderBookHeatmap book={book} metrics={metrics} rows={14} />
            </Panel>
          </div>

          {/* Book metrics strip */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <MetricCard label="اختلال الدفتر" value={`${(metrics.imbalance * 100).toFixed(1)}%`} tone={metrics.imbalance > 0 ? "bull" : "bear"} />
            <MetricCard label="ضغط شراء" value={fmtUsd(metrics.bidUsd)} tone="bull" />
            <MetricCard label="ضغط بيع" value={fmtUsd(metrics.askUsd)} tone="bear" />
            <MetricCard label="السعر الميكروي" value={fmtPrice(metrics.microPrice)} />
            <MetricCard label="VWAP شراء" value={fmtPrice(metrics.vwapBid)} tone="bull" />
            <MetricCard label="VWAP بيع" value={fmtPrice(metrics.vwapAsk)} tone="bear" />
          </div>

         {/* CVD — Cumulative Volume Delta */}
                    <Panel
                      icon={<Activity className="size-4 text-primary" />}
                      title="مؤشر CVD — دلتا حجم التداول التراكمي"
                      extra={
                        <div className="flex items-center gap-2">
                          {cvdStats.divergence && (
                            <span className="text-[10px] mono px-2 py-0.5 rounded-full border border-gold/40 text-gold bg-gold/10">
                              ⚠ تباين
                            </span>
                          )}
                          <span className={cn(
                            "text-[10px] mono px-2 py-0.5 rounded-full border",
                            cvdStats.trend === "bullish" ? "border-bull/40 text-bull bg-bull/10"
                            : cvdStats.trend === "bearish" ? "border-bear/40 text-bear bg-bear/10"
                            : "border-border text-muted-foreground"
                          )}>
                            {cvdStats.trend === "bullish" ? "↑ شرائي"
                             : cvdStats.trend === "bearish" ? "↓ بيعي"
                             : "محايد"}
                          </span>
                          <span className="text-[10px] mono text-muted-foreground">من دفتر الأوامر</span>
                        </div>
                      }
                    >
                      <CVDPanel cvdStats={cvdStats} mid={rawMid} />
                    </Panel>

                    {/* OFI — Order Flow Imbalance Heatmap */}
                    <Panel
                      minH="min-h-[420px]"
                      icon={<GitCompare className="size-4 text-primary" />}
                      title="OFI — خريطة حرارة تدفق الأوامر"
                      extra={
                        <div className="flex items-center gap-2">
                          <span className={cn(
                            "text-[10px] mono px-2 py-0.5 rounded-full border",
                            ofiStats.pressure === "buy"  ? "border-bull/40 text-bull bg-bull/10"
                            : ofiStats.pressure === "sell" ? "border-bear/40 text-bear bg-bear/10"
                            : "border-border text-muted-foreground"
                          )}>
                            {ofiStats.pressure === "buy" ? "↑ ضغط شراء"
                             : ofiStats.pressure === "sell" ? "↓ ضغط بيع"
                             : "محايد"}
                          </span>
                          <span className="text-[10px] mono text-muted-foreground">
                            {ofiStats.history.length} تيكر
                          </span>
                        </div>
                      }
                    >
                      <OFIHeatmap ofi={ofiStats} mid={rawMid} />
                    </Panel>

                    {/* SMC — Smart Money Concepts */}
                    {smcAnalysis && (
                      <Panel
                        minH="min-h-[300px]"
                        icon={<GitCompare className="size-4 text-gold" />}
                        title="SMC — بصمات الأموال الذكية"
                        extra={
                          <div className="flex items-center gap-2">
                            <span className={cn(
                              "text-[10px] mono px-2 py-0.5 rounded-full border",
                              smcAnalysis.trend === "up"   ? "border-bull/40 text-bull bg-bull/10"
                              : smcAnalysis.trend === "down" ? "border-bear/40 text-bear bg-bear/10"
                              : "border-border text-muted-foreground"
                            )}>
                              {smcAnalysis.trend === "up" ? "↑ هيكل صاعد"
                               : smcAnalysis.trend === "down" ? "↓ هيكل هابط"
                               : "متذبذب"}
                            </span>
                            <span className="text-[10px] mono text-muted-foreground">
                              BOS · CHOCH · FVG · OB · {interval}
                            </span>
                          </div>
                        }
                      >
                        <SMCPanel
                          analysis={smcAnalysis}
                          currentPrice={metrics?.mid ?? rawMid}
                          interval={interval}
                        />
                      </Panel>
                    )}

                    {/* Walls + Liquidity */}
                    <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">

                      <div id="walls-panel" className="scroll-mt-24">
                        <Panel
                          icon={<Crosshair className="size-4 text-primary" />}
                          title="الجدران السعرية (دعوم ومقاومات)"
                          extra={
                            <span className="text-[10px] mono text-muted-foreground">
                              {walls?.used.method === "zscore" && `z ≥ ${walls.used.zThreshold}`}
                              {walls?.used.method === "percentile" && `p${walls.used.percentile}`}
                              {walls?.used.method === "absolute" && `≥ ${fmtUsd(walls.used.absoluteUsd)}`}
                              {` · عمق ${walls?.used.depth} · cutoff ${fmtUsd(walls?.used.cutoffUsd ?? 0)}`}
                            </span>
                          }
                        >
                          {walls ? <WallsPanel report={walls} mid={metrics.mid} /> : null}
                        </Panel>
                      </div>

                      <div id="zones-panel" className="scroll-mt-24">
                        <Panel
                          icon={<Crosshair className="size-4 text-gold" />}
                          title="مناطق صيد الستوبات (السيولة)"
                          extra={
                            <span className="text-[10px] mono text-muted-foreground">
                              قمم/قيعان متساوية · احتمال مُعاير بالحجم · {interval}
                            </span>
                          }
                        >
                          <LiquidityZonesPanel zones={zones} mid={metrics.mid} />
                        </Panel>
                      </div>
                    </div>

                    {/* Developer signature */}
                    <div className="mt-6 rounded-2xl border border-border/50 bg-card/20 px-6 py-5 flex flex-col sm:flex-row items-center justify-between gap-4">
                      <div className="flex items-center gap-4">
                        <div className="size-12 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center font-black text-primary text-xl select-none">
                          م
                        </div>
                        <div>
                          <div className="font-bold text-base">Marwan Negm</div>
                          <div className="text-[12px] text-muted-foreground mt-0.5">مطوّر منصة عين الحوت · WhaleEye</div>
                          <div className="text-[11px] mono text-muted-foreground/60 mt-0.5">Institutional Order-Flow Engine · Binance Live</div>
                        </div>
                      </div>
                      <div className="flex flex-col items-end gap-1.5 text-[10px] text-muted-foreground mono select-none">
                        <div className="flex items-center gap-1.5">
                          <span className="size-1.5 rounded-full bg-bull animate-pulse" />
                          <span>بيانات مباشرة · Binance WebSocket</span>
                        </div>
                        <div className="flex items-center gap-2 gap-y-1 flex-wrap justify-end">
                          {["RL Agent", "CVD", "OFI", "SMC", "Liquidity Zones", "Backtest"].map(tag => (
                            <span key={tag} className="px-2 py-0.5 rounded-full bg-primary/8 border border-primary/15 text-primary/70 text-[9px] uppercase tracking-wider">
                              {tag}
                            </span>
                          ))}
                        </div>
                        <div className="text-[9px] opacity-50 mt-0.5">v3.0 · {new Date().getFullYear()}</div>
                      </div>
                    </div>

                  </>
                )}
              </div>
            );
          }

          function Stat({ label, value, tone }: { label: string; value: string; tone?: "bull" | "bear" }) {
            return (
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
                <div className={cn("mono font-bold text-base", tone === "bull" && "text-bull", tone === "bear" && "text-bear")}>
                  {value}
                </div>
              </div>
            );
          }

          function MetricCard({ label, value, tone }: { label: string; value: string; tone?: "bull" | "bear" }) {
            return (
              <div className="rounded-xl border border-border bg-card/50 p-3">
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
                <div className={cn("mt-1 mono font-bold text-base", tone === "bull" && "text-bull", tone === "bear" && "text-bear")}>
                  {value}
                </div>
              </div>
            );
          }

          function Panel({
            icon, title, extra, children, minH,
          }: { icon?: React.ReactNode; title: string; extra?: React.ReactNode; children: React.ReactNode; minH?: string }) {
            return (
              <section className="rounded-2xl border border-border bg-card/40 overflow-hidden">
                <header className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-card/60 gap-2 flex-wrap">
                  <div className="flex items-center gap-2 font-semibold text-sm">{icon}{title}</div>
                  {extra}
                </header>
                <div className={cn("p-3", minH)} style={minH ? undefined : undefined}>{children}</div>
              </section>
            );
          }

          function LoadingSkeleton({ symbol }: { symbol: string }) {
            return (
              <div className="rounded-2xl border border-border bg-card/40 p-8 text-center">
                <div className="size-12 rounded-full bg-primary/20 mx-auto mb-4 animate-pulse" />
                <div className="font-bold text-lg">جاري الاتصال بـ Binance...</div>
                <div className="text-sm text-muted-foreground mt-1">تحميل دفتر أوامر {symbol}</div>
              </div>
            );
          }